import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildVitestArgs,
  readReport,
  writeStepSummary,
  coverageEnabled,
} from '../ci-test-summary.mjs';

// Sanity check: the seam pattern (see scripts/validate-schema.mjs's
// runValidation) means these helpers are unit-testable in-process,
// which the wrapper script's 30% coverage (issue #3533) required.

const scratchDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-test-summary-helpers-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('buildVitestArgs', () => {
  it('emits the base --reporter/--outputFile.json args without --coverage when coverage is off', () => {
    const dir = scratch();
    const reportPath = join(dir, 'vitest-report.json');
    const args = buildVitestArgs(reportPath, { GITHUB_ACTIONS: 'false' });

    expect(args).toContain('run');
    expect(args).toContain('--reporter=default');
    expect(args).toContain('--reporter=json');
    expect(args).toContain(`--outputFile.json=${reportPath}`);
    expect(args).not.toContain('--coverage');
  });

  it('adds --coverage when GITHUB_ACTIONS=true (CI default)', () => {
    const args = buildVitestArgs('/tmp/report.json', { GITHUB_ACTIONS: 'true' });
    expect(args).toContain('--coverage');
  });

  it('honors CI_COVERAGE=1 override even outside GitHub Actions', () => {
    const args = buildVitestArgs('/tmp/report.json', { CI_COVERAGE: '1' });
    expect(args).toContain('--coverage');
  });

  it('honors CI_COVERAGE=0 override even inside GitHub Actions', () => {
    const args = buildVitestArgs('/tmp/report.json', {
      CI_COVERAGE: '0',
      GITHUB_ACTIONS: 'true',
    });
    expect(args).not.toContain('--coverage');
  });

  it('mirrors coverageEnabled(env) exactly on the --coverage decision', () => {
    for (const env of [
      { GITHUB_ACTIONS: 'true' },
      { GITHUB_ACTIONS: 'false' },
      { CI_COVERAGE: '1' },
      { CI_COVERAGE: 'true' },
      { CI_COVERAGE: '0' },
      { CI_COVERAGE: 'false' },
      {},
    ]) {
      const args = buildVitestArgs('/tmp/x.json', env);
      expect(args.includes('--coverage')).toBe(coverageEnabled(env));
    }
  });
});

describe('readReport', () => {
  it('returns the parsed JSON and deletes the report file on success', () => {
    const dir = scratch();
    const reportPath = join(dir, 'vitest-report.json');
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 3 }));

    expect(readReport(reportPath)).toEqual({ numTotalTests: 3 });
    expect(existsSync(reportPath)).toBe(false);
  });

  it('returns null when the report file is missing', () => {
    const dir = scratch();
    const reportPath = join(dir, 'nope.json');
    expect(readReport(reportPath)).toBeNull();
  });

  it('returns null on malformed JSON and still deletes the file', () => {
    const dir = scratch();
    const reportPath = join(dir, 'bad.json');
    writeFileSync(reportPath, 'not-json{{');

    expect(readReport(reportPath)).toBeNull();
    expect(existsSync(reportPath)).toBe(false);
  });
});

describe('writeStepSummary', () => {
  const passSummary = {
    status: 'pass',
    total_tests: 1,
    passed_tests: 1,
    failed_tests: 0,
    skipped_tests: 0,
    duration_ms: 5,
    exit_code: 0,
  };

  it('is a no-op when GITHUB_STEP_SUMMARY is unset', () => {
    // Should not throw and should not write anywhere reachable.
    expect(() => writeStepSummary(passSummary, {})).not.toThrow();
  });

  it('appends the rendered markdown block when GITHUB_STEP_SUMMARY points at a file', () => {
    const dir = scratch();
    const summaryFile = join(dir, 'step-summary.md');
    writeFileSync(summaryFile, '# existing\n');

    writeStepSummary(passSummary, { GITHUB_STEP_SUMMARY: summaryFile });

    const content = readFileSync(summaryFile, 'utf-8');
    expect(content.startsWith('# existing\n')).toBe(true);
    // buildStepSummaryMarkdown(summary) renders a Scripts test summary
    // block; assert the block was appended without hard-coding its exact
    // shape (which lives in lib/ci-test-summary.mjs).
    expect(content.length).toBeGreaterThan('# existing\n'.length);
    expect(content).toMatch(/pass|fail/i);
  });

  it('appends (not overwrites) on repeated calls', () => {
    const dir = scratch();
    const summaryFile = join(dir, 'step-summary.md');
    writeFileSync(summaryFile, '');

    writeStepSummary(passSummary, { GITHUB_STEP_SUMMARY: summaryFile });
    const afterFirst = readFileSync(summaryFile, 'utf-8').length;
    writeStepSummary(passSummary, { GITHUB_STEP_SUMMARY: summaryFile });
    const afterSecond = readFileSync(summaryFile, 'utf-8').length;

    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});
