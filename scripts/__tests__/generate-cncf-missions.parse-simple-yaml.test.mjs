import { describe, it, expect } from 'vitest'
import { parseSimpleYaml } from '../generate-cncf-missions.mjs'

// The module ships its own hand-written parser for knowledge-sources.yaml
// rather than pulling in js-yaml. It handles a very specific 2-level indented
// format with these constructs:
//   sources:                    ← root marker (indent 0)
//     <source-name>:            ← indent 2, ends with ':'
//       <key>: <value>          ← indent 4, key-value
//       <key>:                  ← indent 4, bare key for array below
//         - <item>              ← indent 6, array item
//
// Value coercion: 'true'/'false' → boolean, /^\d+$/ → int,
// '[a,b]' → array-literal, quoted → string (quotes stripped).
//
// Comments (# ...) and blank lines are ignored anywhere.
//
// These tests lock the shape so a well-meaning refactor to js-yaml (or a
// stricter YAML lib) cannot silently change how the shipped config file is
// interpreted at load time.

describe('parseSimpleYaml', () => {
  describe('empty and no-op input', () => {
    it('returns { sources: {} } for empty string', () => {
      expect(parseSimpleYaml('')).toEqual({ sources: {} })
    })

    it('returns { sources: {} } for whitespace-only input', () => {
      expect(parseSimpleYaml('\n\n   \n')).toEqual({ sources: {} })
    })

    it('returns { sources: {} } when only the top-level marker is present', () => {
      expect(parseSimpleYaml('sources:\n')).toEqual({ sources: {} })
    })

    it('ignores lines that are only comments', () => {
      const yaml = [
        '# a header comment',
        'sources:',
        '  # inline note',
        '',
      ].join('\n')
      expect(parseSimpleYaml(yaml)).toEqual({ sources: {} })
    })
  })

  describe('source blocks', () => {
    it('creates an empty object for a bare source name', () => {
      const yaml = 'sources:\n  github-issues:\n'
      expect(parseSimpleYaml(yaml)).toEqual({ sources: { 'github-issues': {} } })
    })

    it('creates multiple source blocks in order', () => {
      const yaml = [
        'sources:',
        '  a:',
        '    enabled: true',
        '  b:',
        '    enabled: false',
      ].join('\n')
      const cfg = parseSimpleYaml(yaml)
      expect(Object.keys(cfg.sources)).toEqual(['a', 'b'])
      expect(cfg.sources.a).toEqual({ enabled: true })
      expect(cfg.sources.b).toEqual({ enabled: false })
    })
  })

  describe('value coercion', () => {
    it('parses true as boolean true', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    flag: true\n')
      expect(cfg.sources.s.flag).toBe(true)
    })

    it('parses false as boolean false', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    flag: false\n')
      expect(cfg.sources.s.flag).toBe(false)
    })

    it('parses all-digit values as integers', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    count: 42\n')
      expect(cfg.sources.s.count).toBe(42)
      expect(typeof cfg.sources.s.count).toBe('number')
    })

    it('parses inline array literals into arrays of trimmed strings', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    tags: [a, b , c]\n')
      expect(cfg.sources.s.tags).toEqual(['a', 'b', 'c'])
    })

    it('strips double quotes from quoted string values', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    name: "hello"\n')
      expect(cfg.sources.s.name).toBe('hello')
    })

    it('strips single quotes from quoted string values', () => {
      const cfg = parseSimpleYaml("sources:\n  s:\n    name: 'hello'\n")
      expect(cfg.sources.s.name).toBe('hello')
    })

    it('keeps unquoted non-numeric non-boolean values as strings', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    window: 90d\n')
      expect(cfg.sources.s.window).toBe('90d')
    })

    it('does NOT strip mismatched surrounding quotes', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    v: "abc\'\n')
      // Only symmetric quotes are stripped
      expect(cfg.sources.s.v).toBe('"abc\'')
    })

    it('treats leading-zero and decimal values as strings (not ints)', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    a: 3.14\n')
      expect(cfg.sources.s.a).toBe('3.14')
    })
  })

  describe('array-under-bare-key', () => {
    it('collects array items following a bare key into an array', () => {
      const yaml = [
        'sources:',
        '  reddit:',
        '    subreddits:',
        '      - kubernetes',
        '      - devops',
        '      - cncf',
      ].join('\n')
      const cfg = parseSimpleYaml(yaml)
      expect(cfg.sources.reddit.subreddits).toEqual(['kubernetes', 'devops', 'cncf'])
    })

    it('supports switching from array-under-bare-key back to key-value', () => {
      const yaml = [
        'sources:',
        '  reddit:',
        '    subreddits:',
        '      - kubernetes',
        '    enabled: true',
      ].join('\n')
      const cfg = parseSimpleYaml(yaml)
      expect(cfg.sources.reddit.subreddits).toEqual(['kubernetes'])
      expect(cfg.sources.reddit.enabled).toBe(true)
    })

    it('ignores stray array items when no bare-key context is active', () => {
      const yaml = [
        'sources:',
        '  reddit:',
        '    enabled: true',
        '      - orphan',
      ].join('\n')
      const cfg = parseSimpleYaml(yaml)
      expect(cfg.sources.reddit).toEqual({ enabled: true })
    })
  })

  describe('comment stripping', () => {
    it('drops end-of-line comments from key-value lines', () => {
      const cfg = parseSimpleYaml('sources:\n  s:\n    enabled: true  # turn on\n')
      expect(cfg.sources.s.enabled).toBe(true)
    })

    it('drops end-of-line comments from array items', () => {
      const yaml = [
        'sources:',
        '  s:',
        '    items:',
        '      - one   # first',
        '      - two',
      ].join('\n')
      const cfg = parseSimpleYaml(yaml)
      expect(cfg.sources.s.items).toEqual(['one', 'two'])
    })
  })

  describe('realistic knowledge-sources.yaml shape', () => {
    it('parses the shape shipped in scripts/knowledge-sources.yaml', () => {
      const yaml = [
        'sources:',
        '  github-issues:',
        '    enabled: true',
        '    minReactions: 10',
        '    maxPerProject: 20',
        '    searchWindow: 90d',
        '  reddit:',
        '    enabled: false',
        '    subreddits:',
        '      - kubernetes',
        '      - devops',
        '    minScore: 25',
      ].join('\n')
      const cfg = parseSimpleYaml(yaml)
      expect(cfg.sources['github-issues']).toEqual({
        enabled: true,
        minReactions: 10,
        maxPerProject: 20,
        searchWindow: '90d',
      })
      expect(cfg.sources.reddit).toEqual({
        enabled: false,
        subreddits: ['kubernetes', 'devops'],
        minScore: 25,
      })
    })
  })
})
