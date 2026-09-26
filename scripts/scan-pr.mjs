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
 *
 * Silently returns [] when `dir` does not exist. A --all scan enumerates
 * every configured mission root (fixes/, runbooks/), and a working tree
 * that only carries one of them (e.g. a partial checkout, a fresh clone
 * of the scripts/ subpackage, or a temp-dir test that populates only
 * fixes/) must not crash the whole scan on ENOENT of the other root.
 */
function discoverMissionFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return results;
    throw err;
  }
  for (const entry of entries) {
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

/**
 * In-process CLI entry point. Runs the scan, writes `scan-results.md`,
 * mirrors the report into `$GITHUB_STEP_SUMMARY` when set, emits the
 * `mission-scan-summary` structured line, and returns a POSIX exit
 * code (0 = clean scan, 1 = at least one failure).
 *
 * `argv`, `env`, `stdout`, `stderr`, `clock`, `writeFile`, `appendFile`,
 * and `discoverFiles` are injectable so tests can drive the CLI path
 * in-process — v8 does not attribute subprocess coverage back to the
 * parent, so an in-process drive is the only way this branch is
 * measured (see console-kb#3398).
 */
export function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = console.log,
  stderr = console.error,
  clock = Date.now,
  writeFile = writeFileSync,
  appendFile = appendFileSync,
  discoverFiles = discoverMissionFiles,
} = {}) {
  const isFullScan = argv.includes('--all');
  const trigger = isFullScan ? 'all' : 'changed-files';
  const startedAt = clock();

  let files;
  if (isFullScan) {
    // Discover all mission files under first-class mission roots (used for push/schedule/dispatch)
    files = ['fixes', 'runbooks'].flatMap(root => discoverFiles(root));
    stdout(`Discovered ${files.length} mission files to scan.\n`);
  } else {
    // Each changed file is delivered as its own argv entry (see
    // scan-missions.yml, which uses `git diff -z ... | xargs -0` / `mapfile`
    // to build "${FILES[@]}"). Do NOT re-split on whitespace here: a mission
    // file whose path contains a space or tab would otherwise be silently
    // broken into two nonexistent paths, causing the scan to no-op on it.
    files = argv.filter(Boolean);
  }

  if (files.length === 0) {
    stdout('No mission files to scan.');
    log.summary('mission-scan-summary', {
      level: 'info',
      trigger,
      total: 0,
      scannedCount: 0,
      failedCount: 0,
      durationMs: clock() - startedAt,
    });
    return 0;
  }

  const { hasFailures, scannedCount, failedCount, total, report } = runScan(files, { isFullScan });
  const durationMs = clock() - startedAt;

  writeFile('scan-results.md', report, 'utf8');
  stdout(report);

  // Surface the same report in the GitHub Actions run summary for every
  // trigger (PR, push, schedule, workflow_dispatch) — not just the PR-comment
  // path — so a scheduled/push scan regressing is visible without opening raw
  // logs. GITHUB_STEP_SUMMARY is already set by the Actions runner for every
  // job; no workflow YAML change is required to write to it.
  if (env.GITHUB_STEP_SUMMARY) {
    appendFile(env.GITHUB_STEP_SUMMARY, `${report}\n`, 'utf8');
  }

  log.summary('mission-scan-summary', {
    level: hasFailures ? 'error' : 'info',
    trigger,
    total,
    scannedCount,
    failedCount,
    durationMs,
  });

  if (hasFailures) {
    stderr('\n❌ Scan completed with failures.');
    return 1;
  }
  stdout('\n✅ All missions passed scanning.');
  return 0;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('scan-pr.mjs')) {
  process.exit(runCli());
}
