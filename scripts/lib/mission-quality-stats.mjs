/**
 * Pure helper for averaging mission quality scores across a directory of
 * generated mission JSON files.
 *
 * Extracted from the "Create PR" step of
 * .github/workflows/platform-install-gen.yml (see kubestellar/console-kb#3197).
 */

/**
 * Average the `metadata.qualityScore` (or top-level `qualityScore`, or 0)
 * across a list of parsed mission objects.
 *
 * @param {object[]} missions - parsed mission JSON contents
 * @param {object} [options]
 * @param {boolean} [options.excludeZero=false] - when true, missions whose
 *   resolved score is 0 (missing/unrecorded) are excluded from both the
 *   numerator and the denominator, so the average reflects only missions with
 *   a known score. When false (default), missing scores count as 0, so the
 *   average is pulled down by unscored missions. `install-gen/average-quality-score`
 *   uses `excludeZero: true`; `platform/average-quality-score` uses the default.
 *   See kubestellar/console-kb#3508.
 * @returns {number} rounded average score, or 0 if no missions contribute
 */
export function averageQualityScore(missions, { excludeZero = false } = {}) {
  const scores = missions.map((m) => m.metadata?.qualityScore || m.qualityScore || 0)
  const kept = excludeZero ? scores.filter((s) => s > 0) : scores
  if (!kept.length) return 0
  return Math.round(kept.reduce((a, b) => a + b, 0) / kept.length)
}
