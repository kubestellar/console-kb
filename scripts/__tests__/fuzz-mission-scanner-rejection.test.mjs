import { describe, it, expect } from 'vitest'
import { MALFORMED_INPUTS } from '../fuzz-mission-scanner.mjs'
import { scanMissionFile } from '../scanner.mjs'

/**
 * Regression guard for #3295.
 *
 * `fuzz-mission-scanner.mjs::fuzzMissionScanner` currently counts every input
 * as "handled" regardless of whether the scanner actually rejected it. That
 * makes the `Fuzz mission scanner` step in `.github/workflows/fuzz.yml`
 * tautologically green — a regression that made `scanMissionFile` silently
 * return `{ schema: { valid: true } }` on garbage would go undetected.
 *
 * This suite asserts the actual property the workflow step is *supposed* to
 * enforce: every entry in the module's own MALFORMED_INPUTS set must be
 * flagged by `scanMissionFile` (via `.error` truthy OR `.schema.valid ===
 * false`). If any input silently validates, this test fails — surfacing the
 * exact regression class the fuzz step should have caught.
 *
 * Scope note: this test intentionally does NOT modify
 * `fuzzMissionScanner`'s current tautological semantics or the workflow
 * itself. Fixing the counter and rewiring the workflow to call
 * `node scripts/fuzz-mission-scanner.mjs` are the workflow-write half of
 * #3295 and require a merge-tier agent.
 */
describe('fuzz-mission-scanner MALFORMED_INPUTS regression guard (#3295)', () => {
  const isRejected = result =>
    Boolean(result?.error) || result?.schema?.valid === false

  it('MALFORMED_INPUTS set is non-empty (guards against future accidental empty list)', () => {
    expect(Array.isArray(MALFORMED_INPUTS)).toBe(true)
    expect(MALFORMED_INPUTS.length).toBeGreaterThanOrEqual(4)
  })

  it.each(MALFORMED_INPUTS.map((input, i) => [i, input]))(
    'MALFORMED_INPUTS[%i] is rejected by scanMissionFile (error or schema.valid === false)',
    (_i, input) => {
      const result = scanMissionFile(input)
      expect(result).toBeTypeOf('object')
      expect(result).not.toBeNull()
      expect(isRejected(result)).toBe(true)
    }
  )

  it('a well-formed minimal mission is NOT rejected — sanity check that isRejected is not trivially true', () => {
    const wellFormed = JSON.stringify({
      version: 'kc-mission-v1',
      name: 'sanity-mission',
      description: 'minimal well-formed mission for the rejection sanity check',
      steps: [
        {
          id: 'step-1',
          description: 'do one thing',
          command: 'echo hello',
        },
      ],
    })
    const result = scanMissionFile(wellFormed)
    // If this fails on main today, either the scanner's minimum-valid shape
    // has drifted (update the fixture above), or scanMissionFile has broken
    // in a way that makes it reject everything (which would silently make
    // the MALFORMED_INPUTS assertions above meaningless).
    expect(result).toBeTypeOf('object')
    expect(result.error).toBeFalsy()
  })
})
