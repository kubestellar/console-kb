/**
 * Unit tests for `buildPlatformMissionFilename()` in
 * generate-platform-missions.mjs.
 *
 * This is the CWE-73 guard between an LLM-synthesized quality-gate verdict
 * and the on-disk mission filename: `main()` passes an HTTP/LLM-derived
 * `gateResult.verdict` string straight into the output path, so the
 * verdict→suffix mapping and the trailing allowlist regex are the only
 * thing stopping a tainted verdict from influencing the filename beyond
 * the known `.draft` infix. The function was previously inline inside
 * `main()`'s per-platform loop and unreachable from vitest; extracting it
 * closes that gap (console-kb — generate-platform-missions.mjs coverage
 * gap, lines 42-50% covered, all of main()'s body untested).
 */
import { describe, it, expect } from 'vitest'
import { buildPlatformMissionFilename } from '../generate-platform-missions.mjs'

describe('buildPlatformMissionFilename', () => {
  it('returns the bare filename for a "pass" verdict (no suffix)', () => {
    expect(buildPlatformMissionFilename('rancher', 'pass')).toBe('platform-rancher.json')
  })

  it('appends .draft for a "draft" verdict', () => {
    expect(buildPlatformMissionFilename('rancher', 'draft')).toBe('platform-rancher.draft.json')
  })

  it('maps "review" to no suffix, same as "pass"', () => {
    expect(buildPlatformMissionFilename('openshift', 'review')).toBe('platform-openshift.json')
  })

  it('falls back to no suffix for an unmapped/unknown verdict', () => {
    // Verdicts actually produced by applyQualityGate/main() are
    // pass/draft/rejected/skipped/failed; 'review' and anything else are
    // defensive-only. An unmapped verdict must still fail closed to the
    // empty suffix rather than being interpolated verbatim.
    expect(buildPlatformMissionFilename('k3s', 'rejected')).toBe('platform-k3s.json')
    expect(buildPlatformMissionFilename('k3s', 'anything-unexpected')).toBe('platform-k3s.json')
  })

  it('accepts multi-segment slugs containing hyphens and digits', () => {
    expect(buildPlatformMissionFilename('k3s-v1-28', 'draft')).toBe('platform-k3s-v1-28.draft.json')
  })

  it('throws when a crafted slug contains path separators, even after basename() strips them', () => {
    // basename() strips everything up through the last '/', so
    // 'platform-../../etc.json' collapses to 'etc.json' — which no
    // longer matches the 'platform-' prefix the allowlist regex requires,
    // so this fails closed instead of silently writing outside the
    // expected naming scheme. (The slug itself is also rejected earlier
    // by assertSafeSlug(), tested elsewhere; this proves the filename
    // guard fails closed even if that first boundary were ever bypassed.)
    expect(() => buildPlatformMissionFilename('../../etc', 'pass')).toThrow(
      /Unexpected output filename derived from HTTP-sourced verdict/,
    )
  })

  it('throws when the resulting filename cannot match the allowlist regex', () => {
    // A slug containing characters the regex forbids (e.g. an embedded
    // newline that basename() does not strip) must raise instead of
    // silently writing an unexpected path.
    expect(() => buildPlatformMissionFilename('bad\nslug', 'pass')).toThrow(
      /Unexpected output filename derived from HTTP-sourced verdict/,
    )
  })
})
