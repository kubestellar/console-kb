import { describe, it, expect } from 'vitest';
import config from '../vitest.config.mjs';

/**
 * Guards the coverage ratchet documented in `vitest.config.mjs`: the
 * thresholds are supposed to track a few points below the last measured
 * baseline and move up in follow-up PRs, never down. Without this test,
 * `thresholds` could be silently lowered (e.g. to paper over a real
 * regression) with nothing failing locally or in CI.
 *
 * Floor values below match the 2026-11-12 ratchet; bump them together
 * with the "Current measured baseline" comment the next time coverage
 * climbs again.
 */
describe('vitest.config.mjs coverage thresholds — ratchet floor', () => {
  const { thresholds } = config.test.coverage;

  it('statements/lines/functions/branches are at or above the 2026-11-12 floor', () => {
    expect(thresholds.statements).toBeGreaterThanOrEqual(85);
    expect(thresholds.lines).toBeGreaterThanOrEqual(85);
    expect(thresholds.functions).toBeGreaterThanOrEqual(86);
    expect(thresholds.branches).toBeGreaterThanOrEqual(84);
  });
});
