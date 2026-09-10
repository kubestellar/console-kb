#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { scanMissionFile, formatScanResultAsMarkdown } from './scanner.mjs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('scan-pr');

/** Valid mission file extensions */
const MISSION_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);

/** Files to skip when discovering all missions */
const SKIP_FILENAMES = new Set(['index.json']);

/**
 * Recursively discovers all mission files under the given directory.
 * Returns an array of relative file paths.
 */
function discoverMissionFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverMissionFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = entry.name.substring(entry.name.lastIndexOf('.'));
      if (MISSION_EXTENSIONS.has(ext) && !SKIP_FILENAMES.has(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

const args = process.argv.slice(2);

let files;
const isFullScan = args.includes('--all');
if (isFullScan) {
  // Discover all mission files under fixes/ (used for push/schedule/dispatch)
  files = discoverMissionFiles('fixes');
  console.log(`Discovered ${files.length} mission files to scan.\n`);
} else {
  files = args.flatMap(a => a.split(/\s+/)).filter(Boolean);
}

if (files.length === 0) {
  console.log('No mission files to scan.');
  log.summary('mission-scan-summary', {
    trigger: isFullScan ? 'all' : 'changed-files',
    total: 0,
    readErrors: 0,
    parseErrors: 0,
    schemaInvalid: 0,
    maliciousFindings: 0,
    sensitiveFindings: 0,
    hasFailures: false,
  });
  process.exit(0);
}

let hasFailures = false;
const sections = ['## 🔍 Mission Scan Results\n'];

// Bounded counters for the end-of-run structured summary (fixed set of
// known outcome categories — never per-file — so cardinality stays
// constant regardless of how many mission files are scanned).
let readErrorCount = 0;
let parseErrorCount = 0;
let schemaInvalidCount = 0;
let maliciousFindingCount = 0;
let sensitiveFindingCount = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    sections.push(`### 📄 \`${file}\`\n\n❌ **Error:** Could not read file: ${err.message}\n`);
    hasFailures = true;
    readErrorCount++;
    continue;
  }

  const result = scanMissionFile(content);
  sections.push(formatScanResultAsMarkdown(file, result));

  if (result.error) {
    hasFailures = true;
    parseErrorCount++;
  } else {
    if (!result.schema.valid) {
      hasFailures = true;
      schemaInvalidCount++;
    }
    sensitiveFindingCount += result.scan.sensitive.findings.length;
    // Malicious content check only applies to PR scans (new/changed files).
    // Full scans (--all) on push/schedule/dispatch skip this check to avoid
    // false positives on legitimate installation commands (curl|bash, awk patterns, etc.)
    // in existing missions that have already been reviewed.
    if (!isFullScan && result.scan.malicious.findings.length > 0) {
      hasFailures = true;
      maliciousFindingCount += result.scan.malicious.findings.length;
    }
  }
}

const report = sections.join('\n\n');
writeFileSync('scan-results.md', report, 'utf8');
console.log(report);

log.summary('mission-scan-summary', {
  trigger: isFullScan ? 'all' : 'changed-files',
  total: files.length,
  readErrors: readErrorCount,
  parseErrors: parseErrorCount,
  schemaInvalid: schemaInvalidCount,
  maliciousFindings: maliciousFindingCount,
  sensitiveFindings: sensitiveFindingCount,
  hasFailures,
});

if (hasFailures) {
  console.error('\n❌ Scan completed with failures.');
  process.exit(1);
} else {
  console.log('\n✅ All missions passed scanning.');
  process.exit(0);
}
