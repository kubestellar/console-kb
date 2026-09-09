// Vitest configuration for scripts/.
//
// Coverage thresholds lock in the current baseline (verified locally against
// main at commit-of-record) so that a future PR which adds an untested code
// path OR deletes a test can't silently regress overall coverage.
//
// Filed as recommendation #4 of #3174. Values are the measured floor rounded
// DOWN by ~1pp to leave a small refactor buffer; ratchet upward as the CLI
// generators (generate-platform-missions, enrich-install-missions,
// generate-cncf-{install-,}missions, mission-executor) gain LLM-mocked tests.
export default {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      // Baseline measured 2026-09-03 on main:
      //   statements 57.82% | branches 61.45% | functions 64.51% | lines 57.62%
      // Thresholds set ~1pp below to tolerate incidental refactor churn while
      // still catching genuine regressions.
      thresholds: {
        statements: 57,
        branches: 61,
        functions: 64,
        lines: 57,
      },
    },
  },
}
