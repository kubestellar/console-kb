// Unit tests for lib/url-fetch-guard.mjs — the SSRF guard (CWE-918) added
// for helmRepoUrl, an LLM-synthesized value seeded from untrusted public
// content (GitHub Discussions / Reddit / Stack Overflow) and previously
// fetched with no host validation by checkHelmRepoUrl / checkVersionFreshness.
import { describe, it, expect, vi, afterEach } from 'vitest'
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
// Node's own http/https client calls the `lookup` option as
// `lookup(hostname, options, callback)` with plain family/hints options —
// it does NOT pass `{ all: true }` (that flag is opt-in, for callers who
// want every resolved address instead of one). `lookupOptions` lets a test
// simulate that real default shape instead of always exercising the
// `{ all: true }` branch of `pinnedSafeLookup`.
// Node's dns module contract lets a custom `lookup` option be invoked as
// either `lookup(hostname, options, callback)` or, when the caller omits
// options, `lookup(hostname, callback)`. Real Node http/https always use
// the 3-arg form, so `twoArgLookupForm` lets a test simulate the 2-arg
// form to exercise pinnedSafeLookup's `typeof options === 'function'`
// normalization branch, which is otherwise unreachable.
function makeFakeTransport(responder, lookupOptions = { all: true }, twoArgLookupForm = false) {
  return (urlObj, options, callback) => {
    const req = new EventEmitter()
    req.end = () => {
      const onLookup = (err) => {
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
      }
      if (twoArgLookupForm) {
        options.lookup(urlObj.hostname, onLookup)
      } else {
        options.lookup(urlObj.hostname, lookupOptions, onLookup)
      }
    }
    req.destroy = () => {}
    return req
  }
}

let fakeTransportResponder = () => ({ status: 200, body: 'ok' })
// Defaults to the real Node shape (no `all`); tests that specifically want
// to exercise the `{ all: true }` branch set this before calling safeFetch.
let fakeLookupOptions = {}
// Set by a test to exercise pinnedSafeLookup's 2-arg `lookup(hostname,
// callback)` normalization branch instead of the real 3-arg form.
let fakeTwoArgLookupForm = false
vi.mock('node:http', () => ({ request: (...args) => makeFakeTransport(h => fakeTransportResponder(h), fakeLookupOptions, fakeTwoArgLookupForm)(...args) }))
vi.mock('node:https', () => ({ request: (...args) => makeFakeTransport(h => fakeTransportResponder(h), fakeLookupOptions, fakeTwoArgLookupForm)(...args) }))

const { assertSafeFetchUrl, isSafeFetchUrl, safeFetch, isPrivateOrReservedIp } = await import('../lib/url-fetch-guard.mjs')

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

  it('rejects a bracketed IPv4-mapped IPv6 loopback literal (`[::ffff:127.0.0.1]`)', async () => {
    // `new URL()` keeps the brackets on the parsed `.hostname` for any IPv6
    // literal, but `net.isIP()` only recognises the unbracketed form. If the
    // brackets aren't stripped before the literal-IP check, this host falls
    // through to the DNS-lookup branch instead of being rejected as a
    // private-IP literal.
    expect(await isSafeFetchUrl('http://[::ffff:127.0.0.1]/index.yaml')).toBe(false)
  })

  it('rejects a bracketed IPv4-mapped IPv6 cloud-metadata literal (`[::ffff:169.254.169.254]`)', async () => {
    expect(await isSafeFetchUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toBe(false)
  })
})

describe('assertSafeFetchUrl', () => {
  it('resolves (does not throw) for a safe URL', async () => {
    await expect(assertSafeFetchUrl('https://public.example.com/index.yaml')).resolves.toBeUndefined()
  })

  it('throws for an unsafe URL', async () => {
    await expect(assertSafeFetchUrl('http://127.0.0.1/')).rejects.toThrow(/Unsafe URL rejected/)
  })

  it('throws for a bracketed IPv4-mapped IPv6 loopback literal with the literal-IP reason (not a DNS-failure reason)', async () => {
    await expect(assertSafeFetchUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/Unsafe URL rejected \(reserved\/private IP literal\)/)
  })
})

