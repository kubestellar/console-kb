import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StackOverflowSource } from '../../sources/stackoverflow.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const ORIGINAL_FETCH = globalThis.fetch

const PROJECT = {
  name: 'KubeVirt',
  repo: 'kubevirt/kubevirt',
  maturity: 'sandbox',
  category: 'virtualization',
  sources: { stackoverflow: { tags: ['kubernetes', 'kubevirt'] } },
}

const STATE = { lastSearched: '2024-05-01T00:00:00.000Z', processedIds: [], cursor: null }

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIGINAL_ENV[key]
  }
}

describe('StackOverflowSource — branch coverage', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.USE_COPILOT
    delete process.env.COPILOT_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('returns empty items when the tag search HTTP response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const result = await source.search(PROJECT, STATE)
    expect(result.items).toEqual([])
  })

  it('bails out early when Stack Exchange quota is nearly exhausted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ quota_remaining: 5, items: [{ question_id: 1, score: 20, is_answered: true }] }),
    })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const result = await source.search(PROJECT, STATE)
    expect(result.items).toEqual([])
  })

  it('returns empty items when tag-search fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network down'))
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const result = await source.search(PROJECT, STATE)
    expect(result.items).toEqual([])
  })

  it('recovers when the text-fallback response is not ok (keeps tag results)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quota_remaining: 100,
          items: [
            { question_id: 1, score: 20, is_answered: true, title: 'kept' },
            { question_id: 2, score: 5, is_answered: true, title: 'below-min-votes' },
            { question_id: 3, score: 20, is_answered: false, title: 'not-answered' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, STATE)
    expect(result.items.map(i => i.question_id)).toEqual([1])
  })

  it('recovers when the text-fallback fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quota_remaining: 100, items: [{ question_id: 1, score: 20, is_answered: true, title: 'k' }] }),
      })
      .mockRejectedValueOnce(new Error('text search boom'))
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, STATE)
    expect(result.items.map(i => i.question_id)).toEqual([1])
  })

  it('extractMission returns null when no accepted answer is available', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue(null)
    const mission = await source.extractMission(
      { question_id: 9, title: 'q', body: '<p>x</p>', link: 'https://so/9', tags: ['kubernetes'], score: 5 },
      PROJECT,
    )
    expect(mission).toBeNull()
  })

  it('fetchAcceptedAnswer returns null when API returns non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    expect(await source.fetchAcceptedAnswer(1234)).toBeNull()
  })

  it('fetchAcceptedAnswer returns null when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    expect(await source.fetchAcceptedAnswer(1234)).toBeNull()
  })

  it('fetchAcceptedAnswer falls back to top-voted when none is accepted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ is_accepted: false, score: 20, body: 'top' }, { is_accepted: false, score: 10, body: 'lower' }] }),
    })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const a = await source.fetchAcceptedAnswer(77)
    expect(a).toEqual({ is_accepted: false, score: 20, body: 'top' })
  })

  it('fetchAcceptedAnswer returns null when items[] is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    expect(await source.fetchAcceptedAnswer(0)).toBeNull()
  })

  it('extractMission classifies performance tags and picks intermediate/beginner difficulty', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({ body: '<p>tune memory limits</p>', is_accepted: true })
    const beginner = await source.extractMission(
      { question_id: 1, title: 'Slow pods', body: '<p>cpu spikes</p>', link: 'https://so/1', tags: ['kubernetes', 'performance'], score: 5 },
      PROJECT,
    )
    expect(beginner.metadata.issueTypes).toEqual(['performance'])

    const intermediate = await source.extractMission(
      { question_id: 2, title: 'Ingress DNS troubles', body: '<p>x</p>', link: 'https://so/2', tags: ['kubernetes', 'networking'], score: 25 },
      PROJECT,
    )
    expect(intermediate.metadata.issueTypes).toEqual(['networking'])
  })

  it('extractMission defaults to troubleshooting for unrecognized tags', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({ body: '<p>just docs</p>', is_accepted: true })
    const mission = await source.extractMission(
      { question_id: 3, title: 'Question', body: '<p>x</p>', link: 'https://so/3', tags: ['docs', 'help'], score: 12 },
      PROJECT,
    )
    expect(mission.metadata.issueTypes).toEqual(['troubleshooting'])
  })
})
