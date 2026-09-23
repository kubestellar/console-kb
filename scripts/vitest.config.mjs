import { defineConfig } from 'vitest/config';

// Vitest config for scripts/. Establishes:
//   - explicit test file discovery (__tests__/**/*.test.mjs)
//   - v8 coverage provider with text + lcov + json-summary reporters
//     (so CI can upload lcov + parse json-summary; developers see text)
//   - include/exclude that keeps node_modules and generated fixtures
//     out of the aggregate percentages
//   - coverage thresholds set a few points below current measured
//     values, so a real regression fails locally under
//     `npm test -- --coverage` while a small legitimate dip doesn't
//     cause churn. Ratchet upward in follow-up PRs.
//
// Refs #3299. The companion workflow change (`npm test` runs vitest
// with --coverage, and scripts-tests.yml uploads the lcov artifact)
// has already landed — see .github/workflows/scripts-tests.yml.
//
// Current measured baseline with the include/exclude below
// (2026-09-23, `npm test`):
//   Statements  79.93%
//   Branches    82.04%
//   Functions   81.61%
//   Lines       79.51%
//
// Thresholds are set a few points below each of these so a legitimate
// small dip does not fail CI, but a real regression (a suite deleted,
// a whole file un-tested, a mocked-out helper) does. Ratchet upward
// in follow-up PRs.
//
// v8 does not instrument subprocesses, so files that are exercised
// through `spawnSync` from a __tests__/ harness (e.g. validate-schema,
// scan-pr, test-kb-quality-ci, and the generate-cncf-* CLI entry
// points) will report low direct coverage even though they are
// covered end-to-end. That is a v8 limitation, not a coverage gap —
// the aggregate absorbs it and the thresholds are set with that in
// mind. Do not chase per-file 100% on those entry-point scripts.
export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: [
        '*.mjs',
        'lib/**/*.mjs',
        'sources/**/*.mjs',
        'platform/**/*.mjs',
        'scanner/**/*.mjs',
        'install-gen/**/*.mjs',
      ],
      exclude: [
        '__tests__/**',
        'node_modules/**',
        '**/*.config.*',
      ],
      thresholds: {
        lines: 76,
        statements: 76,
        functions: 78,
        branches: 79,
      },
    },
  },
});
