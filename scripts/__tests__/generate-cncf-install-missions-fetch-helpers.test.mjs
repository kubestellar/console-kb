// Runtime-branch tests for the GitHub / ArtifactHub / LLM fetch wrappers in
// scripts/generate-cncf-install-missions.mjs.
//
// Refs kubestellar/console-kb#3165 and kubestellar/console-kb#3174: the file
// sits at ~26.6% coverage because `githubApi` and every knowledge-source
// fetcher built on it (fetchRawFile, fetchReadme, fetchRepoMeta,
// fetchLatestRelease, fetchHelmCharts, fetchKustomizeManifests,
// fetchDockerImages, fetchOperatorManifests, fetchArtifactHubChart,
// checkHelmRepoUrl, fetchArtifactHubIndexForRepo, gatherProjectContext,
// synthesizeInstallMission, validateAndFixHelmUrl) only ran under DRY_RUN /
// live network paths, never under vitest. These are now exported test-only
// (no behavior change — see the "Test exports" block at the bottom of the
// module) so they can be exercised with `vi.stubGlobal('fetch', ...)`,
// mirroring the pattern already used for callLLM in
// enrich-install-missions.mjs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  assertTrustedEndpoint,
  githubApi,
  fetchRawFile,
  fetchReadme,
  fetchRepoMeta,
  fetchLatestRelease,
  fetchHelmCharts,
  fetchKustomizeManifests,
  fetchDockerImages,
  fetchOperatorManifests,
  fetchArtifactHubChart,
  checkHelmRepoUrl,
  fetchArtifactHubIndexForRepo,
  gatherProjectContext,
  synthesizeInstallMission,
  validateAndFixHelmUrl,
} from '../generate-cncf-install-missions.mjs'

