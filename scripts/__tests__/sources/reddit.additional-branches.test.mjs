// Additional branch coverage for scripts/sources/reddit.mjs.
//
// Existing reddit.test.mjs + reddit.branches.test.mjs cover the happy
// search path, the non-ok / thrown fetch skips, the maxPerProject cap
// on the inner term loop, and the top-3 comments join. This module
// targets the branches those tests still miss:
//
//   - line  23 : canonicalId falls back to `item.id` when data.id
//                is absent (via processedIds dedup path)
//   - line  34 : the OUTER subreddit-loop `maxPerProject` break
//                (previous test only exercises the inner one)
//   - line  37 : the INNER term-loop `maxPerProject` break with
//                multiple search terms (project.aliases populated)
//   - line  58 : data?.data?.children fallback to []
//   - line  62 : ups < minUpvotes filter drops the post
//   - line  68 : sinceDate branch + postDate<sinceDate drop
//   - line  94 : processedIds.includes(cid) short-circuit
//   - line 146 : data[1]?.data?.children fallback to []
//   - line 153 : topComments.join(...) || null right-arm (empty)
//   - line 194/195 : detectType default 'troubleshooting'
//   - line 210 : extractSteps bullets falsy arm (no bullets, no
//                numbered)
//
// All tests are external (public-API only): search(), extractMission(),
// fetchTopComments().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditSource } from '../../sources/reddit.mjs'

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
  return new RedditSource({
    rateLimitDelay: 0,
    subreddits: ['kubernetes'],
    minUpvotes: 5,
    ...overrides,
  })
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

describe('RedditSource.search — outer/inner break and filter arms', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('breaks the OUTER subreddit loop once maxPerProject is reached (line 34)', async () => {
    // Two subreddits, first fills the cap; second must not be fetched at all.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { children: [mkPost({ id: 'a' }), mkPost({ id: 'b' })] },
      }),
    })
    const source = makeSource({
      subreddits: ['kubernetes', 'devops'],
      maxPerProject: 2,
    })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toHaveLength(2)
    // The outer break must prevent a second subreddit call.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/r/kubernetes/')
  })

  it('breaks the INNER searchTerm loop with multiple aliases (line 37)', async () => {
    // One subreddit but multiple search terms via aliases; the first
    // term fills the cap so the second alias must not be queried.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { children: [mkPost({ id: 'x' }), mkPost({ id: 'y' })] },
      }),
    })
    const source = makeSource({ subreddits: ['kubernetes'], maxPerProject: 2 })
    const project = { ...TEST_PROJECT, aliases: ['argo', 'argocd'] }
    const result = await source.search(project, EMPTY_STATE)
    expect(result.items).toHaveLength(2)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    // Only the first term (project.name) must appear in the URL query.
    expect(globalThis.fetch.mock.calls[0][0]).toContain(encodeURIComponent('Argo CD'))
  })

  it('handles a payload with no data.children (falls back to [])', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: null }),
    })
    const source = makeSource()
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
  })

  it('drops posts whose ups fall below minUpvotes (line 62)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            mkPost({ id: 'lo', ups: 1 }),
            mkPost({ id: 'hi', ups: 100 }),
          ],
        },
      }),
    })
    const source = makeSource({ minUpvotes: 10 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items.map(i => i.data.id)).toEqual(['hi'])
  })

  it('drops posts older than the search window (line 68 sinceDate arm)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = now - 60 * 60 * 24 * 365 * 3 // 3 years ago
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            mkPost({ id: 'old', created_utc: old }),
            mkPost({ id: 'new', created_utc: now }),
          ],
        },
      }),
    })
    const source = makeSource({ searchWindow: '90d' })
    const state = {
      lastSearched: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      processedIds: [],
      cursor: null,
    }
    const result = await source.search(TEST_PROJECT, state)
    // Only recent posts survive.
    expect(result.items.every(i => i.data.created_utc >= old + 1)).toBe(true)
    expect(result.items.map(i => i.data.id)).not.toContain('old')
  })

  it('skips items whose canonicalId is already in processedIds (line 94)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [mkPost({ id: 'seen' }), mkPost({ id: 'fresh' })],
        },
      }),
    })
    const source = makeSource()
    const state = { lastSearched: null, processedIds: ['reddit:seen'], cursor: null }
    const result = await source.search(TEST_PROJECT, state)
    expect(result.items.map(i => i.data.id)).toEqual(['fresh'])
  })
})

describe('RedditSource.canonicalId — id-fallback branch (line 23)', () => {
  it('falls back to item.id when data.id is missing', () => {
    const source = makeSource()
    // Neither branch: post shaped like the outer-Reddit response wrapper
    // where the id sits directly on the object rather than data.
    expect(source.canonicalId({ id: 'top-level' })).toBe('reddit:top-level')
    // Also verify the primary arm still works.
    expect(source.canonicalId({ data: { id: 'nested' } })).toBe('reddit:nested')
  })
})

describe('RedditSource.fetchTopComments — extra shape and empty-result arms', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('returns null when the reply has no children (line 146 fallback)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [null, { data: null }],
    })
    const source = makeSource()
    const result = await source.fetchTopComments('/r/k/comments/x/')
    expect(result).toBeNull()
  })

  it('returns null when every comment is stickied or below the ups floor (line 153 right arm)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        null,
        {
          data: {
            children: [
              { data: { body: 'pinned', ups: 999, stickied: true } },
              { data: { body: 'weak', ups: 1, stickied: false } },
              { data: { body: '', ups: 50, stickied: false } },
            ],
          },
        },
      ],
    })
    const source = makeSource()
    const result = await source.fetchTopComments('/r/k/comments/x/')
    expect(result).toBeNull()
  })
})

describe('RedditSource.extractMission — detectType default and no-steps arms', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('falls through to detectType default "troubleshooting" (line 194/195)', async () => {
    // Body/title/solution contain none of the keywords for the four
    // labelled arms (no error/crash/fail, no how to/best/recommend,
    // no performance/slow/latency, no security/rbac/tls).
    const source = makeSource()
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue('some benign helpful reply')
    const bodyText = 'the pod runs cleanly with kubectl and returns green output'.repeat(3)
    const mission = await source.extractMission({
      data: {
        title: 'benign pod tips',
        selftext: bodyText,
        permalink: '/r/k/',
      },
    }, TEST_PROJECT)
    expect(mission).not.toBeNull()
    expect(mission.mission.type).toBe('troubleshooting')
  })

  it('returns an empty steps array when the solution has neither numbered list nor bullets (line 210 falsy arm)', async () => {
    const source = makeSource()
    // Solution is prose; no `\d+[.)] ` and no leading `-`/`*` bullets.
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue('this is one long paragraph with no lists at all — just prose describing an outcome')
    const long = 'The pod exhibits a transient hiccup during scale-up '.repeat(4)
    const mission = await source.extractMission({
      data: {
        title: 'scaling scenario',
        selftext: long,
        permalink: '/r/k/',
      },
    }, TEST_PROJECT)
    expect(mission).not.toBeNull()
    expect(mission.mission.steps ?? []).toEqual([])
  })
})
