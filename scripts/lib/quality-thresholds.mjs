/**
 * Single parse point for mission quality thresholds.
 *
 * Extracted from six independent `parseInt(process.env.QUALITY_THRESHOLD
 * || '…', 10)` call sites that shared one env var with two different
 * defaults (60 vs 70) across two scorers that measure incomparable
 * dimensions — see kubestellar/console-kb#3627. Mirrors the pattern used
 * in `scripts/lib/batch-env.mjs` (#3500).
 *
 * Two gates, two env vars:
 *   - GEN_QUALITY_THRESHOLD — the generation path ("ship this generated
 *     mission?"). Used by `quality-scorer.mjs` (`scoreMission`) and its
 *     callers: `generate-cncf-install-missions.mjs`,
 *     `generate-platform-missions.mjs`, `score-and-merge-mission-prs.mjs`.
 *   - KB_QUALITY_THRESHOLD — the KB enforcement path ("mark this indexed
 *     entry as qualityPass?"). Used by `advanced-quality-scorer.mjs`
 *     (`scoreMissionAdvanced` / `MIN_SCORE`) only.
 *
 * Precedence for each: new var > legacy `QUALITY_THRESHOLD` > the
 * caller-supplied default. This PR is behavior-preserving — every call
 * site keeps its existing effective default when only the legacy
 * `QUALITY_THRESHOLD` (or nothing) is set. Pass the current per-file
 * default as `defaultValue` so that doesn't change.
 */

/**
 * Threshold for the generation path (`scoreMission` / generator & merge
 * callers). Reads GEN_QUALITY_THRESHOLD, falling back to the legacy
 * QUALITY_THRESHOLD, falling back to `defaultValue`.
 * @param {number} defaultValue - Per-call-site default (unchanged by this refactor).
 * @returns {number}
 */
export function genQualityThreshold(defaultValue) {
  const raw = process.env.GEN_QUALITY_THRESHOLD ?? process.env.QUALITY_THRESHOLD
  return raw != null ? parseInt(raw, 10) : defaultValue
}

/**
 * Threshold for the KB enforcement path (`scoreMissionAdvanced` /
 * `MIN_SCORE`). Reads KB_QUALITY_THRESHOLD, falling back to the legacy
 * QUALITY_THRESHOLD, falling back to `defaultValue`.
 * @param {number} defaultValue - Per-call-site default (unchanged by this refactor).
 * @returns {number}
 */
export function kbQualityThreshold(defaultValue) {
  const raw = process.env.KB_QUALITY_THRESHOLD ?? process.env.QUALITY_THRESHOLD
  return raw != null ? parseInt(raw, 10) : defaultValue
}
