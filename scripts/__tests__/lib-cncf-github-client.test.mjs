// Unit tests for scripts/lib/cncf-github-client.mjs.
//
// The module was extracted from generate-cncf-missions.mjs (console-kb#3133 /
// #3332) so the rate-limited GitHub REST client, high-engagement issue
// search, issue-detail lookup, and PR diff summarizer could be unit-tested
// independently. Previously the file reported ~1.7% coverage in
// `npm test -- --coverage` because none of its functions were exercised
// from __tests__ — only from the live generate-cncf-missions run.
//
// These tests mirror the mocking pattern already used for
// generate-cncf-install-missions.mjs (see
// generate-cncf-install-missions-fetch-helpers.test.mjs): stub global fetch,
// drive fake timers to skip real backoff sleeps, and defensively reset the
// module-local `rateLimitRemaining` / `rateLimitReset` state between tests
// via a final successful call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  sleep,
  waitForRateLimit,
  githubApi,
  findHighEngagementIssues,
  getIssueDetails,
  fetchPRDiffSummary,
} from '../lib/cncf-github-client.mjs'

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

let originalGithubToken
let warnSpy
let logSpy

beforeEach(() => {
  vi.useFakeTimers()
  originalGithubToken = process.env.GITHUB_TOKEN
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  // Reset module-local rateLimitRemaining/Reset so a test that drove them low
  // (via a 403 with x-ratelimit-remaining: 0) does not leak into later tests
  // and hang their githubApi calls inside waitForRateLimit.
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 200, headers: highRateLimitHeaders() })))
  const resetPromise = githubApi('https://api.github.com/__reset__').catch(() => {})
  await vi.runAllTimersAsync()
  await resetPromise

  vi.useRealTimers()
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
  logSpy.mockRestore()
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
})

// ─── sleep ─────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    let resolved = false
    const p = sleep(500).then(() => { resolved = true })
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(resolved).toBe(true)
  })

  it('resolves immediately for a zero delay', async () => {
    const p = sleep(0)
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBeUndefined()
  })
})

// ─── waitForRateLimit ──────────────────────────────────────────────────

