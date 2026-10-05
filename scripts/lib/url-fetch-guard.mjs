/**
 * Shared SSRF guard (CWE-918) for fetching attacker/LLM-influenceable URLs
 * that are *not* pinned to a fixed allowlist (unlike `lib/llm-endpoint-guard.mjs`,
 * which gates the operator-configured `LLM_ENDPOINT` against a small, fixed
 * set of trusted API hosts).
 *
 * Helm chart-repo URLs (`helmRepoUrl`) are LLM-synthesized from mission
 * content that is itself seeded from public, unauthenticated sources
 * (GitHub Discussions, Reddit, Stack Overflow — see scripts/sources/*).
 * An attacker can post content designed to steer the LLM into emitting a
 * `helmRepoUrl` pointing at an internal service or a cloud metadata
 * endpoint (e.g. http://169.254.169.254/), and `checkHelmRepoUrl` /
 * `checkVersionFreshness` previously made an unguarded `fetch()` to
 * whatever string the LLM produced, on a schedule, with no human review
 * gate (platform-install-gen.yml / cncf-install-gen.yml run on a cron).
 *
 * This guard rejects non-http(s) schemes, literal loopback/private/
 * link-local/metadata/unspecified/multicast IPs, `localhost`, and hostnames
 * that resolve (via DNS) to any such address.
 *
 * `assertSafeFetchUrl`/`isSafeFetchUrl` alone are only a *pre-check*: they
 * run one DNS lookup to validate, but the caller's subsequent `fetch()`
 * call triggers its own, independent DNS lookup to actually connect. A DNS
 * server under attacker control can answer the validation lookup with a
 * public IP and the later connection lookup with a private/metadata IP —
 * a TOCTOU / DNS-rebinding bypass of the pre-check. `safeFetch` below
 * closes this for real by pinning a single DNS resolution — validated and
 * then reused for the actual TCP connection via Node's socket-level
 * `lookup` option — so there is no second, unguarded resolution for an
 * attacker's DNS server to race.
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { lookup as dnsLookupCallback } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Returns true if `address` (a literal IPv4/IPv6 address) is non-public. */
export function isPrivateOrReservedIp(address) {
  const version = isIP(address)
  if (version === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    if (a === 127) return true // loopback
    if (a === 10) return true // private
    if (a === 169 && b === 254) return true // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 0) return true // "this" network / unspecified
    if (a >= 224) return true // multicast + reserved
    return false
  }
  if (version === 6) {
    const addr = address.toLowerCase()
    if (addr === '::1') return true // loopback
    if (addr === '::') return true // unspecified
    if (addr.startsWith('fe80:') || addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) return true // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true // unique local
    if (addr.startsWith('::ffff:')) return isPrivateOrReservedIp(addr.slice('::ffff:'.length)) // IPv4-mapped
    return false
  }
  return true // not a literal IP we recognise — treat as unsafe
}

/**
 * Asserts that `urlString` is safe to fetch: http(s) only, and neither the
 * hostname itself nor anything it resolves to is a loopback/private/
 * link-local/metadata address. Throws on an unsafe URL; otherwise resolves
 * to void.
 */
export async function assertSafeFetchUrl(urlString) {
  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Unsafe URL rejected (unparseable): ${urlString}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsafe URL rejected (scheme ${parsed.protocol} not allowed): ${urlString}`)
  }

  const hostname = parsed.hostname
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error(`Unsafe URL rejected (localhost): ${urlString}`)
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error(`Unsafe URL rejected (reserved/private IP literal): ${urlString}`)
    }
    return
  }

  let resolved
  try {
    resolved = await lookup(hostname, { all: true })
  } catch {
    throw new Error(`Unsafe URL rejected (DNS resolution failed): ${urlString}`)
  }
  for (const { address } of resolved) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`Unsafe URL rejected (resolves to reserved/private IP ${address}): ${urlString}`)
    }
  }
}

/**
 * Convenience wrapper: returns true/false instead of throwing, for call
 * sites that want a reachability-style boolean rather than an exception.
 */
export async function isSafeFetchUrl(urlString) {
  try {
    await assertSafeFetchUrl(urlString)
    return true
  } catch {
    return false
  }
}

const DEFAULT_MAX_REDIRECTS = 5

/** Re-validates scheme/localhost/literal-IP for a redirect target; hostname safety is enforced at connect time by the pinned lookup. */
function validateUrlForConnect(urlString) {
  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Unsafe URL rejected (unparseable): ${urlString}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsafe URL rejected (scheme ${parsed.protocol} not allowed): ${urlString}`)
  }
  if (parsed.hostname.toLowerCase() === 'localhost') {
    throw new Error(`Unsafe URL rejected (localhost): ${urlString}`)
  }
  if (isIP(parsed.hostname) && isPrivateOrReservedIp(parsed.hostname)) {
    throw new Error(`Unsafe URL rejected (reserved/private IP literal): ${urlString}`)
  }
  return parsed
}

/**
 * Node socket-level `lookup` override: resolves `hostname`, drops any
 * loopback/private/link-local/metadata address from the candidate set, and
 * errors if none remain. Because this is the *same* resolution Node uses to
 * open the TCP connection (not a separate earlier check), there is no
 * window for a DNS-rebinding attacker to answer differently between
 * validation and connection.
 */
function pinnedSafeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  dnsLookupCallback(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err)
    const candidates = Array.isArray(addresses) ? addresses : [addresses]
    const safe = candidates.filter(({ address }) => !isPrivateOrReservedIp(address))
    if (safe.length === 0) {
      callback(Object.assign(
        new Error(`Unsafe URL rejected (resolves only to reserved/private IPs): ${hostname}`),
        { code: 'EUNSAFEHOST' },
      ))
      return
    }
    if (options.all) {
      callback(null, safe)
    } else {
      callback(null, safe[0].address, safe[0].family)
    }
  })
}

/**
 * SSRF-safe replacement for `fetch()` against attacker/LLM-influenceable
 * URLs. Unlike `isSafeFetchUrl` + a plain `fetch()` call, the DNS
 * resolution used to decide safety is the exact same resolution used to
 * open the connection, closing the TOCTOU/DNS-rebinding gap described at
 * the top of this file. Redirect targets are re-validated and re-resolved
 * the same way, up to `maxRedirects`.
 *
 * Returns a minimal `fetch`-like response: `{ ok, status, text() }`.
 */
export async function safeFetch(urlString, { timeoutMs = 10000, maxRedirects = DEFAULT_MAX_REDIRECTS } = {}) {
  let currentUrl = urlString
  for (let redirects = 0; ; redirects++) {
    const parsed = validateUrlForConnect(currentUrl)
    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest

    const response = await new Promise((resolve, reject) => {
      const req = requestFn(parsed, { lookup: pinnedSafeLookup, timeout: timeoutMs }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`)))
      req.on('error', reject)
      req.end()
    })

    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects >= maxRedirects) {
        throw new Error(`Unsafe URL rejected (too many redirects): ${urlString}`)
      }
      currentUrl = new URL(response.headers.location, currentUrl).toString()
      continue
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    }
  }
}
