// Unit tests for lib/url-fetch-guard.mjs — the SSRF guard (CWE-918) added
// for helmRepoUrl, an LLM-synthesized value seeded from untrusted public
// content (GitHub Discussions / Reddit / Stack Overflow) and previously
// fetched with no host validation by checkHelmRepoUrl / checkVersionFreshness.
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async hostname => {
    if (hostname === 'internal.rebind.example') return [{ address: '169.254.169.254', family: 4 }]
    if (hostname === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }]
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
})

describe('assertSafeFetchUrl', () => {
  it('resolves (does not throw) for a safe URL', async () => {
    await expect(assertSafeFetchUrl('https://public.example.com/index.yaml')).resolves.toBeUndefined()
  })

  it('throws for an unsafe URL', async () => {
    await expect(assertSafeFetchUrl('http://127.0.0.1/')).rejects.toThrow(/Unsafe URL rejected/)
  })
})