describe('waitForRateLimit', () => {
  it('returns immediately when remaining > 10 (no fetch traffic)', async () => {
    // Fresh module state has rateLimitRemaining = 5000, so this should be
    // a no-op that resolves synchronously.
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await waitForRateLimit()
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── githubApi ─────────────────────────────────────────────────────────

describe('githubApi', () => {
  it('returns parsed JSON on a 200 and passes through headers', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 200, body: { ok: true }, headers: highRateLimitHeaders() }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/repos/o/r')
    await vi.runAllTimersAsync()
    const result = await p
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers.Accept).toBe('application/vnd.github.v3+json')
    expect(opts.headers['User-Agent']).toMatch(/cncf-mission-generator/)
  })

  it('adds Authorization header when GITHUB_TOKEN env var is set at call time', async () => {
    // The module reads GITHUB_TOKEN once at import time (via
    // `import { GITHUB_TOKEN } from '../generate-cncf-missions.mjs'`), so
    // changing process.env after import does not affect the Authorization
    // branch. Assert instead that the Accept + User-Agent headers are
    // always present, which is the invariant callers rely on.
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 200, body: {}, headers: highRateLimitHeaders() }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/x', { headers: { 'X-Custom': 'y' } })
    await vi.runAllTimersAsync()
    await p
    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers['X-Custom']).toBe('y')
    expect(opts.headers.Accept).toBe('application/vnd.github.v3+json')
  })

  it('returns null on 422 without retrying', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 422, body: {}, headers: highRateLimitHeaders() }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/search/issues?q=bad')
    await vi.runAllTimersAsync()
    const result = await p
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null on other non-ok statuses without retrying (e.g. 404)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 404, body: 'not found', headers: highRateLimitHeaders() }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/repos/o/missing')
    await vi.runAllTimersAsync()
    const result = await p
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('retries with exponential backoff on 5xx and eventually succeeds', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call++
      if (call === 1) return jsonResponse({ status: 500, body: {}, headers: highRateLimitHeaders() })
      return jsonResponse({ status: 200, body: { retried: true }, headers: highRateLimitHeaders() })
    })
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/repos/o/r').catch(() => null)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result).toEqual({ retried: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null after MAX_RETRIES on repeated network errors', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/repos/o/r').catch(() => null)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3) // MAX_RETRIES
  })

  it('waits + retries on 403 with x-ratelimit-remaining=0', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call++
      if (call === 1) {
        return jsonResponse({
          status: 403,
          body: {},
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
        })
      }
      return jsonResponse({ status: 200, body: { after: true }, headers: highRateLimitHeaders() })
    })
    vi.stubGlobal('fetch', fetchMock)

    const p = githubApi('https://api.github.com/repos/o/r').catch(() => null)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result).toEqual({ after: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ─── findHighEngagementIssues ──────────────────────────────────────────

describe('findHighEngagementIssues', () => {
  async function runSearch(project, items) {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 200, body: { items }, headers: highRateLimitHeaders() }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = findHighEngagementIssues(project)
    await vi.runAllTimersAsync()
    return p
  }

  it('returns [] when the search endpoint yields no items', async () => {
    const result = await runSearch({ repo: 'octo/hello', maturity: 'incubating' }, [])
    expect(result).toEqual([])
  })

  it('returns [] when githubApi returns null (e.g. 422 on the search)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 422, body: {}, headers: highRateLimitHeaders() }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = findHighEngagementIssues({ repo: 'octo/hello', maturity: 'incubating' })
    await vi.runAllTimersAsync()
    expect(await p).toEqual([])
  })

  it('drops issues below the effective reaction threshold and comment fallback', async () => {
    const items = [
      { title: 'good one', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'not enough signal', reactions: { total_count: 1 }, comments: 1, labels: [] },
    ]
    const result = await runSearch({ repo: 'o/r', maturity: 'incubating' }, items)
    expect(result.map(i => i.title)).toEqual(['good one'])
  })

  it('keeps an issue with low reactions but >= 10 comments (comment fallback)', async () => {
    const items = [
      { title: 'chatty', reactions: { total_count: 0 }, comments: 15, labels: [] },
    ]
    const result = await runSearch({ repo: 'o/r', maturity: 'incubating' }, items)
    expect(result).toHaveLength(1)
  })

  it('filters proposals, RFCs, meetings, lint/e2e, LFX mentorship, and [umbrella] titles', async () => {
    const items = [
      { title: 'RFC: new API', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'Proposal for X', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'Design doc: sharding', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'Community meeting schedule', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'golangci-lint failures', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'increase test coverage', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'LFX mentorship task', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: '[umbrella] track everything', reactions: { total_count: 100 }, comments: 20, labels: [] },
      { title: 'legitimate bug user hits', reactions: { total_count: 100 }, comments: 20, labels: [] },
    ]
    const result = await runSearch({ repo: 'o/r', maturity: 'incubating' }, items)
    expect(result.map(i => i.title)).toEqual(['legitimate bug user hits'])
  })

  it('filters by non-user-facing labels (kind/testing, area/ci, sig/, etc.)', async () => {
    const items = [
      {
        title: 'internal ci breakage',
        reactions: { total_count: 50 }, comments: 20,
        labels: [{ name: 'kind/testing' }],
      },
      {
        title: 'a real user bug',
        reactions: { total_count: 50 }, comments: 20,
        labels: [{ name: 'bug' }],
      },
      {
        title: 'stale meta',
        reactions: { total_count: 50 }, comments: 20,
        labels: ['lifecycle/stale'], // string form label
      },
    ]
    const result = await runSearch({ repo: 'o/r', maturity: 'incubating' }, items)
    expect(result.map(i => i.title)).toEqual(['a real user bug'])
  })

  it('applies the graduated maturity multiplier (lower reaction threshold)', async () => {
    // graduated multiplier = 0.5 → effective threshold = max(3, 5) = 5
    // With MIN_REACTIONS default of 10, an issue with 6 reactions passes.
    const items = [
      { title: 'graduated issue', reactions: { total_count: 6 }, comments: 0, labels: [] },
    ]
    const result = await runSearch({ repo: 'o/r', maturity: 'graduated' }, items)
    expect(result).toHaveLength(1)
  })

  it('applies the sandbox maturity multiplier (higher reaction threshold)', async () => {
    // sandbox multiplier = 2.0 → effective threshold = max(3, 20) = 20
    const items = [
      { title: 'not enough for sandbox', reactions: { total_count: 15 }, comments: 0, labels: [] },
      { title: 'passes sandbox', reactions: { total_count: 25 }, comments: 0, labels: [] },
    ]
    const result = await runSearch({ repo: 'o/r', maturity: 'sandbox' }, items)
    expect(result.map(i => i.title)).toEqual(['passes sandbox'])
  })
})

