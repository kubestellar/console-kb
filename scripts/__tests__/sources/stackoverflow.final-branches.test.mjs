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

describe('StackOverflowSource — final uncovered branches', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  // Line 80 FALSE arm: `if (items.length < 3)` — tag search already returned
  // >=3 items, so text-fallback path is skipped entirely.
  it('skips text-fallback when tag search already returned >=3 items', async () => {
    const state = { processedIds: [], cursor: null }
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
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
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, state)
    // Only one fetch call — text fallback URL never issued.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(result.items.map(i => i.question_id)).toEqual([1, 2, 3])
  })

  // Line 99 TRUE arm: text-fallback `if (q.score < this.minVotes) continue`
  it('text fallback skips items with score below minVotes', async () => {
    const state = { processedIds: [], cursor: null }
    globalThis.fetch = vi.fn()
      // Tag search returns nothing so fallback fires.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quota_remaining: 100, items: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            // Below minVotes=10 — must be skipped.
            { question_id: 100, score: 5, is_answered: true, title: 'low-votes' },
            // Above minVotes — must be kept.
            { question_id: 101, score: 20, is_answered: true, title: 'ok' },
          ],
        }),
      })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, state)
    expect(result.items.map(i => i.question_id)).toEqual([101])
  })

  // Line 100 TRUE arm: text-fallback `if (!q.is_answered) continue`
  it('text fallback skips items that are not answered', async () => {
    const state = { processedIds: [], cursor: null }
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ quota_remaining: 100, items: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            // Meets minVotes but unanswered — must be skipped.
            { question_id: 200, score: 20, is_answered: false, title: 'unanswered' },
            // Meets both — must be kept.
            { question_id: 201, score: 20, is_answered: true, title: 'answered' },
          ],
        }),
      })
    const source = new StackOverflowSource({ rateLimitDelay: 0, minVotes: 10 })
    const result = await source.search(PROJECT, state)
    expect(result.items.map(i => i.question_id)).toEqual([201])
  })
})
