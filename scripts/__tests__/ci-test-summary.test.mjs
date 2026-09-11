import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary, buildStepSummaryMarkdown } from '../lib/ci-test-summary.mjs';

describe('buildSummary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports pass status with bounded counts when all tests pass', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_500);

    const report = {
      numTotalTests: 10,
      numPassedTests: 10,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      startTime: 1_000_000,
    };

    expect(buildSummary(report, 0)).toEqual({
      status: 'pass',
      total_tests: 10,
      passed_tests: 10,
      failed_tests: 0,
      skipped_tests: 0,
      duration_ms: 500,
      exit_code: 0,
    });
  });

  it('reports fail status when the report has failed tests, even with exit code 0', () => {
    const report = {
      numTotalTests: 5,
      numPassedTests: 4,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      startTime: Date.now(),
    };

    expect(buildSummary(report, 0).status).toBe('fail');
  });

  it('reports fail status on a non-zero exit code even if the report looks clean', () => {
    const report = {
      numTotalTests: 5,
      numPassedTests: 5,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      startTime: Date.now(),
    };

    expect(buildSummary(report, 1).status).toBe('fail');
  });

  it('sums pending and todo tests into skipped_tests', () => {
    const report = {
      numTotalTests: 8,
      numPassedTests: 5,
      numFailedTests: 0,
      numPendingTests: 2,
      numTodoTests: 1,
      startTime: Date.now(),
    };

    expect(buildSummary(report, 0).skipped_tests).toBe(3);
  });

  it('falls back to all-zero counts when the report is null (e.g. vitest crashed)', () => {
    expect(buildSummary(null, 1)).toEqual({
      status: 'fail',
      total_tests: 0,
      passed_tests: 0,
      failed_tests: 0,
      skipped_tests: 0,
      duration_ms: 0,
      exit_code: 1,
    });
  });

  it('never returns a negative duration', () => {
    const report = { numTotalTests: 1, numPassedTests: 1, startTime: Date.now() + 10_000 };
    expect(buildSummary(report, 0).duration_ms).toBe(0);
  });
});

describe('buildStepSummaryMarkdown', () => {
  it('renders a bounded, fixed-shape markdown table', () => {
    const summary = {
      status: 'pass',
      total_tests: 3,
      passed_tests: 3,
      failed_tests: 0,
      skipped_tests: 0,
      duration_ms: 42,
      exit_code: 0,
    };

    const markdown = buildStepSummaryMarkdown(summary);

    expect(markdown).toContain('### scripts/ Test Summary');
    expect(markdown).toContain('| Status | pass |');
    expect(markdown).toContain('| Total tests | 3 |');
    expect(markdown).toContain('| Duration (ms) | 42 |');
  });

  it('reflects a failing summary', () => {
    const summary = {
      status: 'fail',
      total_tests: 3,
      passed_tests: 2,
      failed_tests: 1,
      skipped_tests: 0,
      duration_ms: 10,
      exit_code: 1,
    };

    expect(buildStepSummaryMarkdown(summary)).toContain('| Status | fail |');
    expect(buildStepSummaryMarkdown(summary)).toContain('| Failed | 1 |');
  });
});

describe('GITHUB_STEP_SUMMARY integration (file-level, not vitest-in-vitest)', () => {
  it('appendFileSync writes the rendered markdown to the target file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'step-summary-'));
    const summaryPath = join(dir, 'step-summary.md');

    try {
      const summary = buildSummary(
        { numTotalTests: 2, numPassedTests: 2, startTime: Date.now() },
        0,
      );
      const markdown = buildStepSummaryMarkdown(summary);

      // Mirrors what ci-test-summary.mjs's writeStepSummary() does when
      // GITHUB_STEP_SUMMARY is set, without re-spawning vitest.
      writeFileSync(summaryPath, '');
      appendFileSync(summaryPath, markdown);

      const written = readFileSync(summaryPath, 'utf-8');
      expect(written).toContain('### scripts/ Test Summary');
      expect(written).toContain('| Total tests | 2 |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
