// Unit tests for lib/url-fetch-guard.mjs — the SSRF guard (CWE-918) added
// for helmRepoUrl, an LLM-synthesized value seeded from untrusted public
// content (GitHub Discussions / Reddit / Stack Overflow) and previously
// fetched with no host validation by checkHelmRepoUrl / checkVersionFreshness.
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async hostname => {
    if (hostname === 'internal.rebind.example') return [{ address: '169.254.169.254', family: 4 }]
    if (hostname === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }]
    if (hostname === 'ipv6-loopback.rebind.example') return [{ address: '::1', family: 6 }]
    if (hostname === 'ipv6-unspecified.rebind.example') return [{ address: '::', family: 6 }]
    if (hostname === 'ipv6-link-local.rebind.example') return [{ address: 'fe80::1', family: 6 }]
    if (hostname === 'ipv6-unique-local.rebind.example') return [{ address: 'fd12:3456:789a::1', family: 6 }]
    if (hostname === 'ipv6-mapped-private.rebind.example') return [{ address: '::ffff:169.254.169.254', family: 6 }]
    if (hostname === 'ipv6-public.example.com') return [{ address: '2606:4700:4700::1111', family: 6 }]
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  }),
}))

const { assertSafeFetchUrl, isSafeFetchUrl } = await import('../lib/url-fetch-guard.mjs')

describe('isSafeFetchUrl', () => {
  it('allows a normal public https URL', async () => {
    expect(await isSafeFetchUrl('https://public.example.com/index.yaml')).toBe(true)
  })

  it('rejects non-http(s) schemes', async () => {
    expect(await isSafeFetchUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects loopback IP literals', async () => {
    expect(await isSafeFetchUrl('http://127.0.0.1/index.yaml')).toBe(false)
  })

  it('rejects cloud metadata IP literal', async () => {
    expect(await isSafeFetchUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
  })

  it('rejects localhost', async () => {
    expect(await isSafeFetchUrl('http://localhost:8080/index.yaml')).toBe(false)
  })

  it('rejects private 10.x / 192.168.x / 172.16-31.x literals', async () => {
    expect(await isSafeFetchUrl('http://10.0.0.5/index.yaml')).toBe(false)
    expect(await isSafeFetchUrl('http://192.168.1.1/index.yaml')).toBe(false)
    expect(await isSafeFetchUrl('http://172.16.0.1/index.yaml')).toBe(false)
  })

  it('rejects hostnames that resolve (DNS rebinding) to a private/metadata IP', async () => {
    expect(await isSafeFetchUrl('http://internal.rebind.example/index.yaml')).toBe(false)
  })

  it('rejects unparseable URLs', async () => {
    expect(await isSafeFetchUrl('not a url')).toBe(false)
  })

  it('rejects hostnames that fail to resolve', async () => {
    expect(await isSafeFetchUrl('http://does-not-exist.invalid/index.yaml')).toBe(false)
  })

  // The "literal, non-private IP" success path (the early `return` right
  // after the `isIP(hostname)` check in assertSafeFetchUrl, before any DNS
  // lookup) previously had 0% coverage — every existing "allowed" test used
  // a hostname, not a literal IP address, as the URL host.
  it('allows a literal public IPv4 address as the URL host', async () => {
    expect(await isSafeFetchUrl('http://93.184.216.34/index.yaml')).toBe(true)
  })

  // The IPv6 branch of isPrivateOrReservedIp (loopback, unspecified,
  // link-local, unique-local, and IPv4-mapped addresses) previously had 0%
  // coverage. It is only reachable via a DNS-resolved IPv6 address — a
  // bracketed IPv6 literal in the URL itself (e.g. `http://[::1]/`) is
  // *not* caught by the `isIP(hostname)` literal check, because
  // `new URL(...).hostname` keeps the surrounding `[...]` brackets, so
  // `isIP('[::1]')` returns 0. Such literals instead fall through to the
  // DNS-lookup branch, where they are rejected as "DNS resolution failed"
  // (fail-safe for private ones, but it would also incorrectly block a
  // legitimate public IPv6 literal URL — a separate, non-security defect).
  // These tests exercise the IPv6 branch via its real reachable path:
  // DNS resolution of a hostname to an IPv6 address.
  it('rejects a hostname that DNS-resolves to an IPv6 loopback (::1)', async () => {
    expect(await isSafeFetchUrl('http://ipv6-loopback.rebind.example/index.yaml')).toBe(false)
  })

  it('rejects a hostname that DNS-resolves to the IPv6 unspecified address (::)', async () => {
    expect(await isSafeFetchUrl('http://ipv6-unspecified.rebind.example/index.yaml')).toBe(false)
  })

  it('rejects a hostname that DNS-resolves to an IPv6 link-local address (fe80::/10)', async () => {
    expect(await isSafeFetchUrl('http://ipv6-link-local.rebind.example/index.yaml')).toBe(false)
  })

  it('rejects a hostname that DNS-resolves to an IPv6 unique-local address (fc00::/7)', async () => {
    expect(await isSafeFetchUrl('http://ipv6-unique-local.rebind.example/index.yaml')).toBe(false)
  })

  it('rejects a hostname that DNS-resolves to an IPv4-mapped private IPv6 address', async () => {
    expect(await isSafeFetchUrl('http://ipv6-mapped-private.rebind.example/latest/meta-data/')).toBe(false)
  })

  it('allows a hostname that DNS-resolves to a public IPv6 address', async () => {
    expect(await isSafeFetchUrl('http://ipv6-public.example.com/index.yaml')).toBe(true)
  })
})

describe('assertSafeFetchUrl', () => {
  it('resolves (does not throw) for a safe URL', async () => {
    await expect(assertSafeFetchUrl('https://public.example.com/index.yaml')).resolves.toBeUndefined()
  })

  it('throws for an unsafe URL', async () => {
    await expect(assertSafeFetchUrl('http://127.0.0.1/')).rejects.toThrow(/Unsafe URL rejected/)
  })
})