function jsonResponse({ status = 200, body = {}, headers = {} } = {}) {
  const h = new Map(Object.entries(headers))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function highRateLimitHeaders(extra = {}) {
  return { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '0', ...extra }
}

let originalLLMToken
let originalGithubToken

beforeEach(() => {
  vi.useFakeTimers()
  originalLLMToken = process.env.LLM_TOKEN
  originalGithubToken = process.env.GITHUB_TOKEN
})

afterEach(async () => {
  // `rateLimitRemaining` / `rateLimitReset` are module-level mutable state in
  // generate-cncf-install-missions.mjs (not exported), so a test that drives
  // them low (e.g. simulating a 403 rate-limit exhaustion) would otherwise
  // leak that state into later tests and make their githubApi() calls hang
  // in `waitForRateLimit`'s sleep. Defensively reset via one more successful
  // call, advancing fake timers so any pending sleep resolves immediately.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 200, headers: highRateLimitHeaders() })))
  const resetPromise = githubApi('https://api.github.com/__reset-rate-limit__').catch(() => {})
  await vi.runAllTimersAsync()
  await resetPromise

  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (originalLLMToken === undefined) delete process.env.LLM_TOKEN
  else process.env.LLM_TOKEN = originalLLMToken
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
})

// ─── assertTrustedEndpoint ─────────────────────────────────────────────

describe('assertTrustedEndpoint (cncf-install-missions copy)', () => {
  it('returns the endpoint unchanged when it matches an allowed prefix', () => {
    expect(assertTrustedEndpoint('https://api.openai.com/v1/chat')).toBe(
      'https://api.openai.com/v1/chat',
    )
  })

  it('throws for an endpoint outside the allowlist', () => {
    expect(() => assertTrustedEndpoint('https://evil.example.com/x')).toThrow(
      /Untrusted LLM_ENDPOINT/,
    )
  })

  it('accepts a caller-supplied allowlist override', () => {
    expect(() =>
      assertTrustedEndpoint('https://internal.example.com/', ['https://internal.example.com/']),
    ).not.toThrow()
  })
})

// ─── githubApi ──────────────────────────────────────────────────────────

describe('githubApi', () => {
  // GITHUB_TOKEN is captured into a module-level const at import time, so
  // toggling process.env.GITHUB_TOKEN after this file's static import has no
  // effect on the already-imported module. Use a fresh dynamic import (with
  // vi.resetModules) so each case controls the token as seen at load time.
  it('sends an Authorization header when GITHUB_TOKEN is set at load time', async () => {
    vi.resetModules()
    process.env.GITHUB_TOKEN = 'secret-token'
    const { githubApi: freshGithubApi } = await import('../generate-cncf-install-missions.mjs')
    const fetchMock = vi.fn(async () => jsonResponse({ headers: highRateLimitHeaders() }))
    vi.stubGlobal('fetch', fetchMock)

    await freshGithubApi('https://api.github.com/repos/foo/bar')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer secret-token')
  })

  it('omits Authorization when GITHUB_TOKEN is unset at load time', async () => {
    vi.resetModules()
    delete process.env.GITHUB_TOKEN
    const { githubApi: freshGithubApi } = await import('../generate-cncf-install-missions.mjs')
    const fetchMock = vi.fn(async () => jsonResponse({ headers: highRateLimitHeaders() }))
    vi.stubGlobal('fetch', fetchMock)

    await freshGithubApi('https://api.github.com/repos/foo/bar')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBeUndefined()
  })

  it('updates rate-limit bookkeeping from response headers and retries once on 403 exhaustion', async () => {
    const fetchMock = vi.fn()
      // First call: reports remaining=0 with status 403 → githubApi should retry.
      .mockResolvedValueOnce(
        jsonResponse({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)) } }),
      )
      // Second call succeeds.
      .mockResolvedValueOnce(jsonResponse({ status: 200, headers: highRateLimitHeaders() }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = githubApi('https://api.github.com/repos/foo/bar')
    // Allow the internal retry sleep to resolve under fake timers.
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws after 3 failed attempts against a persistently rate-limited API', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)) } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const promise = githubApi('https://api.github.com/repos/foo/bar')
    const assertion = expect(promise).rejects.toThrow(/GitHub API request failed after 3 attempts/)
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

// ─── fetchRawFile / fetchReadme / fetchRepoMeta / fetchLatestRelease ───

describe('fetchRawFile', () => {
  it('returns null when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchRawFile('o', 'r', 'README.md')).toBeNull()
  })

  it('decodes base64-encoded content', async () => {
    const encoded = Buffer.from('hello world', 'utf-8').toString('base64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ body: { encoding: 'base64', content: encoded }, headers: highRateLimitHeaders() })),
    )
    expect(await fetchRawFile('o', 'r', 'README.md')).toBe('hello world')
  })

  it('returns raw content (or null) when no base64 encoding is present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ body: {}, headers: highRateLimitHeaders() })))
    expect(await fetchRawFile('o', 'r', 'README.md')).toBeNull()
  })
})

describe('fetchReadme', () => {
  it('decodes and truncates the README to 8000 chars', async () => {
    const long = 'x'.repeat(9000)
    const encoded = Buffer.from(long, 'utf-8').toString('base64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ body: { encoding: 'base64', content: encoded }, headers: highRateLimitHeaders() })),
    )
    const readme = await fetchReadme('o', 'r')
    expect(readme.length).toBe(8000)
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchReadme('o', 'r')).toBeNull()
  })
})

describe('fetchRepoMeta / fetchLatestRelease', () => {
  it('fetchRepoMeta returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ body: { full_name: 'o/r', stargazers_count: 5 }, headers: highRateLimitHeaders() })),
    )
    expect(await fetchRepoMeta('o', 'r')).toEqual({ full_name: 'o/r', stargazers_count: 5 })
  })

  it('fetchRepoMeta returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 500, headers: highRateLimitHeaders() })))
    expect(await fetchRepoMeta('o', 'r')).toBeNull()
  })

  it('fetchLatestRelease returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ body: { tag_name: 'v1.2.3' }, headers: highRateLimitHeaders() })),
    )
    expect(await fetchLatestRelease('o', 'r')).toEqual({ tag_name: 'v1.2.3' })
  })

  it('fetchLatestRelease returns null when there is no release', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchLatestRelease('o', 'r')).toBeNull()
  })
})

// ─── fetchHelmCharts / fetchKustomizeManifests / fetchDockerImages /
//     fetchOperatorManifests ────────────────────────────────────────────

describe('fetchHelmCharts', () => {
  it('returns an empty list when no Chart.yaml is found at any candidate path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchHelmCharts('o', 'r')).toEqual([])
  })

  it('finds a chart at the first matching path and includes its values.yaml', async () => {
    const chartYaml = Buffer.from('name: demo', 'utf-8').toString('base64')
    const valuesYaml = Buffer.from('replicas: 1', 'utf-8').toString('base64')
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('charts/Chart.yaml')) {
        return jsonResponse({ body: { encoding: 'base64', content: chartYaml }, headers: highRateLimitHeaders() })
      }
      if (url.includes('charts/values.yaml')) {
        return jsonResponse({ body: { encoding: 'base64', content: valuesYaml }, headers: highRateLimitHeaders() })
      }
      // sub-chart directory listing: none found
      return jsonResponse({ status: 404, headers: highRateLimitHeaders() })
    })
    vi.stubGlobal('fetch', fetchMock)

    const charts = await fetchHelmCharts('o', 'r')
    expect(charts).toHaveLength(1)
    expect(charts[0].path).toBe('charts/')
    expect(charts[0].chartYaml).toContain('name: demo')
    expect(charts[0].valuesYaml).toContain('replicas: 1')
  })
})

