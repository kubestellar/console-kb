import { describe, it, expect } from 'vitest';
import { coverageEnabled } from '../ci-test-summary.mjs';

/**
 * Coverage of the coverageEnabled() decision surface added by
 * scripts/ci-test-summary.mjs — see issue #3287.
 *
 * The rule is: CI_COVERAGE override wins; otherwise on iff
 * GITHUB_ACTIONS === 'true'. That combination gives:
 *
 *   - local `npm test`             → no coverage (fast)
 *   - GitHub Actions runner        → coverage (thresholds enforced,
 *                                    lcov/json-summary artifacts emitted)
 *   - CI_COVERAGE=1 override       → coverage everywhere
 *   - CI_COVERAGE=0 override       → coverage nowhere
 *
 * Locking every arm here so a regression that flipped the rule (e.g.
 * `!== 'true'`, or dropping the override) fails fast — the workflow-
 * artifact-upload half of #3287 depends on the collector actually
 * running under GitHub Actions.
 */
describe('coverageEnabled — CI-only vitest coverage gate', () => {
  it('returns false with a clean env (local `npm test`)', () => {
    expect(coverageEnabled({})).toBe(false);
  });

  it('returns true under GitHub Actions (GITHUB_ACTIONS=true)', () => {
    expect(coverageEnabled({ GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('returns false when GITHUB_ACTIONS is something other than "true"', () => {
    // GitHub Actions only sets GITHUB_ACTIONS='true'; any other value
    // (e.g. an act-emulator shim setting '1' or 'yes') means we
    // deliberately stay off unless CI_COVERAGE is set explicitly.
    expect(coverageEnabled({ GITHUB_ACTIONS: '1' })).toBe(false);
    expect(coverageEnabled({ GITHUB_ACTIONS: 'yes' })).toBe(false);
    expect(coverageEnabled({ GITHUB_ACTIONS: 'false' })).toBe(false);
    expect(coverageEnabled({ GITHUB_ACTIONS: '' })).toBe(false);
  });

  it('CI_COVERAGE=1 forces coverage on even without GITHUB_ACTIONS', () => {
    expect(coverageEnabled({ CI_COVERAGE: '1' })).toBe(true);
    expect(coverageEnabled({ CI_COVERAGE: 'true' })).toBe(true);
  });

  it('CI_COVERAGE=0 forces coverage off even under GITHUB_ACTIONS', () => {
    expect(
      coverageEnabled({ CI_COVERAGE: '0', GITHUB_ACTIONS: 'true' }),
    ).toBe(false);
    expect(
      coverageEnabled({ CI_COVERAGE: 'false', GITHUB_ACTIONS: 'true' }),
    ).toBe(false);
  });

  it('CI_COVERAGE with any other value falls through to the GITHUB_ACTIONS check', () => {
    // Neither '1'/'true' nor '0'/'false' — the override is ignored
    // and the GITHUB_ACTIONS rule applies.
    expect(coverageEnabled({ CI_COVERAGE: 'yes' })).toBe(false);
    expect(
      coverageEnabled({ CI_COVERAGE: 'maybe', GITHUB_ACTIONS: 'true' }),
    ).toBe(true);
    expect(
      coverageEnabled({ CI_COVERAGE: '', GITHUB_ACTIONS: 'true' }),
    ).toBe(true);
  });

  it('defaults to process.env when no env is passed', () => {
    // Sanity — the function signature says `env = process.env`, so
    // calling it with zero args must not throw. The truth value here
    // depends on whether vitest itself is running under GitHub Actions
    // (which is the case in scripts-tests.yml), so we only assert on
    // return type.
    const v = coverageEnabled();
    expect(typeof v).toBe('boolean');
  });
});
