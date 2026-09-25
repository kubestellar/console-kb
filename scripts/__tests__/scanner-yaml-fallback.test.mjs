import { describe, it, expect } from 'vitest'
import { tryParseYamlSimple } from '../scanner/yaml-fallback.mjs'

describe('tryParseYamlSimple legacy fallback helper', () => {
  it('parses simple inline-value YAML-like content', () => {
    const yaml = 'id: mission-yaml\ntitle: A YAML mission\n'
    const parsed = tryParseYamlSimple(yaml)
    expect(parsed).toMatchObject({
      id: 'mission-yaml',
      title: 'A YAML mission',
    })
  })

  it('assembles multi-line values across indented continuation lines', () => {
    const yaml = [
      'id: multi',
      'description:',
      '  first line',
      '  second line',
      'title: T',
      '',
    ].join('\n')
    const parsed = tryParseYamlSimple(yaml)
    expect(parsed.id).toBe('multi')
    expect(parsed.title).toBe('T')
    expect(parsed.description).toContain('first line')
    expect(parsed.description).toContain('second line')
  })

  it('skips comments and blank lines during parse', () => {
    const yaml = [
      '# a comment',
      '',
      'id: with-comment',
      '# trailing comment',
      'title: OK',
    ].join('\n')
    expect(tryParseYamlSimple(yaml)).toMatchObject({ id: 'with-comment', title: 'OK' })
  })

  it('rejects content that starts with `{` as non-YAML-like', () => {
    expect(tryParseYamlSimple('{ not: really json')).toBeNull()
  })

  it('rejects `[`-prefixed content as non-YAML-like', () => {
    expect(tryParseYamlSimple('[ not: really json')).toBeNull()
  })

  it('rejects colon-free content as non-YAML-like', () => {
    expect(tryParseYamlSimple('this is just prose without any structure')).toBeNull()
  })

  it('returns null when parsing yields an empty result', () => {
    expect(tryParseYamlSimple(':value-only\n:another')).toBeNull()
  })

  it('swallows errors thrown inside the parse loop', () => {
    const evilContent = {
      trim: () => ({ startsWith: () => false }),
      includes: () => true,
      split() { throw new Error('boom inside YAML split') },
    }
    expect(tryParseYamlSimple(evilContent)).toBeNull()
  })
})
