// Unit tests for lib/url-fetch-guard.mjs — the SSRF guard (CWE-918) added
// for helmRepoUrl, an LLM-synthesized value seeded from untrusted public
// content (GitHub Discussions / Reddit / Stack Overflow) and previously
// fetched with no host validation by checkHelmRepoUrl / checkVersionFreshness.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

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

// `safeFetch`'s pinned `lookup` option uses the callback-style `node:dns`
// (not `node:dns/promises`). These resolutions model the TOCTOU scenario:
// an attacker-controlled DNS server could answer a *separate* validation
// lookup with a public IP, but safeFetch has no separate validation lookup
// to desync from — this is the single lookup that also opens the socket.
vi.mock('node:dns', () => ({
  lookup: vi.fn((hostname, options, callback) => {
    const responses = {
      'public.example.com': [{ address: '93.184.216.34', family: 4 }],
      'rebind.example': [{ address: '169.254.169.254', family: 4 }],
      'all-private.example': [{ address: '10.0.0.1', family: 4 }],
      'mixed.example': [{ address: '10.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }],
      'redirect-target.example': [{ address: '93.184.216.34', family: 4 }],
    }
    const addrs = responses[hostname]
    if (!addrs) return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
    callback(null, addrs)
  }),
}))

// Fakes the TCP/TLS layer: calls the `lookup` option Node would otherwise
// invoke to resolve the host before connecting, so these tests exercise
// the real `pinnedSafeLookup` logic (via the real `node:dns` mock above)
// rather than re-implementing it.
function makeFakeTransport(responder) {
  return (urlObj, options, callback) => {
    const req = new EventEmitter()
    req.end = () => {
      options.lookup(urlObj.hostname, { all: true }, (err) => {
        if (err) return req.emit('error', err)
        let result
        try {
          result = responder(urlObj.href)
        } catch (resErr) {
          return req.emit('error', resErr)
        }
        const res = new EventEmitter()
        res.statusCode = result.status
        res.headers = result.headers || {}
        queueMicrotask(() => {
          callback(res)
          if (result.body) res.emit('data', Buffer.from(result.body))
          res.emit('end')
        })
      })
    }
    req.destroy = () => {}
    return req
  }
}

let fakeTransportResponder = () => ({ status: 200, body: 'ok' })
vi.mock('node:http', () => ({ request: (...args) => makeFakeTransport(h => fakeTransportResponder(h))(...args) }))
vi.mock('node:https', () => ({ request: (...args) => makeFakeTransport(h => fakeTransportResponder(h))(...args) }))

const { assertSafeFetchUrl, isSafeFetchUrl, safeFetch } = await import('../lib/url-fetch-guard.mjs')

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

describe('safeFetch', () => {
  it('fetches a public hostname successfully', async () => {
    fakeTransportResponder = () => ({ status: 200, body: 'apiVersion: v1' })
    const res = await safeFetch('http://public.example.com/index.yaml')
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('apiVersion: v1')
  })

  it('rejects when the connect-time lookup resolves only to a private/metadata IP (DNS rebind)', async () => {
    // Even though this hostname looks unrelated to the earlier pre-check
    // tests, what matters here is that safeFetch's *own* connection-time
    // lookup (not a separate, already-passed pre-check) is what rejects
    // this — there is no earlier lookup for a rebinding DNS server to
    // have answered differently.
    await expect(safeFetch('http://rebind.example/index.yaml')).rejects.toThrow(/reserved\/private IPs/)
  })

  it('rejects a non-http(s) scheme before attempting any connection', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/Unsafe URL rejected/)
  })

  it('connects when at least one resolved address is public, ignoring private ones in the same answer', async () => {
    fakeTransportResponder = () => ({ status: 200, body: 'ok' })
    const res = await safeFetch('http://mixed.example/index.yaml')
    expect(res.ok).toBe(true)
  })

  it('follows a same-safety redirect to its (re-validated) target', async () => {
    fakeTransportResponder = (href) => {
      if (href.includes('public.example.com')) {
        return { status: 302, headers: { location: 'http://redirect-target.example/index.yaml' } }
      }
      return { status: 200, body: 'redirected-ok' }
    }
    const res = await safeFetch('http://public.example.com/index.yaml')
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('redirected-ok')
  })

  it('rejects a redirect chain longer than maxRedirects', async () => {
    let hop = 0
    fakeTransportResponder = () => {
      hop += 1
      return { status: 302, headers: { location: `http://public.example.com/${hop}` } }
    }
    await expect(safeFetch('http://public.example.com/index.yaml', { maxRedirects: 2 }))
      .rejects.toThrow(/too many redirects/)
  })

  it('returns ok:false (not a throw) for a non-2xx status', async () => {
    fakeTransportResponder = () => ({ status: 404, body: '' })
    const res = await safeFetch('http://public.example.com/index.yaml')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
})
