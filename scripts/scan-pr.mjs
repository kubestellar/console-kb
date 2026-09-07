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
  log.summary('mission-scan-summary', { filesScanned: 0, readErrors: 0, schemaInvalid: 0, maliciousFindings: 0, isFullScan, hasFailures: false });
  process.exit(0);
}

let hasFailures = false;
let readErrors = 0;
let schemaInvalid = 0;
let maliciousFindings = 0;
const sections = ['## 🔍 Mission Scan Results\n'];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    sections.push(`### 📄 \`${file}\`\n\n❌ **Error:** Could not read file: ${err.message}\n`);
    hasFailures = true;
    readErrors += 1;
    continue;
  }

  const result = scanMissionFile(content);
  sections.push(formatScanResultAsMarkdown(file, result));

  if (result.error) {
    hasFailures = true;
    readErrors += 1;
  } else {
    if (!result.schema.valid) {
      hasFailures = true;
      schemaInvalid += 1;
    }
    // Malicious content check only applies to PR scans (new/changed files).
    // Full scans (--all) on push/schedule/dispatch skip this check to avoid
    // false positives on legitimate installation commands (curl|bash, awk patterns, etc.)
    // in existing missions that have already been reviewed.
    if (result.scan.malicious.findings.length > 0) {
      maliciousFindings += result.scan.malicious.findings.length;
      if (!isFullScan) hasFailures = true;
    }
  }
}

const report = sections.join('\n\n');
writeFileSync('scan-results.md', report, 'utf8');
console.log(report);

// Bounded, per-run CI-observability summary (one JSON line on stdout) so
// pipeline tooling can track mission-scan health mechanically without
// scraping the markdown report. Counts only — no file contents, mission
// text, or finding details, keeping cardinality and payload size fixed.
log.summary('mission-scan-summary', {
  filesScanned: files.length,
  readErrors,
  schemaInvalid,
  maliciousFindings,
  isFullScan,
  hasFailures,
});

if (hasFailures) {
  console.error('\n❌ Scan completed with failures.');
  process.exit(1);
} else {
  console.log('\n✅ All missions passed scanning.');
  process.exit(0);
}
