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

/**
 * Scans `files` and returns a result summary plus the rendered markdown
 * report. Exported for unit testing; does not call process.exit or write
 * scan-results.md itself.
 */
export function runScan(files, { isFullScan } = {}) {
  let hasFailures = false;
  let scannedCount = 0;
  let failedCount = 0;
  const sections = ['## 🔍 Mission Scan Results\n'];

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      sections.push(`### 📄 \`${file}\`\n\n❌ **Error:** Could not read file: ${err.message}\n`);
      hasFailures = true;
      scannedCount++;
      failedCount++;
      continue;
    }

    const result = scanMissionFile(content);
    sections.push(formatScanResultAsMarkdown(file, result));
    scannedCount++;

    let fileFailed = false;
    if (result.error) {
      fileFailed = true;
    } else {
      if (!result.schema.valid) fileFailed = true;
      // Malicious content check only applies to PR scans (new/changed files).
      // Full scans (--all) on push/schedule/dispatch skip this check to avoid
      // false positives on legitimate installation commands (curl|bash, awk patterns, etc.)
      // in existing missions that have already been reviewed.
      if (!isFullScan && result.scan.malicious.findings.length > 0) {
        fileFailed = true;
      }
    }

    if (fileFailed) {
      hasFailures = true;
      failedCount++;
    }
  }

  return { hasFailures, scannedCount, failedCount, total: files.length, report: sections.join('\n\n') };
}

function main() {
  const args = process.argv.slice(2);
  const isFullScan = args.includes('--all');
  const trigger = isFullScan ? 'all' : 'changed-files';
  const startedAt = Date.now();

  let files;
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
      level: 'info',
      trigger,
      total: 0,
      scannedCount: 0,
      failedCount: 0,
      durationMs: Date.now() - startedAt,
    });
    process.exit(0);
  }

  const { hasFailures, scannedCount, failedCount, total, report } = runScan(files, { isFullScan });
  const durationMs = Date.now() - startedAt;

  writeFileSync('scan-results.md', report, 'utf8');
  console.log(report);

  log.summary('mission-scan-summary', {
    level: hasFailures ? 'error' : 'info',
    trigger,
    total,
    scannedCount,
    failedCount,
    durationMs,
  });

  if (hasFailures) {
    console.error('\n❌ Scan completed with failures.');
    process.exit(1);
  } else {
    console.log('\n✅ All missions passed scanning.');
    process.exit(0);
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('scan-pr.mjs')) {
  main();
}
