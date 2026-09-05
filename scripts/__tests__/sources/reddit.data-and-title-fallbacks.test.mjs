// Additional branch coverage for scripts/sources/reddit.mjs — arms not
// exercised by any existing test file:
//
//   - line 62 : `if (!d) continue`  — the post.data-falsy skip arm
//               (previously only the else-arm was taken)
//   - line 93 : `d.title || 'Reddit discussion'` right-arm fallback in
//               extractMission (previously only d.title-truthy path taken)
//
// Both are defensive guards. Line 62 protects against malformed Reddit
// API payloads where a `children[]` element lacks a `data` field
// (observed in cross-post announcements + removed-mod-post envelopes).
// Line 93 keeps extractMission from emitting a mission with an empty
// title when Reddit hands us a post that has a body but no title
// (rare, but happens for certain deleted-then-restored posts and for
// posts scraped from mobile clients that omit the title field).

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

describe('RedditSource.search — !d skip arm (line 62)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('skips a children[] element whose data field is null/undefined without throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            // Both shapes exercise `const d = post.data; if (!d) continue`:
            // - data: null (explicit null)
            // - the element itself is a bare object with no `data` key
            { data: null },
            {},
            // One well-formed post so we can assert only the good one survived.
            {
              data: {
                id: 'ok',
                title: 'Argo CD topic',
                ups: 50,
                removed_by_category: null,
                over_18: false,
                created_utc: Date.now() / 1000,
                permalink: '/r/kubernetes/comments/ok/',
                selftext: '',
              },
            },
          ],
        },
      }),
    })
    const source = makeSource()
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].data.id).toBe('ok')
  })
})

describe('RedditSource.extractMission — title fallback (line 93)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('falls back to the literal "Reddit discussion" when d.title is missing', async () => {
    const source = makeSource()
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue(
      'a benign helpful reply describing a fix' + ' with padding'.repeat(6)
    )
    const long = 'The pod runs cleanly and does the expected thing '.repeat(4)
    // Deliberately omit `title` so `d.title || 'Reddit discussion'` takes
    // its right arm. cleanTitle() strips a leading "[tag] " prefix and a
    // trailing "?" — the fallback string has neither so it survives verbatim.
    const mission = await source.extractMission({
      data: {
        selftext: long,
        permalink: '/r/kubernetes/comments/x/',
      },
    }, TEST_PROJECT)
    expect(mission).not.toBeNull()
    expect(mission.mission.title).toBe('Argo CD: Reddit discussion')
  })

  it('preserves d.title when it is a non-empty string (baseline assertion for the arm)', async () => {
    const source = makeSource()
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue(
      'another benign helpful reply with a clear tip' + ' padding'.repeat(6)
    )
    const long = 'Deployment stalls occasionally in this scenario '.repeat(4)
    const mission = await source.extractMission({
      data: {
        title: 'A real title here',
        selftext: long,
        permalink: '/r/kubernetes/comments/y/',
      },
    }, TEST_PROJECT)
    expect(mission).not.toBeNull()
    expect(mission.mission.title).toBe('Argo CD: A real title here')
  })
})
