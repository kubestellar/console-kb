import { describe, it, expect } from 'vitest'
import { scanMissionFile } from '../scanner.mjs'

// Closes previously-uncovered branches in scanner.mjs `scanMissionFile`
// and its inner `tryParseYamlSimple` helper (lines 340 and 359-406):
//
//   - Line 340 (`parsed = yamlLike`): the JSON.parse throws, then the
//     minimal YAML fallback succeeds and returns a truthy object.
//     Existing tests only cover clean JSON and JSON-fails-YAML-null.
//   - Lines 361/362: the "does not look like YAML" early returns
//     (content starts with `{` / `[`, or has no colon at all).
//   - Lines 388/391 both arms: inline value on the same line as the
//     key vs. a bare key with the value continued on subsequent
//     indented lines (multi-line value assembled via line 397).
//   - Line 406: `Object.keys(result).length > 0 ? result : null` —
//     a content string that has a colon but never yields a key
//     (e.g. bare ":value") must produce an empty result and fall
//     back to the parse-error branch.
//
// These are the last reachable branch/line gaps flagged by v8
// coverage on scanner.mjs after the earlier `$()` subshell + base64
// tests (kb#3039) landed.

describe('scanMissionFile YAML fallback path', () => {
  it('parses simple inline-value YAML when JSON.parse fails', () => {
    // Not valid JSON (no braces, unquoted keys) — must go through
    // tryParseYamlSimple, which parses inline `key: value` pairs.
    const yaml = 'id: mission-yaml\ntitle: A YAML mission\n'
    const result = scanMissionFile(yaml)
    expect(result.error).toBeNull()
    expect(result.parsed).toMatchObject({
      id: 'mission-yaml',
      title: 'A YAML mission',
    })
    // Schema/scan objects should be populated (not the null-error shape)
    expect(result.scan).not.toBeNull()
    expect(result.schema).not.toBeNull()
  })

  it('assembles multi-line YAML values across indented continuation lines', () => {
    // First key uses inline value (line 388 true arm),
    // second key is bare so afterColon = '' (line 391 else arm),
    // and the following two-space-indented lines feed the continuation
    // branch on line 395/397.
    const yaml = [
      'id: multi',
      'description:',
      '  first line',
      '  second line',
      'title: T',
      '',
    ].join('\n')
    const result = scanMissionFile(yaml)
    expect(result.error).toBeNull()
    expect(result.parsed.id).toBe('multi')
    expect(result.parsed.title).toBe('T')
    // description should be the joined continuation (contents come
    // through trimmed and newline-joined by the helper).
    expect(result.parsed.description).toContain('first line')
    expect(result.parsed.description).toContain('second line')
  })

  it('skips YAML comments and blank lines during parse', () => {
    // Exercises the `!trimmed || trimmed.startsWith('#')` continue arm
    // on line 376.
    const yaml = [
      '# a comment',
      '',
      'id: with-comment',
      '# trailing comment',
      'title: OK',
    ].join('\n')
    const result = scanMissionFile(yaml)
    expect(result.error).toBeNull()
    expect(result.parsed).toMatchObject({ id: 'with-comment', title: 'OK' })
  })

  it('rejects content that starts with `{` as non-YAML', () => {
    // Line 361 true arm: `{`-prefixed content — YAML fallback bails
    // out with null, so the JSON parse error bubbles up.
    const result = scanMissionFile('{ not: really json')
    expect(result.error).toBe('Failed to parse as JSON or YAML')
    expect(result.parsed).toBeNull()
  })

  it('rejects `[`-prefixed content as non-YAML', () => {
    // Line 361 true arm, sibling case: `[`-prefixed content.
    const result = scanMissionFile('[ not: really json')
    expect(result.error).toBe('Failed to parse as JSON or YAML')
    expect(result.parsed).toBeNull()
  })

  it('rejects colon-free content as non-YAML', () => {
    // Line 362 true arm: no colon anywhere -> YAML fallback returns
    // null -> JSON parse error surface.
    const result = scanMissionFile('this is just prose without any structure')
    expect(result.error).toBe('Failed to parse as JSON or YAML')
    expect(result.parsed).toBeNull()
  })

  it('returns error when YAML parse yields an empty result', () => {
    // Line 406 false arm: content contains a colon but the colonIndex
    // guard (`colonIndex > 0`) rejects every line (leading colon),
    // so `Object.keys(result).length === 0` and the helper returns
    // null.
    const result = scanMissionFile(':value-only\n:another')
    expect(result.error).toBe('Failed to parse as JSON or YAML')
    expect(result.parsed).toBeNull()
  })

  it('returns the fallback error when tryParseYamlSimple itself throws (line 345 outer catch)', () => {
    // Previously-uncovered branch: the outer `catch` in scanMissionFile
    // (scanner.mjs:344-346) only fires when tryParseYamlSimple THROWS
    // rather than returning null. Its top-level guards call
    // `content.trim()` and `content.includes(':')` OUTSIDE a try/catch,
    // so passing a non-string (Symbol here) makes those method lookups
    // throw synchronously — exercising the outer error arm that
    // returns { error: 'Failed to parse as JSON or YAML', parsed: null }
    // instead of a raw TypeError bubbling out to callers.
    const result = scanMissionFile(Symbol('not-a-string'))
    expect(result.error).toBe('Failed to parse as JSON or YAML')
    expect(result.parsed).toBeNull()
    expect(result.schema).toBeNull()
    expect(result.scan).toBeNull()
  })
})