describe('fetchKustomizeManifests', () => {
  it('returns null when no kustomization.yaml is found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchKustomizeManifests('o', 'r')).toBeNull()
  })

  it('returns the kustomization content and related manifests when found', async () => {
    const kustomization = Buffer.from('resources:\n- a.yaml', 'utf-8').toString('base64')
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('config/default/kustomization.yaml')) {
        return jsonResponse({ body: { encoding: 'base64', content: kustomization }, headers: highRateLimitHeaders() })
      }
      if (url.endsWith('contents/config/default/')) {
        return jsonResponse({ body: [{ name: 'a.yaml' }, { name: 'kustomization.yaml' }], headers: highRateLimitHeaders() })
      }
      if (url.includes('config/default/a.yaml')) {
        const content = Buffer.from('kind: Deployment', 'utf-8').toString('base64')
        return jsonResponse({ body: { encoding: 'base64', content }, headers: highRateLimitHeaders() })
      }
      return jsonResponse({ status: 404, headers: highRateLimitHeaders() })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchKustomizeManifests('o', 'r')
    expect(result.kustomization).toContain('resources:')
    expect(result.manifests).toEqual([{ name: 'a.yaml', content: 'kind: Deployment' }])
  })
})

describe('fetchDockerImages', () => {
  it('returns an empty list when neither Dockerfile nor docker-compose exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchDockerImages('o', 'r')).toEqual([])
  })

  it('collects both a Dockerfile and a docker-compose file when present', async () => {
    const dockerfile = Buffer.from('FROM alpine', 'utf-8').toString('base64')
    const compose = Buffer.from('services: {}', 'utf-8').toString('base64')
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('contents/Dockerfile')) {
        return jsonResponse({ body: { encoding: 'base64', content: dockerfile }, headers: highRateLimitHeaders() })
      }
      if (url.includes('docker-compose.yml')) {
        return jsonResponse({ body: { encoding: 'base64', content: compose }, headers: highRateLimitHeaders() })
      }
      return jsonResponse({ status: 404, headers: highRateLimitHeaders() })
    })
    vi.stubGlobal('fetch', fetchMock)

    const images = await fetchDockerImages('o', 'r')
    expect(images).toEqual([
      { path: 'Dockerfile', content: 'FROM alpine' },
      { path: 'docker-compose.yml', content: 'services: {}' },
    ])
  })
})

describe('fetchOperatorManifests', () => {
  it('returns null when no candidate path resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    expect(await fetchOperatorManifests('o', 'r')).toBeNull()
  })

  it('returns the manifest content from the first matching candidate path', async () => {
    const manifest = Buffer.from('kind: Deployment', 'utf-8').toString('base64')
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('deploy/operator.yaml')) {
        return jsonResponse({ body: { encoding: 'base64', content: manifest }, headers: highRateLimitHeaders() })
      }
      return jsonResponse({ status: 404, headers: highRateLimitHeaders() })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchOperatorManifests('o', 'r')).toContain('kind: Deployment')
  })
})

// ─── fetchArtifactHubChart / checkHelmRepoUrl / fetchArtifactHubIndexForRepo ─

describe('fetchArtifactHubChart', () => {
  it('returns the first matching package repo/chart/version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          body: { packages: [{ repository: { url: 'https://charts.example.com' }, name: 'demo', version: '1.0.0' }] },
        }),
      ),
    )
    expect(await fetchArtifactHubChart('demo')).toEqual({
      repoUrl: 'https://charts.example.com',
      chartName: 'demo',
      latestVersion: '1.0.0',
    })
  })

  it('returns null when no packages are found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ body: { packages: [] } })))
    expect(await fetchArtifactHubChart('demo')).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 500 })))
    expect(await fetchArtifactHubChart('demo')).toBeNull()
  })

  it('returns null when fetch throws/aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error') }))
    expect(await fetchArtifactHubChart('demo')).toBeNull()
  })
})

describe('checkHelmRepoUrl', () => {
  it('returns true when index.yaml resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 200 })))
    expect(await checkHelmRepoUrl('https://charts.example.com')).toBe(true)
  })

  it('returns false on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404 })))
    expect(await checkHelmRepoUrl('https://charts.example.com')).toBe(false)
  })

  it('returns false when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    expect(await checkHelmRepoUrl('https://charts.example.com')).toBe(false)
  })
})

