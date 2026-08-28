import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditSource } from '../../sources/reddit.mjs'

/**
 * Additional branch coverage for scripts/sources/reddit.mjs.
 *
 * The existing reddit.test.mjs covers the search() filter happy path
 * and one extractMission() success case. This module targets the error
 * paths and helper branches those tests skip:
 *
 *   - search(): non-ok fetch response emits a warning and skips the
 *     subreddit; a thrown fetch (network error) is caught and warned
 *     without crashing the caller.
 *   - search(): the maxPerProject cap short-circuits the outer
 *     subreddit loop as well as the inner search-term loop.
 *   - search(): the removed_by_category and over_18 filters drop
 *     posts.
 *   - extractMission(): returns null for missing/short selftext, and
 *     also when fetchTopComments returns null.
 *   - extractMission(): the difficulty threshold flips from
 *     'intermediate' to 'advanced' at body length > 1000.
 *   - extractMission(): detectType() covers each label branch
 *     (troubleshooting/best-practice/performance/security).
 *   - extractMission(): steps fall through from the numbered-list
 *     regex to the bullet-list regex.
 *   - fetchTopComments(): non-ok response, non-array payload, and a
 *     thrown fetch all resolve to null without raising.
 */

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const ORIGINAL_FETCH = globalThis.fetch

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIGINAL_ENV[key]
  }
}

const TEST_PROJECT = {
  name: 'Argo CD',
  repo: 'argoproj/argo-cd',
  maturity: 'incubating',
  category: 'gitops',
}

const EMPTY_STATE = { lastSearched: null, processedIds: [], cursor: null }

function makeSource(overrides = {}) {
  return new RedditSource({ rateLimitDelay: 0, subreddits: ['kubernetes'], minUpvotes: 5, ...overrides })
}

function mkPost(overrides = {}) {
  return {
    data: {
      id: 'p1',
      title: 'Argo CD needs a manifest fix',
      ups: 50,
      removed_by_category: null,
      over_18: false,
      created_utc: Date.now() / 1000,
      permalink: '/r/kubernetes/comments/p1/',
      selftext: '',
      ...overrides,
    },
  }
}

describe('RedditSource.search – error paths and filter branches', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('warns and skips the subreddit when fetch returns a non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const source = makeSource()
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
    expect(console.warn).toHaveBeenCalled()
    const msg = console.warn.mock.calls.map(c => c[0]).join('\n')
    expect(msg).toMatch(/503/)
  })

  it('catches a thrown fetch and warns without crashing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('econnreset'))
    const source = makeSource()
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
    const msg = console.warn.mock.calls.map(c => c[0]).join('\n')
    expect(msg).toMatch(/econnreset/)
  })

  it('drops posts flagged by removed_by_category or over_18', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            mkPost({ id: 'r', removed_by_category: 'moderator' }),
            mkPost({ id: 'n', over_18: true }),
            mkPost({ id: 'ok', selftext: 'x' }),
          ],
        },
      }),
    })
    const source = makeSource()
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items.map(i => i.data.id)).toEqual(['ok'])
  })

  it('stops adding items once maxPerProject is reached', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: Array.from({ length: 30 }, (_, i) => mkPost({ id: `p${i}` })),
        },
      }),
    })
    const source = makeSource({ maxPerProject: 2 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toHaveLength(2)
  })
})

describe('RedditSource.extractMission – return-null and helper branches', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('returns null when the selftext is too short', async () => {
    const source = makeSource()
    const mission = await source.extractMission({ data: { title: 't', selftext: 'short', permalink: '/r/k/' } }, TEST_PROJECT)
    expect(mission).toBeNull()
  })

  it('returns null when fetchTopComments cannot produce a solution', async () => {
    const source = makeSource()
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue(null)
    const long = 'x'.repeat(150)
    const mission = await source.extractMission({ data: { title: 't', selftext: long, permalink: '/r/k/' } }, TEST_PROJECT)
    expect(mission).toBeNull()
  })

  it('flips difficulty to advanced when body length exceeds 1000 chars', async () => {
    const source = makeSource()
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue('1. run kubectl apply -f x.yaml')
    const body = 'This deployment is failing with security errors. '.repeat(30) // >1000 chars, no ``` fences
    const mission = await source.extractMission({ data: { title: 'Argo CD RBAC lockout', selftext: body, permalink: '/r/k/' } }, TEST_PROJECT)
    expect(mission).not.toBeNull()
    expect(mission.metadata.difficulty).toBe('advanced')
  })

  it('detectType covers each labelled arm', async () => {
    const source = makeSource()
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue('1. do the thing\n2. verify')
    const long = 'x'.repeat(150)

    const cases = [
      { text: 'crash loop on startup', want: 'troubleshooting' },
      { text: 'what is the best practice for probes', want: 'best-practice' },
      { text: 'latency is high and requests are slow', want: 'performance' },
      { text: 'rbac and tls hardening for the cluster', want: 'security' },
    ]

    for (const c of cases) {
      const mission = await source.extractMission({
        data: {
          title: c.text,
          selftext: `${c.text}. ${long}`,
          permalink: '/r/k/',
        },
      }, TEST_PROJECT)
      expect(mission, `case ${c.text}`).not.toBeNull()
      expect(mission.mission.type, `case ${c.text}`).toBe(c.want)
    }
  })

  it('falls through from numbered-list to bullet-list steps', async () => {
    const source = makeSource()
    // Solution text has no numbered list; only bullets. extractSteps
    // should fall through to the bullet regex.
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue('- check pod logs\n- apply the manifest\n- verify status')
    const long = 'The Argo CD Pod fails after upgrade and needs a manifest change. '.repeat(3)
    const mission = await source.extractMission({
      data: { title: 'Argo CD failure', selftext: long, permalink: '/r/k/' },
    }, TEST_PROJECT)
    expect(mission).not.toBeNull()
    expect(mission.mission.steps.map(s => s.title)).toEqual([
      'check pod logs',
      'apply the manifest',
      'verify status',
    ])
  })
})

describe('RedditSource.fetchTopComments – error and shape branches', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('returns null when Reddit responds non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const source = makeSource()
    const result = await source.fetchTopComments('/r/k/comments/x/')
    expect(result).toBeNull()
  })

  it('returns null when the response body is not an array of length ≥2', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ notAnArray: true }) })
    const source = makeSource()
    const result = await source.fetchTopComments('/r/k/comments/x/')
    expect(result).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'))
    const source = makeSource()
    const result = await source.fetchTopComments('/r/k/comments/x/')
    expect(result).toBeNull()
  })

  it('filters, sorts, and joins the top three non-stickied comments', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        null,
        {
          data: {
            children: [
              { data: { body: 'ok reply', ups: 10, stickied: false } },
              { data: { body: 'best reply', ups: 50, stickied: false } },
              { data: { body: 'ignored — stickied', ups: 999, stickied: true } },
              { data: { body: 'low', ups: 1, stickied: false } },
              { data: { body: 'mid', ups: 20, stickied: false } },
              { data: { body: 'excluded', ups: 5, stickied: false } },
            ],
          },
        },
      ],
    })
    const source = makeSource()
    const result = await source.fetchTopComments('/r/k/comments/x/')
    // Top 3 by ups among non-stickied, ups > 2: best (50), mid (20), ok (10)
    expect(result).toBe('best reply\n\n---\n\nmid\n\n---\n\nok reply')
  })
})
