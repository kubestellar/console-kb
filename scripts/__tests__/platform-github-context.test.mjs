// Behavioural tests for scripts/platform/github-context.mjs, extracted from
// generate-platform-missions.mjs (console-kb#3163). These functions were
// previously module-internal and untested — this suite exercises the
// fetch-wrapping GitHub helpers and gatherPlatformContext() with a mocked
// global fetch so the network/parsing/rate-limit logic runs without any
// real HTTP calls (console-kb#3182).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  sleep,
  githubFetch,
  fetchRepoMeta,
  fetchReleases,
  fetchReadme,
  fetchHelmChart,
  fetchHelmValues,
  fetchKustomize,
  checkHelmRepoUrl,
  gatherPlatformContext,
} from '../platform/github-context.mjs'

function ghResponse({ ok = true, status = 200, body = {}, headers = {} } = {}) {
  const h = new Map(Object.entries(headers))
  return {
    ok,
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function b64(str) {
  return Buffer.from(str, 'utf-8').toString('base64')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    vi.useFakeTimers()
    const p = sleep(1000)
    let resolved = false
    p.then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(resolved).toBe(true)
  })
})

describe('githubFetch', () => {
  it('sends an auth header and records rate-limit headers from the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ghResponse({ headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '123' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await githubFetch('https://api.github.com/repos/foo/bar')
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/foo/bar')
    expect(options.headers.Accept).toBe('application/vnd.github+json')
    expect(options.headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(options.headers.Authorization).toMatch(/^Bearer /)
  })

  it('waits out the rate limit window when remaining requests are low', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)
    const lowRemainingResponse = ghResponse({
      headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 2) },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(lowRemainingResponse)
      .mockResolvedValueOnce(ghResponse({ headers: { 'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': '0' } }))
    vi.stubGlobal('fetch', fetchMock)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // First call reports low remaining, so the second call must wait.
    await githubFetch('https://api.github.com/repos/foo/bar')
    const secondCallPromise = githubFetch('https://api.github.com/repos/foo/baz')
    await vi.advanceTimersByTimeAsync(5000)
    await secondCallPromise

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Rate limit low/))
    logSpy.mockRestore()
  })
})

describe('fetchRepoMeta', () => {
  it('returns parsed JSON on a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ body: { full_name: 'foo/bar', stargazers_count: 42 } })))
    const meta = await fetchRepoMeta('foo', 'bar')
    expect(meta).toEqual({ full_name: 'foo/bar', stargazers_count: 42 })
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ ok: false, status: 404 })))
    expect(await fetchRepoMeta('foo', 'bar')).toBeNull()
  })
})

describe('fetchReleases', () => {
  it('returns the releases array on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ body: [{ tag_name: 'v1.0.0' }] })))
    expect(await fetchReleases('foo', 'bar')).toEqual([{ tag_name: 'v1.0.0' }])
  })

  it('returns an empty array on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ ok: false })))
    expect(await fetchReleases('foo', 'bar')).toEqual([])
  })
})

describe('fetchReadme', () => {
  it('decodes base64 README content and truncates to 8000 chars', async () => {
    const long = 'x'.repeat(9000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ body: { content: b64(long) } })))
    const readme = await fetchReadme('foo', 'bar')
    expect(readme).toHaveLength(8000)
  })

  it('returns null when the README is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ ok: false })))
    expect(await fetchReadme('foo', 'bar')).toBeNull()
  })
})

describe('fetchHelmChart', () => {
  it('returns the first matching Chart.yaml content across candidate paths', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ghResponse({ ok: false }))
      .mockResolvedValueOnce(ghResponse({ body: { content: b64('name: foo\nversion: 1.0.0') } }))
    vi.stubGlobal('fetch', fetchMock)
    const chart = await fetchHelmChart('foo', 'bar')
    expect(chart).toContain('name: foo')
    // Tried charts/ first (miss), then chart/ (hit) — 2 calls.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when no candidate path has a Chart.yaml', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ ok: false })))
    expect(await fetchHelmChart('foo', 'bar')).toBeNull()
  })
})

describe('fetchHelmValues', () => {
  it('returns decoded values.yaml content when found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ body: { content: b64('replicas: 1') } })))
    expect(await fetchHelmValues('foo', 'bar')).toContain('replicas: 1')
  })

  it('returns null when no candidate path has values.yaml', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ ok: false })))
    expect(await fetchHelmValues('foo', 'bar')).toBeNull()
  })
})

describe('fetchKustomize', () => {
  it('returns decoded kustomization.yaml content when found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ body: { content: b64('resources: []') } })))
    expect(await fetchKustomize('foo', 'bar')).toContain('resources: []')
  })

  it('returns null when no candidate path has kustomization.yaml', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ghResponse({ ok: false })))
    expect(await fetchKustomize('foo', 'bar')).toBeNull()
  })
})

describe('checkHelmRepoUrl', () => {
  it('returns false when no URL is given', async () => {
    expect(await checkHelmRepoUrl(null)).toBe(false)
  })

  it('returns true when the index.yaml is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    expect(await checkHelmRepoUrl('https://charts.example.com')).toBe(true)
  })

  it('returns false when the request throws (network error / timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    expect(await checkHelmRepoUrl('https://charts.example.com')).toBe(false)
  })
})

describe('gatherPlatformContext', () => {
  it('returns an empty-ish context when platform.repo is missing or malformed', async () => {
    const ctx = await gatherPlatformContext({ name: 'no-repo' })
    expect(ctx).toEqual({
      readme: null, helmChart: null, helmValues: null, kustomize: null, releases: [], repoMeta: null,
    })
  })

  it('aggregates repo metadata, releases (capped at 5), readme, helm, and kustomize data', async () => {
    const fetchMock = vi.fn().mockImplementation((url) => {
      if (url.endsWith('/repos/kubestellar/kubestellar')) {
        return Promise.resolve(ghResponse({ body: { full_name: 'kubestellar/kubestellar' } }))
      }
      if (url.includes('/releases')) {
        return Promise.resolve(ghResponse({ body: Array.from({ length: 10 }, (_, i) => ({ tag_name: `v${i}` })) }))
      }
      if (url.includes('/readme')) {
        return Promise.resolve(ghResponse({ body: { content: b64('# README') } }))
      }
      if (url.includes('Chart.yaml')) {
        return Promise.resolve(ghResponse({ body: { content: b64('name: chart') } }))
      }
      if (url.includes('values.yaml')) {
        return Promise.resolve(ghResponse({ ok: false }))
      }
      if (url.includes('kustomization.yaml')) {
        return Promise.resolve(ghResponse({ ok: false }))
      }
      return Promise.resolve(ghResponse({ ok: false }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = await gatherPlatformContext({ name: 'KubeStellar', repo: 'kubestellar/kubestellar' })
    expect(ctx.repoMeta).toEqual({ full_name: 'kubestellar/kubestellar' })
    expect(ctx.releases).toHaveLength(5)
    expect(ctx.readme).toContain('# README')
    expect(ctx.helmChart).toContain('name: chart')
    expect(ctx.helmValues).toBeNull()
    expect(ctx.kustomize).toBeNull()
  })
})
