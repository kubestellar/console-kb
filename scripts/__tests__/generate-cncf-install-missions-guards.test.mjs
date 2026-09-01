/**
 * Direct behavioural coverage for the three path/slug guards exported from
 * `scripts/generate-cncf-install-missions.mjs`:
 *
 *   - slugify
 *   - assertSafeSlug
 *   - assertSafePath
 *
 * The `assert-safe-path-drift.test.mjs` sibling checks that the three copies
 * of `assertSafePath` (platform-missions, cncf-install-missions,
 * enrich-install-missions) share the same body, but only imports two of them
 * and only for two positive/negative cases. The `generate-platform-missions-
 * guards.test.mjs` sibling covers slugify/assertSafeSlug for the
 * platform-missions copy but never imports the cncf-install-missions copies.
 *
 * These tests exercise the cncf-install-missions copies directly across all
 * documented branches, so a divergent hardening applied to only one copy
 * (or a regression on the guard imported by that file's write path) is
 * caught by real behaviour and not just source-text equality.
 *
 * See: kubestellar/console-kb#3100
 */
import { describe, it, expect } from 'vitest'
import {
  slugify,
  assertSafeSlug,
  assertSafePath,
} from '../generate-cncf-install-missions.mjs'

describe('slugify (cncf-install-missions copy)', () => {
  it('lowercases and hyphenates a name with mixed casing and spaces', () => {
    expect(slugify('Argo CD')).toBe('argo-cd')
    expect(slugify('Open Policy Agent')).toBe('open-policy-agent')
  })

  it('collapses any run of non-[a-z0-9] into a single hyphen', () => {
    expect(slugify('foo___bar   baz')).toBe('foo-bar-baz')
    expect(slugify('a.b.c!d?e')).toBe('a-b-c-d-e')
    expect(slugify('foo/bar\\baz')).toBe('foo-bar-baz')
  })

  it('strips leading and trailing hyphens after collapsing', () => {
    expect(slugify('---foo---')).toBe('foo')
    expect(slugify('   spaced   ')).toBe('spaced')
    expect(slugify('!@#weird$%^')).toBe('weird')
  })

  it('returns the empty string when the input has no [a-z0-9] chars', () => {
    // This is the same "empty source" case flagged in the platform-missions
    // guards test — assertSafeSlug rejects the result, guarding the writer.
    expect(slugify('---')).toBe('')
    expect(slugify('!@#$%')).toBe('')
    expect(slugify('   ')).toBe('')
  })

  it('caps output at 80 characters (assertSafeSlug regex upper bound)', () => {
    const long = 'a'.repeat(200)
    const s = slugify(long)
    expect(s.length).toBe(80)
    // The 80-char boundary must still be a *valid* slug: no trailing hyphen,
    // still matches ^[a-z0-9][a-z0-9-]{0,79}$.
    expect(() => assertSafeSlug(s, 'slice-boundary')).not.toThrow()
  })

  it('lowercases uppercase-only input to a valid slug (not rejected as empty)', () => {
    expect(slugify('KUBERNETES')).toBe('kubernetes')
    expect(() => assertSafeSlug(slugify('KUBERNETES'), 'upper')).not.toThrow()
  })
})

describe('assertSafeSlug (cncf-install-missions copy)', () => {
  it('accepts short lowercase slugs (baseline positive)', () => {
    expect(() => assertSafeSlug('argo-cd', 'cncf')).not.toThrow()
    expect(() => assertSafeSlug('k9s', 'cncf')).not.toThrow()
    expect(() => assertSafeSlug('opentelemetry-collector', 'cncf')).not.toThrow()
  })

  it('accepts a slug at the 80-char boundary but rejects 81', () => {
    const at80 = 'a' + 'b'.repeat(79)
    const at81 = 'a' + 'b'.repeat(80)
    expect(() => assertSafeSlug(at80, 'boundary')).not.toThrow()
    expect(() => assertSafeSlug(at81, 'over-boundary')).toThrow(/Unsafe slug/)
  })

  it('rejects slugs starting with a hyphen (would look like a CLI flag)', () => {
    expect(() => assertSafeSlug('-argo', 'cli')).toThrow(/Unsafe slug/)
  })

  it('rejects slugs containing path-traversal characters', () => {
    expect(() => assertSafeSlug('../etc/passwd', 'attacker')).toThrow(
      /Unsafe slug/,
    )
    expect(() => assertSafeSlug('foo/bar', 'path-sep')).toThrow(/Unsafe slug/)
  })

  it('rejects the empty string (matches "no [a-z0-9] chars" slugify output)', () => {
    expect(() => assertSafeSlug('', 'empty')).toThrow(/Unsafe slug/)
  })

  it('rejects uppercase, underscores, dots, and other disallowed chars', () => {
    expect(() => assertSafeSlug('Argo', 'uppercase')).toThrow(/Unsafe slug/)
    expect(() => assertSafeSlug('argo_cd', 'underscore')).toThrow(
      /Unsafe slug/,
    )
    expect(() => assertSafeSlug('argo.cd', 'dot')).toThrow(/Unsafe slug/)
  })

  it('rejects non-string inputs (undefined, null, number, object)', () => {
    expect(() => assertSafeSlug(undefined, 'unset')).toThrow(/Unsafe slug/)
    expect(() => assertSafeSlug(null, 'nil')).toThrow(/Unsafe slug/)
    expect(() => assertSafeSlug(42, 'numeric')).toThrow(/Unsafe slug/)
    expect(() => assertSafeSlug({}, 'obj')).toThrow(/Unsafe slug/)
  })

  it('embeds the source label and the offending value (JSON-quoted) in the error message', () => {
    try {
      assertSafeSlug('BAD/slug', 'cli-arg')
    } catch (err) {
      expect(err.message).toContain('cli-arg')
      expect(err.message).toContain('"BAD/slug"')
      return
    }
    throw new Error('expected assertSafeSlug to throw')
  })
})

describe('assertSafePath (cncf-install-missions copy)', () => {
  it('accepts the allowed dir itself', () => {
    expect(() =>
      assertSafePath('/tmp/allowed', '/tmp/allowed'),
    ).not.toThrow()
  })

  it('accepts any path strictly inside the allowed dir', () => {
    expect(() =>
      assertSafePath('/tmp/allowed/x', '/tmp/allowed'),
    ).not.toThrow()
    expect(() =>
      assertSafePath('/tmp/allowed/nested/deep/file.json', '/tmp/allowed'),
    ).not.toThrow()
  })

  it('rejects a sibling directory whose name shares a prefix with the allowed dir', () => {
    // The `+ '/'` boundary check is the critical part of the guard: without
    // it, "/tmp/allowed-evil/x" would incorrectly pass startsWith("/tmp/allowed").
    expect(() =>
      assertSafePath('/tmp/allowed-evil/x', '/tmp/allowed'),
    ).toThrow(/Path traversal detected/)
  })

  it('rejects a completely unrelated path', () => {
    expect(() =>
      assertSafePath('/etc/passwd', '/tmp/allowed'),
    ).toThrow(/Path traversal detected/)
  })

  it('rejects an ancestor of the allowed dir', () => {
    expect(() => assertSafePath('/tmp', '/tmp/allowed')).toThrow(
      /Path traversal detected/,
    )
  })

  it('embeds both the target and the allowed dir in the error message', () => {
    try {
      assertSafePath('/tmp/other/x', '/tmp/allowed')
    } catch (err) {
      expect(err.message).toContain('/tmp/other/x')
      expect(err.message).toContain('/tmp/allowed')
      return
    }
    throw new Error('expected assertSafePath to throw')
  })
})
