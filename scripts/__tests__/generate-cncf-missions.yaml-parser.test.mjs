import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSimpleYaml, loadSourcesConfig } from '../generate-cncf-missions.mjs'

// scripts/generate-cncf-missions.mjs resolves `knowledge-sources.yaml`
// via its own __dirname, which is <repo>/scripts. To exercise the
// fallback path (config missing) we point at a scratch config path
// and swap it out; loadSourcesConfig's real path is fixed, so we
// simply exercise fallback by temporarily renaming the file — but
// touching a repo-shared file is not test-hygienic. Instead we only
// unit-test loadSourcesConfig indirectly: parseSimpleYaml carries the
// interesting branching, and loadSourcesConfig on the checked-in
// yaml exercises the "file exists" arm end-to-end.
const __filename = fileURLToPath(import.meta.url)
const scriptsDir = dirname(dirname(__filename))
const configPath = join(scriptsDir, 'knowledge-sources.yaml')

describe('parseSimpleYaml — parseSimpleYaml() (scripts/generate-cncf-missions.mjs)', () => {
  it('parses the empty document to an empty sources object', () => {
    expect(parseSimpleYaml('')).toEqual({ sources: {} })
  })

  it('skips blank lines and full-line comments', () => {
    // The regex `#.*$` strips comments after trimming, so pure-comment
    // lines resolve to '' after `.trim().replace(/#.*$/, '').trimEnd()`
    // and are dropped by the `if (!trimmed) continue` guard.
    const yaml = [
      '# top-level comment',
      '',
      'sources:',
      '  github-issues:',
      '    # inline comment',
      '    enabled: true',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { 'github-issues': { enabled: true } },
    })
  })

  it('parses booleans, integers, unquoted strings, and inline arrays', () => {
    const yaml = [
      'sources:',
      '  reddit:',
      '    enabled: true',
      '    dryRun: false',
      '    maxPerProject: 20',
      '    searchWindow: 90d',
      '    tags: [k8s, devops, cloudnative]',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: {
        reddit: {
          enabled: true,
          dryRun: false,
          maxPerProject: 20,
          searchWindow: '90d',
          tags: ['k8s', 'devops', 'cloudnative'],
        },
      },
    })
  })

  it('strips single and double quotes from quoted string values', () => {
    // Lock the arm at line 108-110: quoted values have their outer
    // quotes stripped. A regression that drops this normalisation
    // would leak the quotes into consumer code (e.g. label prefixes).
    const yaml = [
      'sources:',
      '  s1:',
      '    a: "hello world"',
      "    b: 'single quoted'",
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { s1: { a: 'hello world', b: 'single quoted' } },
    })
  })

  it('parses bare array-of-scalars via key: followed by `- item` lines', () => {
    // Exercises the 4-space "bare key" arm (line 90) that primes
    // `lastArrayKey`, then the 6-space `- item` arm (line 117) that
    // appends each entry.
    const yaml = [
      'sources:',
      '  reddit:',
      '    subreddits:',
      '      - kubernetes',
      '      - devops',
      '      - k8s',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { reddit: { subreddits: ['kubernetes', 'devops', 'k8s'] } },
    })
  })

  it('resets lastArrayKey when a normal key:value follows a bare key', () => {
    // After a `subreddits:` bare key primes lastArrayKey, the next
    // `key: value` line at 4-space indent must reset lastArrayKey to
    // null (line 100). A regression that leaves lastArrayKey pinned
    // would push a subsequent 6-space `- item` line into the wrong
    // array. Guard that ordering.
    const yaml = [
      'sources:',
      '  reddit:',
      '    subreddits:',
      '      - kubernetes',
      '    minUpvotes: 5',
      '    tags:',
      '      - devops',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: {
        reddit: {
          subreddits: ['kubernetes'],
          minUpvotes: 5,
          tags: ['devops'],
        },
      },
    })
  })

  it('treats key: value that contains a space as a plain string, not a bare-array key', () => {
    // Line 80 guards source-name detection with `!trimmed.includes(' ')`
    // and line 90 does the same for the bare-array key. A `description`
    // value with spaces must not be misread as a source name; instead
    // it takes the standard key: value branch.
    const yaml = [
      'sources:',
      '  s1:',
      '    description: has spaces here',
      '    enabled: true',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: {
        s1: { description: 'has spaces here', enabled: true },
      },
    })
  })

  it('ignores 4-space key: value lines that appear before any source header', () => {
    // The `if (indent === 4 && currentSource)` guard skips key: value
    // lines when `currentSource` is null. A regression that dropped
    // the null-guard would push orphan keys to `config.sources[null]`
    // and crash on later reads.
    const yaml = [
      'sources:',
      '    orphan: value',
      '  s1:',
      '    enabled: true',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { s1: { enabled: true } },
    })
  })

  it('drops 4-space lines without a colon separator', () => {
    // The `colonIdx > 0` guard skips malformed lines like a bare
    // token at the key-value indent. This locks the fallthrough.
    const yaml = [
      'sources:',
      '  s1:',
      '    justAToken',
      '    enabled: true',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { s1: { enabled: true } },
    })
  })

  it('ignores 6-space array items when no lastArrayKey is set', () => {
    // The `lastArrayKey` guard on the 6-space branch (line 117)
    // prevents stray `- item` lines from crashing on `undefined.push`.
    const yaml = [
      'sources:',
      '  s1:',
      '    enabled: true',
      '      - stray-item',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { s1: { enabled: true } },
    })
  })

  it('strips trailing inline comments from a value line', () => {
    // `.trim().replace(/#.*$/, '').trimEnd()` runs BEFORE the branches,
    // so a `key: value  # note` line records just the value with no
    // trailing whitespace.
    const yaml = [
      'sources:',
      '  s1:',
      '    label: kubernetes  # cluster manager',
    ].join('\n')
    expect(parseSimpleYaml(yaml)).toEqual({
      sources: { s1: { label: 'kubernetes' } },
    })
  })
})

describe('loadSourcesConfig — loadSourcesConfig() (scripts/generate-cncf-missions.mjs)', () => {
  it('loads and parses the checked-in knowledge-sources.yaml', () => {
    // Exercises the file-exists arm end-to-end against the real
    // config the CNCF pipeline consumes at runtime, so a regression
    // that changes parseSimpleYaml semantics is caught by asserting
    // shape rather than by pinning specific values.
    expect(existsSync(configPath)).toBe(true)
    const cfg = loadSourcesConfig()
    expect(cfg).toHaveProperty('sources')
    expect(typeof cfg.sources).toBe('object')
    // knowledge-sources.yaml enables github-issues at least.
    expect(cfg.sources['github-issues']).toBeDefined()
    expect(cfg.sources['github-issues'].enabled).toBe(true)
  })
})