describe('safeFetch', () => {
  afterEach(() => {
    fakeLookupOptions = {}
    fakeTwoArgLookupForm = false
  })

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

  it('resolves via the single-address lookup callback shape Node actually uses by default (no `all`)', async () => {
    // Node's http/https client invokes the `lookup` option without `all`,
    // so `pinnedSafeLookup` answers with `callback(null, address, family)`
    // (a single address), not `callback(null, [addresses])`. Every other
    // test in this file passed `{ all: true }` explicitly (see the
    // dedicated test below), leaving this — the actual default, always-hit
    // — branch unexercised.
    fakeLookupOptions = {}
    fakeTransportResponder = () => ({ status: 200, body: 'single-address-ok' })
    const res = await safeFetch('http://public.example.com/index.yaml')
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('single-address-ok')
  })

  it('rejects via the single-address lookup callback shape when the only resolved address is private', async () => {
    fakeLookupOptions = {}
    await expect(safeFetch('http://rebind.example/index.yaml')).rejects.toThrow(/reserved\/private IPs/)
  })

  it('rejects a non-http(s) scheme before attempting any connection', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/Unsafe URL rejected/)
  })

  it('rejects an unparseable URL on the initial safeFetch call, before attempting any connection', async () => {
    // Exercises validateUrlForConnect's own `new URL(...)` try/catch — a
    // distinct code path from assertSafeFetchUrl's (used only by
    // isSafeFetchUrl, already covered above). Previously 0% covered
    // because every existing safeFetch test started from an already-valid
    // URL.
    await expect(safeFetch('not a url')).rejects.toThrow(/Unsafe URL rejected \(unparseable\)/)
  })

  it('tolerates the 2-arg `lookup(hostname, callback)` call shape (options omitted)', async () => {
    // pinnedSafeLookup is a custom Node `lookup` option; Node's dns module
    // contract allows a custom lookup to be invoked as either
    // `(hostname, options, callback)` or `(hostname, callback)` (options
    // omitted). Real Node http/https always use the 3-arg form, so this
    // defensive `typeof options === 'function'` normalization branch was
    // previously unreachable via any existing test's fake transport.
    fakeTwoArgLookupForm = true
    fakeTransportResponder = () => ({ status: 200, body: 'two-arg-lookup-ok' })
    const res = await safeFetch('http://public.example.com/index.yaml')
    expect(res.ok).toBe(true)
    expect(await res.text()).toBe('two-arg-lookup-ok')
  })

  it('connects when at least one resolved address is public, ignoring private ones in the same answer (all:true lookup shape)', async () => {
    // Explicitly exercises the `{ all: true }` branch of `pinnedSafeLookup`
    // — the shape used by a caller requesting every candidate address —
    // which the other safeFetch tests no longer hit now that they default
    // to Node's real (non-`all`) single-address lookup shape.
    fakeLookupOptions = { all: true }
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

  // The checks below live in `validateUrlForConnect` (safeFetch's own
  // connect-time re-validation, run on the initial URL *and* every redirect
  // hop) and are distinct from the identical-looking checks in
  // `assertSafeFetchUrl` exercised above — different function, same source
  // lines were previously 0%-covered. A regression here would be a real
  // SSRF bypass in the function callers actually use (checkHelmRepoUrl /
  // checkVersionFreshness), undetected by the assertSafeFetchUrl tests.
  it('rejects localhost on the initial safeFetch call, before attempting any connection', async () => {
    await expect(safeFetch('http://localhost:8080/index.yaml')).rejects.toThrow(/Unsafe URL rejected \(localhost\)/)
  })

  it('rejects a literal private IP on the initial safeFetch call, before attempting any connection', async () => {
    await expect(safeFetch('http://10.0.0.5/index.yaml')).rejects.toThrow(/Unsafe URL rejected \(reserved\/private IP literal\)/)
  })

  it('rejects a bracketed IPv4-mapped IPv6 loopback literal before attempting any connection (SSRF bypass regression)', async () => {
    // Regression test: Node's http(s) client recognises an already-literal
    // IP host (bracketed IPv6 included) and connects directly, *skipping*
    // the custom `lookup` option entirely — so `pinnedSafeLookup` never
    // runs for this URL. The only defense is the pre-connect check in
    // `validateUrlForConnect`, which previously missed this because
    // `isIP('[::ffff:127.0.0.1]')` (with brackets) returns 0. Fail this
    // test by making the fake transport respond instead of throwing, so a
    // reintroduced bypass shows up as a successful fetch rather than an
    // unrelated error.
    fakeTransportResponder = () => ({ status: 200, body: 'should-not-be-reached' })
    await expect(safeFetch('http://[::ffff:127.0.0.1]/index.yaml')).rejects.toThrow(/Unsafe URL rejected \(reserved\/private IP literal\)/)
  })

  it('rejects a bracketed IPv4-mapped IPv6 cloud-metadata literal before attempting any connection (SSRF bypass regression)', async () => {
    fakeTransportResponder = () => ({ status: 200, body: 'should-not-be-reached' })
    await expect(safeFetch('http://[::ffff:169.254.169.254]/latest/meta-data/')).rejects.toThrow(/Unsafe URL rejected \(reserved\/private IP literal\)/)
  })

  it('rejects a redirect whose target is localhost (redirect-based SSRF bypass attempt)', async () => {
    fakeTransportResponder = (href) => {
      if (href.includes('public.example.com')) {
        return { status: 302, headers: { location: 'http://localhost:8080/admin' } }
      }
      return { status: 200, body: 'should-not-be-reached' }
    }
    await expect(safeFetch('http://public.example.com/index.yaml')).rejects.toThrow(/Unsafe URL rejected \(localhost\)/)
  })

  it('rejects a redirect whose target is a literal private IP (redirect-based SSRF bypass attempt)', async () => {
    fakeTransportResponder = (href) => {
      if (href.includes('public.example.com')) {
        return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
      }
      return { status: 200, body: 'should-not-be-reached' }
    }
    await expect(safeFetch('http://public.example.com/index.yaml'))
      .rejects.toThrow(/Unsafe URL rejected \(reserved\/private IP literal\)/)
  })

})

describe('isPrivateOrReservedIp', () => {
  // `isPrivateOrReservedIp` is only ever called by this module's own code
  // after an `isIP(...)` check has already confirmed the string is a
  // literal IPv4 or IPv6 address, so the final fallback (any other input)
  // is unreachable via safeFetch/assertSafeFetchUrl. It is still exported
  // and part of the function's documented contract ("non-public" is the
  // safe default for anything it can't classify), so it's tested directly.
  it('treats a non-IP string as unsafe (fail-safe default)', () => {
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(true)
  })
})
