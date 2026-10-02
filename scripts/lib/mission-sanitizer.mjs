/**
 * Shared mission-tree sanitizer for the LLM-driven mission generators.
 *
 * Each generator used to inline both the recursive walker and its per-string
 * policy inside its own `main()` for-loop body (see
 * generate-cncf-install-missions.mjs and generate-platform-missions.mjs
 * before kubestellar/console-kb#3641). The walker is identical across
 * generators; the per-string policies deliberately differ. Consolidating
 * both the walker and the policies here follows the same pattern the repo
 * already uses for `lib/llm-endpoint-guard.mjs` (#3134, #3333, #3614) and
 * `lib/mission-file.mjs`:
 *
 *   1. A security-adjacent surface lives at a single declaration site, so a
 *      future CodeQL fix or policy change only has to land once.
 *   2. The function bodies become reachable from a source-parsing drift test
 *      (`scripts/__tests__/sanitize-mission-text-drift.test.mjs`) that pins
 *      the walker shape and the policy regexes.
 *
 * The emitted bytes for every generator must stay identical to the inline
 * implementation they replaced.
 */

import { sanitizeInfraDetails } from './text-utils.mjs'

/**
 * Repeatedly apply `pattern` → `replacement` until the input is stable.
 * Guards against overlapping / nested patterns that a single `.replace`
 * would leave behind (CWE-80 / CWE-116, js/incomplete-multi-character-sanitization).
 */
export function replaceUntilStable(input, pattern, replacement = '') {
  let previous
  do {
    previous = input
    input = input.replace(pattern, replacement)
  } while (input !== previous)
  return input
}

/**
 * Walk a mission body recursively, applying `perString` to every string leaf.
 * Arrays and plain objects are rebuilt; everything else is returned as-is.
 *
 * This is the exact traversal shape inlined inside both
 * `generate-cncf-install-missions.mjs` and `generate-platform-missions.mjs`
 * before extraction (kubestellar/console-kb#3641).
 */
export function walkMissionTree(obj, perString) {
  if (typeof obj === 'string') return perString(obj)
  if (Array.isArray(obj)) return obj.map(item => walkMissionTree(item, perString))
  if (obj && typeof obj === 'object') {
    const result = {}
    for (const [k, v] of Object.entries(obj)) result[k] = walkMissionTree(v, perString)
    return result
  }
  return obj
}

/**
 * Install-generator per-string policy: HTML-entity decode, then strip
 * `<script>` bodies, inline event-handler attributes, `javascript:` URL
 * schemes, and residual tags to a fixed point (CWE-80 / CWE-79 / CWE-116).
 *
 * Byte-identical to the closure previously inlined in
 * `scripts/generate-cncf-install-missions.mjs:562-585`.
 */
export function sanitizeStripHtml(input) {
  let sanitized = input

  // Decode HTML entities first to catch entity-encoded attacks.
  sanitized = sanitized
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&amp;/gi, '&')

  // Loop each multi-character sanitizer to a fixed point (CWE-80/116).
  // Match closing </script> with any content before > to cover variants like
  // </script\t\n bar> (js/bad-tag-filter).
  sanitized = replaceUntilStable(sanitized, /<script[\s\S]*?<\/\s*script[^>]*>/gi)
  sanitized = replaceUntilStable(sanitized, /\bon\w+[\s\u0000-\u001F\u007F]*=[\s\u0000-\u001F\u007F]*(?:["'][^"']*["']|[^\s>]+)/gi)
  sanitized = replaceUntilStable(sanitized, /javascript[\s\u0000-\u001F\u007F]*:/gi)
  sanitized = replaceUntilStable(sanitized, /<[^>]+>/g)

  return sanitized
}

/**
 * Platform-generator per-string policy: redact real infra details, HTML-encode
 * ampersand / angle brackets, strip C0 and DEL control characters, and cap
 * length (CWE-80 / CWE-79 / CWE-434; see fixes #2896).
 *
 * Byte-identical to the closure previously inlined in
 * `scripts/generate-platform-missions.mjs:338-348`, with `maxLen` defaulting
 * to the same 5000 used at the single historical callsite.
 */
export function sanitizeEncodeAndRedactInfra(input, { maxLen = 5000 } = {}) {
  return sanitizeInfraDetails(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
}

/**
 * Convenience wrapper matching the call shape used in
 * `generate-cncf-install-missions.mjs`:
 *   `mission.mission = sanitizeInstallMission(mission.mission)`
 */
export function sanitizeInstallMission(missionBody) {
  return walkMissionTree(missionBody, sanitizeStripHtml)
}

/**
 * Convenience wrapper matching the call shape used in
 * `generate-platform-missions.mjs`:
 *   `mission.mission = sanitizePlatformMission(mission.mission)`
 */
export function sanitizePlatformMission(missionBody, { maxLen = 5000 } = {}) {
  return walkMissionTree(missionBody, s => sanitizeEncodeAndRedactInfra(s, { maxLen }))
}
