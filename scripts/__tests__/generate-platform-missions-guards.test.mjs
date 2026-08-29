/**
 * Unit tests for the exported helpers of generate-platform-missions.mjs.
 *
 * The module is a large CLI generator (322 lines, only ~10% covered) but
 * three of its exports are security-critical pure functions that guard
 * the write-to-disk path in the mission generator:
 *
 *   slugify        — derives filesystem-safe slugs from platform names
 *   assertSafeSlug — refuses slugs that could escape the target directory
 *   assertSafePath — refuses resolved paths outside an allowed directory
 *
 * A regression in any of these silently opens a path-traversal write
 * primitive downstream (mission-executor writes JSON to
 * `fixes/platform-install/${slug}.json`). Keeping these guards under test
 * lets us catch subtle rewrites (e.g. a `.replaceAll` refactor swallowing
 * a boundary check) before they land.
 */
import { describe, it, expect } from 'vitest'
import {
  slugify,
  assertSafeSlug,
  assertSafePath,
} from '../generate-platform-missions.mjs'

describe('slugify', () => {
  it('lowercases and hyphenates a display name', () => {
    expect(slugify('Google Kubernetes Engine')).toBe('google-kubernetes-engine')
  })

  it('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(slugify('foo  bar__baz!!qux')).toBe('foo-bar-baz-qux')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--K3s--')).toBe('k3s')
  })

  it('preserves digits', () => {
    expect(slugify('K8s v1.31')).toBe('k8s-v1-31')
  })

  it('caps output at 80 characters (assertSafeSlug regex upper bound)', () => {
    const veryLong = 'a'.repeat(500)
    const s = slugify(veryLong)
    expect(s.length).toBe(80)
    // and remains an acceptable slug
    expect(() => assertSafeSlug(s, 'slice-boundary')).not.toThrow()
  })

  it('returns an empty string for an all-separator input (caller must reject)', () => {
    expect(slugify('---')).toBe('')
    // The empty string is *not* a valid slug per assertSafeSlug — that's
    // the whole point of the second guard.
    expect(() => assertSafeSlug(slugify('---'), 'empty-source')).toThrow()
  })
})

describe('assertSafeSlug', () => {
  it('accepts a well-formed slug', () => {
    expect(() => assertSafeSlug('gke', 'platforms.mjs')).not.toThrow()
    expect(() => assertSafeSlug('k3s', 'platforms.mjs')).not.toThrow()
    expect(() => assertSafeSlug('kubernetes-1-31', 'platforms.mjs')).not.toThrow()
  })

  it('accepts the 80-char boundary', () => {
    // must START with alnum (regex is /^[a-z0-9][a-z0-9-]{0,79}$/)
    const s = 'a' + 'b'.repeat(79)
    expect(s.length).toBe(80)
    expect(() => assertSafeSlug(s, 'boundary')).not.toThrow()
  })

  it('rejects an 81-char slug (one over the regex upper bound)', () => {
    const s = 'a' + 'b'.repeat(80)
    expect(() => assertSafeSlug(s, 'over-boundary')).toThrow(/Unsafe slug/)
  })

  it('rejects a slug starting with a hyphen (CLI-injection shape)', () => {
    expect(() => assertSafeSlug('-rm-rf', 'cli')).toThrow(/Unsafe slug/)
  })

  it('rejects a path-traversal-shaped slug', () => {
    expect(() => assertSafeSlug('../etc/passwd', 'attacker')).toThrow(/Unsafe slug/)
  })

  it('rejects an empty string', () => {
    expect(() => assertSafeSlug('', 'empty')).toThrow(/Unsafe slug/)
  })

  it('rejects uppercase (slugify contract is lowercase-only)', () => {
    expect(() => assertSafeSlug('GKE', 'uppercase')).toThrow(/Unsafe slug/)
  })

  it('rejects underscores (collapsed by slugify but sometimes reintroduced)', () => {
    expect(() => assertSafeSlug('foo_bar', 'underscore')).toThrow(/Unsafe slug/)
  })

  it('rejects a non-string input without a TypeError leaking through', () => {
    expect(() => assertSafeSlug(undefined, 'unset')).toThrow(/Unsafe slug/)
    expect(() => assertSafeSlug(null, 'null')).toThrow(/Unsafe slug/)
    expect(() => assertSafeSlug(42, 'number')).toThrow(/Unsafe slug/)
  })

  it('embeds the source label in the error message for debuggability', () => {
    try {
      assertSafeSlug('BAD', 'k8s-platforms.mjs')
      throw new Error('did not throw')
    } catch (err) {
      expect(err.message).toContain('k8s-platforms.mjs')
      expect(err.message).toContain('"BAD"')
    }
  })
})

describe('assertSafePath', () => {
  it('accepts a resolved path exactly inside the allowed directory', () => {
    expect(() =>
      assertSafePath('/repo/fixes/platform-install/gke.json', '/repo/fixes/platform-install')
    ).not.toThrow()
  })

  it('accepts a nested path inside the allowed directory', () => {
    expect(() =>
      assertSafePath('/repo/fixes/platform-install/sub/gke.json', '/repo/fixes/platform-install')
    ).not.toThrow()
  })

  it('accepts the allowed directory itself (equality branch)', () => {
    expect(() =>
      assertSafePath('/repo/fixes/platform-install', '/repo/fixes/platform-install')
    ).not.toThrow()
  })

  it('rejects a parent-directory escape via ..', () => {
    expect(() =>
      assertSafePath('/repo/fixes/other/gke.json', '/repo/fixes/platform-install')
    ).toThrow(/Path traversal detected/)
  })

  it('rejects a sibling directory whose name is a prefix of the allowed dir', () => {
    // classic prefix-string-compare pitfall: without the trailing "/"
    // check, "/repo/fixes/platform-install-attacker/x" would slip past
    // startsWith(allowedDir).
    expect(() =>
      assertSafePath(
        '/repo/fixes/platform-install-attacker/x.json',
        '/repo/fixes/platform-install'
      )
    ).toThrow(/Path traversal detected/)
  })

  it('rejects a completely unrelated absolute path', () => {
    expect(() =>
      assertSafePath('/etc/passwd', '/repo/fixes/platform-install')
    ).toThrow(/Path traversal detected/)
  })

  it('embeds both the target and allowed dir in the error message', () => {
    try {
      assertSafePath('/etc/passwd', '/repo/allowed')
      throw new Error('did not throw')
    } catch (err) {
      expect(err.message).toContain('/etc/passwd')
      expect(err.message).toContain('/repo/allowed')
    }
  })
})
