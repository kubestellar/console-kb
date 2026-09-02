import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StackOverflowSource } from '../../sources/stackoverflow.mjs'

const ORIGINAL_FETCH = globalThis.fetch

const PROJECT = {
  name: 'KubeVirt',
  repo: 'kubevirt/kubevirt',
  maturity: 'sandbox',
  category: 'virtualization',
  sources: { stackoverflow: { tags: ['kubernetes', 'kubevirt'] } },
}

describe('StackOverflowSource — remaining branch arms', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  // Tag-search loop: `processedIds.includes(cid)` continue arm
  it('tag search skips items whose canonicalId is already in processedIds', async () => {
    const state = { processedIds: ['so:42'], cursor: null }
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        quota_remaining: 100,
        items: [
          { question_id: 42, score: 20, is_answered: true, title: 'already-seen' },
          { question_id: 43, score: 20, is_answered: true, title: 'fresh' },
        ],
      }),
    })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quota_remaining: 100,
          items: [
            { question_id: 42, score: 20, is_answered: true, title: 'already-seen' },
            { question_id: 43, score: 20, is_answered: true, title: 'fresh' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    const result = await source.search(PROJECT, state)
    expect(result.items.map(i => i.question_id)).toEqual([43])
  })

  // Tag-search loop: `items.length >= this.maxPerProject` break
  it('tag search stops accumulating once maxPerProject is reached', async () => {
    const state = { processedIds: [], cursor: null }
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quota_remaining: 100,
          items: [
            { question_id: 1, score: 20, is_answered: true, title: 'a' },
            { question_id: 2, score: 20, is_answered: true, title: 'b' },
            { question_id: 3, score: 20, is_answered: true, title: 'c' },
          ],
        }),
      })
    // Only maxPerProject=2 means fallback (items.length < 3) also runs; mock a 2nd empty ok response.
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10, maxPerProject: 2 })
    const result = await source.search(PROJECT, state)
    expect(result.items.map(i => i.question_id)).toEqual([1, 2])
  })

  // Text-fallback loop: `existingIds.has(q.question_id)` continue arm
  it('text fallback skips items already collected during tag search', async () => {
    const state = { processedIds: [], cursor: null }
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quota_remaining: 100,
          items: [{ question_id: 1, score: 20, is_answered: true, title: 'from-tag' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            // Same question_id as the tag search — must be skipped by existingIds guard.
            { question_id: 1, score: 30, is_answered: true, title: 'dupe' },
            { question_id: 2, score: 20, is_answered: true, title: 'unique' },
          ],
        }),
      })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, state)
    // items[0] from tag search; items[1] from text fallback, id=2 (id=1 skipped as dupe).
    expect(result.items.map(i => i.question_id)).toEqual([1, 2])
  })

  // Text-fallback loop: `processedIds.includes(cid)` continue arm — path 99-100 twin
  it('text fallback skips items whose canonicalId is in processedIds', async () => {
    const state = { processedIds: ['so:9'], cursor: null }
    globalThis.fetch = vi.fn()
      // Tag search returns 0 items (score below minVotes) so fallback fires.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quota_remaining: 100, items: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { question_id: 9, score: 20, is_answered: true, title: 'already-seen' },
            { question_id: 10, score: 20, is_answered: true, title: 'fresh' },
          ],
        }),
      })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, state)
    expect(result.items.map(i => i.question_id)).toEqual([10])
  })

  // Text-fallback loop: `items.length >= this.maxPerProject` break — line 104
  it('text fallback stops accumulating once maxPerProject is reached', async () => {
    const state = { processedIds: [], cursor: null }
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quota_remaining: 100,
          items: [{ question_id: 1, score: 20, is_answered: true, title: 'from-tag' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { question_id: 2, score: 20, is_answered: true, title: 'a' },
            { question_id: 3, score: 20, is_answered: true, title: 'b' },
          ],
        }),
      })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10, maxPerProject: 2 })
    const result = await source.search(PROJECT, state)
    expect(result.items.map(i => i.question_id)).toEqual([1, 2])
  })
})
