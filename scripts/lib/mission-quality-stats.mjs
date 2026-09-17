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
 * @returns {number} rounded average score, or 0 if the list is empty
 */
export function averageQualityScore(missions) {
  if (!missions.length) return 0
  const scores = missions.map((m) => m.metadata?.qualityScore || m.qualityScore || 0)
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
}
