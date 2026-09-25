/**
 * scan-pr-runcli.test.mjs
 *
 * Covers the CLI entry point of `scripts/scan-pr.mjs` in-process. The
 * pure `runScan` helper is exercised elsewhere; this file drives
 * `runCli` so the argv parsing (`--all` vs. changed-files list), the
 * `discoverFiles` fallback, the `scan-results.md` write, the
 * `$GITHUB_STEP_SUMMARY` mirror, the `mission-scan-summary` structured
 * event, and the success/failure exit-code mapping are actually
 * attributed by v8 (subprocess tests would not be — see console-kb#3398
 * for the wider pattern, and PR #3399 for the sibling
 * `fuzz-mission-scanner` rollout).
 */
import { describe, it, expect } from 'vitest';

import { runCli } from '../scan-pr.mjs';

function makeSink() {
  const lines = [];
  return { lines, fn: (...args) => lines.push(args.map(String).join(' ')) };
}

// Fixed clock: consumes values in order and pins to the last one after exhaustion.
function makeClock(values) {
  let i = 0;
  return () => values[i++] ?? values[values.length - 1];
}

function makeWriter() {
  const writes = [];
  return { writes, fn: (path, data /*, enc */) => writes.push({ path, data }) };
}

// Capture logger.summary() lines, which are written directly to
// process.stdout.write. Returns { restore, captured }.
function captureStdoutWrite() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  return {
    captured,
    restore: () => { process.stdout.write = originalWrite; },
  };
}

function parseSummaries(captured, event) {
  return captured
    .flatMap(line => line.split('\n'))
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(obj => obj && obj.event === event);
}

describe('scan-pr runCli', () => {
  it('returns 0 and emits an empty-batch summary when no changed files are provided', () => {
    const out = makeSink();
    const err = makeSink();
    const writer = makeWriter();
    const appender = makeWriter();

    const { captured, restore } = captureStdoutWrite();
    let code;
    try {
      code = runCli({
        argv: [],
        env: {},
        stdout: out.fn,
        stderr: err.fn,
        clock: makeClock([1000, 1005]),
        writeFile: writer.fn,
        appendFile: appender.fn,
        discoverFiles: () => { throw new Error('discoverFiles should not be called without --all'); },
      });
    } finally {
      restore();
    }

    expect(code).toBe(0);
    expect(out.lines).toContain('No mission files to scan.');
    expect(err.lines).toEqual([]);
    // The empty-batch path MUST NOT write scan-results.md.
    expect(writer.writes).toEqual([]);
    // And it MUST NOT touch $GITHUB_STEP_SUMMARY.
    expect(appender.writes).toEqual([]);

    const summaries = parseSummaries(captured, 'mission-scan-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      event: 'mission-scan-summary',
      level: 'info',
      trigger: 'changed-files',
      total: 0,
      scannedCount: 0,
      failedCount: 0,
      durationMs: 5,
    });
  });

  it('returns 1, writes scan-results.md, and marks the summary "error" when a file cannot be read', () => {
    const out = makeSink();
    const err = makeSink();
    const writer = makeWriter();
    const appender = makeWriter();

    const { captured, restore } = captureStdoutWrite();
    let code;
    try {
      code = runCli({
        // A path that definitely does not exist — runScan will hit the
        // readFileSync catch arm and count the file as a failure.
        argv: ['/nonexistent/path/does-not-exist.json'],
        env: { GITHUB_STEP_SUMMARY: '/tmp/step-summary-scan-pr-runcli.md' },
        stdout: out.fn,
        stderr: err.fn,
        clock: makeClock([2000, 2050]),
        writeFile: writer.fn,
        appendFile: appender.fn,
      });
    } finally {
      restore();
    }

    expect(code).toBe(1);
    // Exactly one scan-results.md write with the rendered report.
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0].path).toBe('scan-results.md');
    expect(writer.writes[0].data).toMatch(/## 🔍 Mission Scan Results/);
    expect(writer.writes[0].data).toMatch(/Could not read file/);
    // And the report is mirrored into $GITHUB_STEP_SUMMARY exactly once.
    expect(appender.writes).toHaveLength(1);
    expect(appender.writes[0].path).toBe('/tmp/step-summary-scan-pr-runcli.md');
    expect(appender.writes[0].data).toMatch(/## 🔍 Mission Scan Results/);
    // The failure banner MUST go to stderr, not the success banner.
    expect(err.lines.some(l => l.includes('❌ Scan completed with failures.'))).toBe(true);
    expect(out.lines.some(l => l.includes('✅ All missions passed scanning.'))).toBe(false);

    const summaries = parseSummaries(captured, 'mission-scan-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      event: 'mission-scan-summary',
      level: 'error',
      trigger: 'changed-files',
      total: 1,
      scannedCount: 1,
      failedCount: 1,
      durationMs: 50,
    });
  });

  it('uses discoverFiles and reports trigger="all" when --all is passed, and skips the step-summary mirror when GITHUB_STEP_SUMMARY is unset', () => {
    const out = makeSink();
    const err = makeSink();
    const writer = makeWriter();
    const appender = makeWriter();

    const discoverArgs = [];
    const discoverFiles = (dir) => {
      discoverArgs.push(dir);
      // Return an empty discovery so we exit via the "No mission files"
      // path — that keeps the assertion surface tight without needing
      // a real fixture tree, and still proves the --all branch drives
      // discovery across every mission root.
      return [];
    };

    const { captured, restore } = captureStdoutWrite();
    let code;
    try {
      code = runCli({
        argv: ['--all'],
        env: {}, // GITHUB_STEP_SUMMARY intentionally unset
        stdout: out.fn,
        stderr: err.fn,
        clock: makeClock([3000, 3100]),
        writeFile: writer.fn,
        appendFile: appender.fn,
        discoverFiles,
      });
    } finally {
      restore();
    }

    expect(code).toBe(0);
    expect(discoverArgs).toEqual(['fixes', 'runbooks']);
    expect(out.lines.some(l => l.includes('Discovered 0 mission files to scan.'))).toBe(true);
    expect(out.lines).toContain('No mission files to scan.');
    // No scan-results write on the empty-batch path.
    expect(writer.writes).toEqual([]);
    // And step-summary mirror is skipped when GITHUB_STEP_SUMMARY is unset.
    expect(appender.writes).toEqual([]);

    const summaries = parseSummaries(captured, 'mission-scan-summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      event: 'mission-scan-summary',
      level: 'info',
      trigger: 'all',
      total: 0,
      scannedCount: 0,
      failedCount: 0,
      durationMs: 100,
    });
  });
});