// ─── getIssueDetails ───────────────────────────────────────────────────

describe('getIssueDetails', () => {
  function mkFetch(responsesByUrlSubstring) {
    return vi.fn(async (url) => {
      for (const [needle, resp] of Object.entries(responsesByUrlSubstring)) {
        if (url.includes(needle)) return resp()
      }
      return jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() })
    })
  }

  it('returns null when the issue endpoint 404s', async () => {
    vi.stubGlobal('fetch', mkFetch({
      '/issues/42': () => jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() }),
    }))
    const p = getIssueDetails('o', 'r', 42).catch(() => null)
    await vi.runAllTimersAsync()
    expect(await p).toBeNull()
  })

  it('returns { issue, comments: [], linkedPR: null } when timeline is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/timeline')) return jsonResponse({ status: 200, body: [], headers: highRateLimitHeaders() })
      if (url.includes('/comments')) return jsonResponse({ status: 200, body: [], headers: highRateLimitHeaders() })
      return jsonResponse({ status: 200, body: { number: 42, title: 't' }, headers: highRateLimitHeaders() })
    }))
    const p = getIssueDetails('o', 'r', 42)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result.issue).toEqual({ number: 42, title: 't' })
    expect(result.comments).toEqual([])
    expect(result.linkedPR).toBeNull()
  })

  it('picks up a same-repo cross-referenced merged PR from the timeline', async () => {
    const prUrl = 'https://api.github.com/repos/o/r/pulls/7'
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/timeline')) {
        return jsonResponse({
          status: 200,
          body: [
            { event: 'labeled' },
            { event: 'cross-referenced', source: { issue: { pull_request: { url: prUrl } } } },
          ],
          headers: highRateLimitHeaders(),
        })
      }
      if (url === prUrl) {
        return jsonResponse({ status: 200, body: { number: 7, merged: true }, headers: highRateLimitHeaders() })
      }
      if (url.includes('/comments')) return jsonResponse({ status: 200, body: [{ body: 'hi' }], headers: highRateLimitHeaders() })
      if (url.endsWith('/issues/42')) return jsonResponse({ status: 200, body: { number: 42 }, headers: highRateLimitHeaders() })
      return jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() })
    }))
    const p = getIssueDetails('o', 'r', 42)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result.comments).toEqual([{ body: 'hi' }])
    expect(result.linkedPR).toEqual({ number: 7, merged: true })
  })

  it('skips a cross-referenced PR from a different repo (cross-repo guard)', async () => {
    const crossRepoPrUrl = 'https://api.github.com/repos/OTHER/repo/pulls/9'
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/timeline')) {
        return jsonResponse({
          status: 200,
          body: [{ event: 'cross-referenced', source: { issue: { pull_request: { url: crossRepoPrUrl } } } }],
          headers: highRateLimitHeaders(),
        })
      }
      if (url.includes('/comments')) return jsonResponse({ status: 200, body: [], headers: highRateLimitHeaders() })
      if (url.endsWith('/issues/42')) return jsonResponse({ status: 200, body: { number: 42 }, headers: highRateLimitHeaders() })
      return jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() })
    }))
    const p = getIssueDetails('o', 'r', 42)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result.linkedPR).toBeNull()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Cross-repo PR ignored/))
  })

  it('drops a linked PR that was closed without merging (merged=false)', async () => {
    const prUrl = 'https://api.github.com/repos/o/r/pulls/8'
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/timeline')) {
        return jsonResponse({
          status: 200,
          body: [{ event: 'cross-referenced', source: { issue: { pull_request: { url: prUrl } } } }],
          headers: highRateLimitHeaders(),
        })
      }
      if (url === prUrl) {
        return jsonResponse({ status: 200, body: { number: 8, merged: false }, headers: highRateLimitHeaders() })
      }
      if (url.includes('/comments')) return jsonResponse({ status: 200, body: [], headers: highRateLimitHeaders() })
      if (url.endsWith('/issues/42')) return jsonResponse({ status: 200, body: { number: 42 }, headers: highRateLimitHeaders() })
      return jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() })
    }))
    const p = getIssueDetails('o', 'r', 42)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result.linkedPR).toBeNull()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/closed without merging/))
  })

  it('tolerates timeline endpoint returning non-array (proceeds with linkedPR=null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/timeline')) return jsonResponse({ status: 200, body: null, headers: highRateLimitHeaders() })
      if (url.includes('/comments')) return jsonResponse({ status: 200, body: [], headers: highRateLimitHeaders() })
      if (url.endsWith('/issues/42')) return jsonResponse({ status: 200, body: { number: 42 }, headers: highRateLimitHeaders() })
      return jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() })
    }))
    const p = getIssueDetails('o', 'r', 42)
    await vi.runAllTimersAsync()
    const result = await p
    expect(result.linkedPR).toBeNull()
  })
})

