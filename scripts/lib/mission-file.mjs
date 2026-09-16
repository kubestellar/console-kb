/**
 * Shared path/slug guards and mission-file serialization helpers for the
 * mission generator scripts.
 *
 * Extracted from `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` (kubestellar/console-kb#3134,
 * kubestellar/console-kb#3333), which each carried byte-identical copies of
 * `slugify`, `assertSafeSlug`, `assertSafePath`, and
 * `serializeSanitizedMissionForFile`. Consolidating these security-critical
 * guards (path traversal / CWE-22, oversized or unsanitized mission output)
 * into one place means a future hardening only has to land once.
 *
 * `enrich-install-missions.mjs` keeps its own copy of `assertSafePath` for
 * now (out of scope for this refactor — see kubestellar/console-kb#3100).
 */

/** Derives a filesystem-safe slug from an arbitrary display name. */
export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

/** Refuses slugs that could escape the target directory. */
export function assertSafeSlug(slug, source = 'unknown') {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new Error(`Unsafe slug derived from ${source}: ${JSON.stringify(slug)}`)
  }
}

/** Refuses a resolved path that falls outside the allowed directory (CWE-22). */
export function assertSafePath(resolvedTarget, resolvedAllowedDir) {
  if (!resolvedTarget.startsWith(resolvedAllowedDir + '/') && resolvedTarget !== resolvedAllowedDir) {
    throw new Error(`Path traversal detected: ${resolvedTarget} is outside ${resolvedAllowedDir}`)
  }
}

/**
 * Serializes a mission object for disk, refusing oversized payloads (>1MB)
 * and any post-sanitization payload that still contains a `<script>` tag or
 * an `on<event>=` attribute — the last line of defense before untrusted LLM
 * output is written to a JSON file.
 */
export function serializeSanitizedMissionForFile(mission) {
  // Trailing newline matches the install-missions copy of this guard and
  // POSIX text-file conventions; the platform-missions copy previously
  // omitted it (console-kb#3333 drift) — reconciled here on the newer,
  // more-correct behavior.
  const missionJson = JSON.stringify(mission, null, 2) + '\n'
  if (missionJson.length > 1_000_000) {
    throw new Error(`Refusing to write oversized mission (${missionJson.length} bytes)`)
  }
  if (/<\s*script\b/i.test(missionJson) || /\bon\w+\s*=/i.test(missionJson)) {
    throw new Error('Refusing to write mission containing unsafe HTML after sanitization')
  }
  return missionJson
}
