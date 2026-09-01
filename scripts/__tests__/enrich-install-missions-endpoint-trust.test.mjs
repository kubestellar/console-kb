import { describe, it, expect } from 'vitest'
import {
  assertTrustedEndpoint,
  ALLOWED_ENDPOINT_PREFIXES,
} from '../enrich-install-missions.mjs'

/**
 * Covers assertTrustedEndpoint — the CWE-441 (SSRF) guard exported from
 * scripts/enrich-install-missions.mjs. It is called once at module load
 * against process.env.LLM_ENDPOINT, but the actual export was previously
 * untested. A regression here (e.g. matching by URL.hostname instead of
 * .startsWith, or accepting an empty allowlist) would let a malicious
 * LLM_ENDPOINT reach mission content over HTTP.
 *
 * Existing coverage in enrich-install-missions.test.mjs (54 tests) only
 * exercises sanitizeMissionForHTTP / validateSection / sanitizeSteps.
 */

describe('assertTrustedEndpoint', () => {
  it('accepts each production allowlist prefix verbatim', () => {
    for (const prefix of ALLOWED_ENDPOINT_PREFIXES) {
      expect(assertTrustedEndpoint(prefix)).toBe(prefix)
    }
  })

  it('accepts endpoints that extend an allowlist prefix with a path', () => {
    expect(
      assertTrustedEndpoint('https://models.inference.ai.azure.com/chat/completions')
    ).toBe('https://models.inference.ai.azure.com/chat/completions')
    expect(
      assertTrustedEndpoint('https://api.openai.com/v1/chat/completions')
    ).toBe('https://api.openai.com/v1/chat/completions')
    expect(
      assertTrustedEndpoint('https://api.githubcopilot.com/v1/chat/completions')
    ).toBe('https://api.githubcopilot.com/v1/chat/completions')
  })

  it('rejects http:// variants of allowlisted https:// hosts (scheme downgrade)', () => {
    expect(() =>
      assertTrustedEndpoint('http://api.openai.com/v1/chat/completions')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })

  it('rejects arbitrary attacker-controlled hosts', () => {
    expect(() =>
      assertTrustedEndpoint('https://evil.example.com/chat/completions')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })

  it("rejects endpoints that merely CONTAIN an allowlisted host (not a startsWith match)", () => {
    // This is the class of bug that a naive `.includes` refactor would
    // introduce: `https://evil.com/https://api.openai.com/x` should NOT
    // be trusted.
    expect(() =>
      assertTrustedEndpoint('https://evil.com/https://api.openai.com/foo')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })

  it('rejects an empty string', () => {
    expect(() => assertTrustedEndpoint('')).toThrow(/Untrusted LLM_ENDPOINT/)
  })

  it('rejects file:// and other non-HTTP schemes', () => {
    expect(() =>
      assertTrustedEndpoint('file:///etc/passwd')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
    expect(() =>
      assertTrustedEndpoint('javascript:alert(1)')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
    expect(() =>
      assertTrustedEndpoint('data:text/plain,ignored')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })

  it('reports the offending endpoint and expected prefixes in the error message', () => {
    let msg = ''
    try {
      assertTrustedEndpoint('https://attacker.internal/exfil')
    } catch (err) {
      msg = err.message
    }
    expect(msg).toContain('https://attacker.internal/exfil')
    // Each allowlisted prefix must be surfaced in the error for debugging.
    for (const p of ALLOWED_ENDPOINT_PREFIXES) {
      expect(msg).toContain(p)
    }
  })

  it('honours a caller-provided allowedPrefixes list (overrides default)', () => {
    // The overridable second parameter is a documented seam for testing;
    // regressions that hard-code ALLOWED_ENDPOINT_PREFIXES would fail this.
    const local = ['https://internal.test/']
    expect(assertTrustedEndpoint('https://internal.test/models', local)).toBe(
      'https://internal.test/models'
    )
    // And the production allowlist is NOT consulted when an override is passed.
    expect(() =>
      assertTrustedEndpoint('https://api.openai.com/v1/chat/completions', local)
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })

  it('rejects everything when the caller-provided allowedPrefixes list is empty', () => {
    // Fail-closed semantics: an empty allowlist must NOT default to accept.
    expect(() =>
      assertTrustedEndpoint('https://api.openai.com/v1/chat/completions', [])
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })
})

describe('ALLOWED_ENDPOINT_PREFIXES', () => {
  it('exposes the three production LLM endpoints', () => {
    // Pinning this list guards against silent additions/removals: any new
    // entry should be a conscious decision that comes with its own review.
    expect(ALLOWED_ENDPOINT_PREFIXES).toEqual([
      'https://models.inference.ai.azure.com/',
      'https://api.openai.com/',
      'https://api.githubcopilot.com/',
    ])
  })

  it('every prefix uses https:// and ends with a trailing slash', () => {
    // Trailing slash is what makes the `.startsWith` check safe against
    // sibling-domain attacks like https://api.openai.com.evil.com/...
    for (const p of ALLOWED_ENDPOINT_PREFIXES) {
      expect(p.startsWith('https://')).toBe(true)
      expect(p.endsWith('/')).toBe(true)
    }
  })

  it('rejects sibling-domain suffix attacks that would pass without the trailing slash', () => {
    // e.g. https://api.openai.com.attacker.example must be rejected even
    // though it shares the "api.openai.com" substring.
    expect(() =>
      assertTrustedEndpoint('https://api.openai.com.attacker.example/x')
    ).toThrow(/Untrusted LLM_ENDPOINT/)
  })
})