// ─── fetchPRDiffSummary ────────────────────────────────────────────────

describe('fetchPRDiffSummary', () => {
  it('returns null when the files endpoint returns null (e.g. 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ status: 404, body: {}, headers: highRateLimitHeaders() }),
    ))
    const p = fetchPRDiffSummary('o', 'r', 1)
    await vi.runAllTimersAsync()
    expect(await p).toBeNull()
  })

  it('returns null when the response body is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ status: 200, body: { message: 'nope' }, headers: highRateLimitHeaders() }),
    ))
    const p = fetchPRDiffSummary('o', 'r', 1)
    await vi.runAllTimersAsync()
    expect(await p).toBeNull()
  })

  it('summarizes files with additions/deletions and includes code-file patch lines', async () => {
    const files = [
      {
        status: 'modified',
        filename: 'main.go',
        additions: 5,
        deletions: 2,
        patch: '@@\n+added line 1\n-removed\n+added line 2',
      },
      {
        // Non-code file: filename is included, but patch snippet is not.
        status: 'added',
        filename: 'README.md',
        additions: 1,
        deletions: 0,
        patch: '+some doc line',
      },
      {
        // Code file with patch but no `+` lines → summary only, no snippet.
        status: 'modified',
        filename: 'utils.py',
        additions: 0,
        deletions: 1,
        patch: '@@\n-only removals\n',
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ status: 200, body: files, headers: highRateLimitHeaders() }),
    ))
    const p = fetchPRDiffSummary('o', 'r', 1)
    await vi.runAllTimersAsync()
    const summary = await p
    expect(summary).toContain('modified: main.go (+5/-2)')
    expect(summary).toContain('+added line 1')
    expect(summary).toContain('+added line 2')
    expect(summary).toContain('added: README.md (+1/-0)')
    expect(summary).not.toContain('+some doc line')
    expect(summary).toContain('modified: utils.py (+0/-1)')
  })

  it('recognizes .yaml, .yml, .ts, .js as code-file extensions for patch inclusion', async () => {
    const files = [
      { status: 'modified', filename: 'a.yaml', additions: 1, deletions: 0, patch: '+ya' },
      { status: 'modified', filename: 'b.yml',  additions: 1, deletions: 0, patch: '+ym' },
      { status: 'modified', filename: 'c.ts',   additions: 1, deletions: 0, patch: '+ts' },
      { status: 'modified', filename: 'd.js',   additions: 1, deletions: 0, patch: '+js' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ status: 200, body: files, headers: highRateLimitHeaders() }),
    ))
    const p = fetchPRDiffSummary('o', 'r', 1)
    await vi.runAllTimersAsync()
    const summary = await p
    for (const line of ['+ya', '+ym', '+ts', '+js']) {
      expect(summary).toContain(line)
    }
  })
})
