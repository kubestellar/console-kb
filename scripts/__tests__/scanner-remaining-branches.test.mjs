import { describe, it, expect } from 'vitest'
import { scanForMaliciousContent } from '../scanner.mjs'
import { tryParseYamlSimple } from '../scanner/yaml-fallback.mjs'

// Covers remaining scanner edge cases plus legacy YAML-fallback helper
// branches that are still kept as direct utility behavior.
//
// Each case is a real edge case that would ship silently if
// the surrounding logic regressed:
//
//   - 265: `if (pattern.test(decoded))` false arm. A base64 blob that
//     decodes to plain UTF-8 with none of the suspicious patterns
//     (`curl|wget|bash|...`, `$()`, backticks) must NOT be flagged.
//     If a future edit widened the pattern set (e.g. added `mv|cp`),
//     this test would surface that new blob types now trip the
//     obfuscation heuristic.
//
//   - yaml-fallback: short-circuit arm of
//     `if (currentKey !== null && line.startsWith('  '))`.
//     Reached only when the very first non-blank line has no colon —
//     i.e. a bare token that should be silently skipped rather than
//     appended as a stray continuation.
//
//   - yaml-fallback (`||` right operand): the last stored key has an empty
//     `currentValue`. The parser must store `null` for a bare key,
//     never `''`, so downstream consumers can rely on
//     `if (result[key])` semantics.

describe('scanner and YAML fallback remaining branch guards', () => {
  it('does NOT flag a base64 blob whose decoded content is plain safe text', () => {
    // base64('this is just safe text with no commands whatsoever')
    // decodes to a 51-char string containing none of curl/wget/bash/
    // sh/eval/exec/nc/netcat/chmod/chown, no `$()`, no backticks.
    // Falsy arm of the `if (pattern.test(decoded))` check on line 265.
    const safeBlob =
      'dGhpcyBpcyBqdXN0IHNhZmUgdGV4dCB3aXRoIG5vIGNvbW1hbmRzIHdoYXRzb2V2ZXI='
    const mission = {
      version: 'kc-mission-v1',
      name: 'safe-b64',
      mission: {
        title: 'Payload',
        // The scanner walks all string values, so we just put the
        // blob into any string field.
        description: `Reference tag: ${safeBlob}`,
        steps: [{ title: 'Step', description: 'noop' }],
      },
    }
    const { findings } = scanForMaliciousContent(mission)
    const b64Findings = findings.filter(
      f => f.type === 'Obfuscation: base64-encoded command',
    )
    expect(b64Findings).toEqual([])
  })

  it('drops mid-block bare lines that lack the two-space continuation indent', () => {
    // After `id:` establishes currentKey, a non-colon line that
    // ALSO does not start with two spaces must be silently dropped
    // — it is neither a new key nor a valid continuation. This
    // exercises the falsy right operand of
    // `currentKey !== null && line.startsWith('  ')` in yaml-fallback.mjs
    // (arm 1 of the binary-expr), which the earlier test only hit
    // with `currentKey === null` short-circuit.
    const yaml = [
      'id: first',
      'not-indented-non-continuation',
      'title: T',
    ].join('\n')
    const parsed = tryParseYamlSimple(yaml)
    expect(parsed).toEqual({ id: 'first', title: 'T' })
    // Value of `id` must NOT have absorbed the stray line.
    expect(parsed.id).toBe('first')
  })

  it('drops a leading bare (no-colon) line before any key has been established', () => {
    // First non-blank line "foo" has no colon, so `colonIndex > 0`
    // is false and we fall to the `else if (currentKey !== null ...)`
    // guard in yaml-fallback.mjs. `currentKey` is still null at this
    // point, so the AND short-circuits (arm 1 of the binary expr)
    // and the line is silently dropped instead of being appended to
    // some non-existent previous value.
    //
    // The `content.includes(':')` guard at the top of
    // `tryParseYamlSimple` still passes because a later line supplies
    // one.
    const yaml = ['foo', 'id: after-junk', 'title: T'].join('\n')
    const parsed = tryParseYamlSimple(yaml)
    // The stray "foo" line must NOT bleed into any key.
    expect(parsed).toEqual({ id: 'after-junk', title: 'T' })
    expect(Object.keys(parsed)).not.toContain('foo')
  })

  it('stores null (not empty string) when the last key has no value', () => {
    // Last key `description:` has no inline value and no continuation
    // lines. The final "save" at scanner.mjs:402-404 evaluates
    // `currentValue.trim() || null` — with `currentValue === ''` the
    // trim is `''` (falsy) and the right operand of `||` is taken,
    // storing null.
    //
    // Locks the contract that downstream `if (result.description)`
    // checks can safely distinguish missing values.
    const yaml = ['id: last-key-empty', 'description:', ''].join('\n')
    const parsed = tryParseYamlSimple(yaml)
    expect(parsed.id).toBe('last-key-empty')
    // The distinguishing assertion — strictly null, not ''.
    expect(parsed.description).toBeNull()
    expect(parsed.description).not.toBe('')
  })

  it('stores null when an intermediate key is bare and a new key follows', () => {
    // yaml-fallback.mjs (`currentValue.trim() || null`) is also
    // executed when the NEXT top-level key is parsed and the "save
    // previous" block runs with an empty currentValue. Distinct from
    // the last-key case above: this fires from the mid-loop save
    // path, not the post-loop save. The `|| null` fallback arm
    // (right operand of `||`) must be exercised here too so a
    // regression that changed the fallback to `''` would be caught
    // whether the bare key is last or in the middle of the document.
    const yaml = ['first-bare:', 'second: val', ''].join('\n')
    const parsed = tryParseYamlSimple(yaml)
    expect(parsed).toEqual({ 'first-bare': null, second: 'val' })
    // Explicit strict-null assertion — regressions to '' would slip
    // past the .toEqual above under some diff engines.
    expect(parsed['first-bare']).toBeNull()
  })
})
