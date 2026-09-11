#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs';
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

/** Mode label used in the bounded summary line — fixed cardinality (2 values). */
const mode = isFullScan ? 'full' : 'pr';

if (files.length === 0) {
  console.log('No mission files to scan.');
  log.summary('scan-pr-summary', { mode, total: 0, passed: 0, failed: 0 });
  process.exit(0);
}

let failedCount = 0;
const sections = ['## 🔍 Mission Scan Results\n'];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    sections.push(`### 📄 \`${file}\`\n\n❌ **Error:** Could not read file: ${err.message}\n`);
    failedCount += 1;
    continue;
  }

  const result = scanMissionFile(content);
  sections.push(formatScanResultAsMarkdown(file, result));

  let fileFailed = false;
  if (result.error) {
    fileFailed = true;
  } else {
    if (!result.schema.valid) fileFailed = true;
    // Malicious content check only applies to PR scans (new/changed files).
    // Full scans (--all) on push/schedule/dispatch skip this check to avoid
    // false positives on legitimate installation commands (curl|bash, awk patterns, etc.)
    // in existing missions that have already been reviewed.
    if (!isFullScan && result.scan.malicious.findings.length > 0) fileFailed = true;
  }
  if (fileFailed) failedCount += 1;
}

const hasFailures = failedCount > 0;
const report = sections.join('\n\n');
writeFileSync('scan-results.md', report, 'utf8');
console.log(report);

// Surface the same report in the GitHub Actions run summary for every
// trigger (PR, push, schedule, workflow_dispatch) — not just the PR-comment
// path — so a scheduled/push scan regressing is visible without opening raw
// logs. GITHUB_STEP_SUMMARY is already set by the Actions runner for every
// job; no workflow YAML change is required to write to it.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`, 'utf8');
}

log.summary('scan-pr-summary', {
  mode,
  total: files.length,
  passed: files.length - failedCount,
  failed: failedCount,
});

if (hasFailures) {
  console.error('\n❌ Scan completed with failures.');
  process.exit(1);
} else {
  console.log('\n✅ All missions passed scanning.');
  process.exit(0);
}
