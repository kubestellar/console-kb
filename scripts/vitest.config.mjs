/**
 * Vitest configuration for console-kb scripts/.
 *
 * Enables coverage reporting via the @vitest/coverage-v8 provider that is
 * already declared in scripts/package.json devDependencies. Without a
 * config, `vitest run` measures nothing even when the coverage package is
 * installed, so PRs cannot see line/branch/function coverage.
 *
 * Thresholds are intentionally set at the current baseline observed on
 * master (lines 44.94, statements 45.26, functions 50, branches 51.23)
 * and are meant to act as a ratchet floor — raise them as coverage
 * improves, do not lower them.
 *
 * The three excluded catalog files are pure data exports (arrays of
 * projects/platforms with no branching logic); testing them would only
 * assert that constants equal themselves.
 */

export default {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      include: ['*.mjs', 'lib/**/*.mjs'],
      exclude: [
        '__tests__/**',
        '**/*.test.*',
        'vitest.config.mjs',
        // Pure data catalogs (no logic, only exported constants):
        'cncf-projects.mjs',
        'k8s-platforms.mjs',
        'other-projects.mjs',
      ],
      // Ratchet floor set just under the current baseline observed on
      // master (lines 44.94, statements 45.26, functions 50, branches
      // 51.23). Raise these as coverage improves, do not lower them.
      thresholds: {
        lines: 44,
        statements: 45,
        functions: 50,
        branches: 51,
      },
    },
  },
}
