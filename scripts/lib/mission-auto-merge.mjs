/**
 * Pure helpers for the "Score and auto-merge passing mission PRs" step of
 * .github/workflows/cncf-mission-gen.yml (see kubestellar/console-kb#3197
 * and the auto-merge safety gap tracked in #3157).
 *
 * Kept free of `child_process`/`gh` calls so the PR filtering, required-check
 * gating, and quality-score gating logic can be unit-tested in isolation.
 */

/**
 * Filter a list of PRs (as returned by `gh pr list --json ...`) down to
 * those created within the lookback window.
 *
 * @param {Array<{createdAt: string}>} prs
 * @param {number} lookbackHours
 * @param {Date|number} nowMs - injectable "now" for tests
 * @returns {Array}
 */
export function filterRecentPRs(prs, lookbackHours, nowMs = Date.now()) {
  const since = new Date(Number(nowMs) - lookbackHours * 60 * 60 * 1000)
  return prs.filter((pr) => new Date(pr.createdAt) >= since)
}

/**
 * Parse `gh pr checks --json name,state,bucket` output and determine
 * whether every check in `requiredChecks` has passed.
 *
 * `gh pr checks` exits non-zero if any check failed or is still pending;
 * callers should still pass through stdout (or the error's captured
 * stdout) so this function can inspect it either way.
 *
 * @param {string} checksJson - raw JSON text (may be empty/invalid)
 * @param {string[]} requiredChecks - required check names, in priority order
 * @returns {{pass: true} | {pass: false, name: string, state: string}}
 */
export function requiredChecksPassed(checksJson, requiredChecks) {
  let checks = []
  try {
    checks = checksJson ? JSON.parse(checksJson) : []
  } catch {
    checks = []
  }

  for (const name of requiredChecks) {
    const check = checks.find((c) => c.name === name)
    if (!check || check.bucket !== 'pass') {
      return { pass: false, name, state: check ? check.state : 'missing' }
    }
  }
  return { pass: true }
}

/**
 * Find the mission JSON file changed in a PR's file list, ignoring the
 * generated fixes/index.json.
 *
 * @param {string} filesOutput - raw `gh pr diff --name-only` stdout
 * @returns {string|undefined}
 */
export function findMissionFile(filesOutput) {
  return filesOutput
    .trim()
    .split('\n')
    .find((f) => f.startsWith('fixes/') && f.endsWith('.json') && !f.endsWith('index.json'))
}

/**
 * Decode a base64 `gh api .../contents/...` response body into the parsed
 * mission JSON object.
 *
 * @param {string} content - base64-encoded file content (with optional whitespace)
 * @returns {object}
 */
export function decodeMissionContent(content) {
  return JSON.parse(Buffer.from(content.trim(), 'base64').toString('utf8'))
}
