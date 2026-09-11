/**
 * Pure helpers for turning a vitest JSON-reporter report into a bounded
 * CI-observability summary.
 *
 * Extracted from `ci-test-summary.mjs` (the CLI entry point that actually
 * spawns vitest) so the summary-building and step-summary-formatting logic
 * can be unit tested directly, without re-running vitest inside vitest.
 * All fields here are bounded counts/durations sourced from vitest's own
 * JSON reporter output (`numTotalTests`, `numPassedTests`, etc.) — never
 * from unbounded user input.
 */

/**
 * Builds the bounded summary record for one test run.
 * @param {object|null} report - parsed vitest JSON reporter output, or
 *   null if the report file could not be read (e.g. vitest crashed before
 *   writing it).
 * @param {number} exitCode - vitest's process exit code.
 * @returns {{status: 'pass'|'fail', total_tests: number, passed_tests: number,
 *   failed_tests: number, skipped_tests: number, duration_ms: number,
 *   exit_code: number}}
 */
export function buildSummary(report, exitCode) {
  const total = report?.numTotalTests ?? 0;
  const passed = report?.numPassedTests ?? 0;
  const failed = report?.numFailedTests ?? 0;
  const skipped = (report?.numPendingTests ?? 0) + (report?.numTodoTests ?? 0);
  const durationMs = report?.startTime ? Date.now() - report.startTime : 0;
  const status = exitCode === 0 && failed === 0 ? 'pass' : 'fail';

  return {
    status,
    total_tests: total,
    passed_tests: passed,
    failed_tests: failed,
    skipped_tests: skipped,
    duration_ms: Math.max(0, Math.round(durationMs)),
    exit_code: exitCode,
  };
}

/**
 * Renders a summary record as a `$GITHUB_STEP_SUMMARY`-ready markdown
 * fragment (a bounded, fixed-shape table — no unbounded per-test rows).
 * @param {ReturnType<typeof buildSummary>} summary
 * @returns {string}
 */
export function buildStepSummaryMarkdown(summary) {
  return [
    '### scripts/ Test Summary',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Status | ${summary.status} |`,
    `| Total tests | ${summary.total_tests} |`,
    `| Passed | ${summary.passed_tests} |`,
    `| Failed | ${summary.failed_tests} |`,
    `| Skipped/todo | ${summary.skipped_tests} |`,
    `| Duration (ms) | ${summary.duration_ms} |`,
    '',
  ].join('\n');
}