describe('fetchArtifactHubIndexForRepo', () => {
  it('returns the index.yaml text on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 200, body: 'apiVersion: v1' })))
    expect(await fetchArtifactHubIndexForRepo('https://charts.example.com')).toBe('apiVersion: v1')
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404 })))
    expect(await fetchArtifactHubIndexForRepo('https://charts.example.com')).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    expect(await fetchArtifactHubIndexForRepo('https://charts.example.com')).toBeNull()
  })
})

// ─── gatherProjectContext ───────────────────────────────────────────────

describe('gatherProjectContext', () => {
  it('returns an empty object when the project has no owner/repo pair', async () => {
    expect(await gatherProjectContext({ name: 'no-repo' })).toEqual({})
  })

  it('gathers all knowledge sources in parallel for a valid repo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404, headers: highRateLimitHeaders() })))
    const context = await gatherProjectContext({ name: 'demo', repo: 'demo-org/demo-repo' })
    expect(context).toHaveProperty('repoMeta', null)
    expect(context).toHaveProperty('readme', null)
    expect(context).toHaveProperty('latestRelease', null)
    expect(context).toHaveProperty('helmCharts', [])
    expect(context).toHaveProperty('kustomize', null)
    expect(context).toHaveProperty('dockerImages', [])
    expect(context).toHaveProperty('operatorManifests', null)
  })
})

// ─── synthesizeInstallMission ───────────────────────────────────────────

describe('synthesizeInstallMission', () => {
  it('returns null immediately when no LLM token is configured', async () => {
    delete process.env.LLM_TOKEN
    delete process.env.GITHUB_TOKEN
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await synthesizeInstallMission({ name: 'demo' }, {})
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the parsed mission on a valid LLM response', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = { steps: [{ title: 's', description: 'd' }] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 200,
          body: { choices: [{ message: { content: JSON.stringify(payload) } }] },
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    const result = await synthesizeInstallMission({ name: 'demo' }, {})
    expect(result).toEqual(payload)
  })

  it('returns null when the LLM signals skip:true', async () => {
    process.env.LLM_TOKEN = 'test-token'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 200,
          body: { choices: [{ message: { content: JSON.stringify({ skip: true }) } }] },
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    expect(await synthesizeInstallMission({ name: 'demo' }, {})).toBeNull()
  })

  it('returns null on a non-ok LLM response', async () => {
    process.env.LLM_TOKEN = 'test-token'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 500, headers: { 'content-type': 'application/json' } })))
    expect(await synthesizeInstallMission({ name: 'demo' }, {})).toBeNull()
  })

  it('returns null when Content-Type is not application/json', async () => {
    process.env.LLM_TOKEN = 'test-token'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 200, body: 'not json', headers: { 'content-type': 'text/plain' } })),
    )
    expect(await synthesizeInstallMission({ name: 'demo' }, {})).toBeNull()
  })

  it('retries on 429 then succeeds', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = { steps: [{ title: 's', description: 'd' }] }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 200,
          body: { choices: [{ message: { content: JSON.stringify(payload) } }] },
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const promise = synthesizeInstallMission({ name: 'demo' }, {})
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ─── validateAndFixHelmUrl ──────────────────────────────────────────────

describe('validateAndFixHelmUrl', () => {
  it('returns valid:true immediately when the given URL already resolves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 200 })))
    const result = await validateAndFixHelmUrl('https://charts.example.com', 'demo')
    expect(result).toEqual({ valid: true, url: 'https://charts.example.com' })
  })

  it('falls back to an ArtifactHub-resolved repo URL when the given URL fails', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('charts.example.com/index.yaml')) return jsonResponse({ status: 404 })
      if (url.includes('artifacthub.io')) {
        return jsonResponse({ body: { packages: [{ repository: { url: 'https://fallback.example.com' }, name: 'demo', version: '2.0.0' }] } })
      }
      if (url.includes('fallback.example.com/index.yaml')) return jsonResponse({ status: 200 })
      return jsonResponse({ status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateAndFixHelmUrl('https://charts.example.com', 'demo')
    expect(result).toEqual({ valid: true, url: 'https://fallback.example.com', fromArtifactHub: true })
  })

  it('returns valid:false when neither the URL nor the ArtifactHub fallback resolve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 404 })))
    const result = await validateAndFixHelmUrl('https://charts.example.com', 'demo')
    expect(result).toEqual({ valid: false })
  })
})
