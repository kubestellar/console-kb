import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StackOverflowSource } from '../../sources/stackoverflow.mjs'

const ORIGINAL_FETCH = globalThis.fetch

const BARE_PROJECT = {
  name: 'kubevirt',
  repo: 'kubevirt/kubevirt',
  maturity: 'sandbox',
  category: 'virtualization',
}

const FRESH_STATE = { lastSearched: null, processedIds: [], cursor: null }

describe('StackOverflowSource — default-fallback branches', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('search uses [project.name] tags fallback and 365-day fromDate default when sourceState + searchWindow are unset', async () => {
    // searchWindow "x" is truthy (so not replaced by "90d") but does not match \d+d, forcing
    // computeSinceDate() -> null, which drives the `Math.floor((Date.now() - 365d)/1000)` branch.
    const source = new StackOverflowSource({ rateLimitDelay: 0, searchWindow: 'x' })
    const seenUrls = []
    globalThis.fetch = vi.fn().mockImplementation(url => {
      seenUrls.push(url)
      return Promise.resolve({ ok: true, json: async () => ({ quota_remaining: 500 }) })
    })
    const result = await source.search(BARE_PROJECT, FRESH_STATE)
    expect(result.items).toEqual([])
    // Tag fallback: project.name only, no explicit stackoverflow tag list.
    expect(seenUrls[0]).toContain(`tagged=${encodeURIComponent('kubevirt')}`)
    // fromDate is roughly 365 days ago (allow ±1 day slack for clock drift / calendar math).
    const nowSec = Math.floor(Date.now() / 1000)
    const oneYearAgo = nowSec - 365 * 24 * 60 * 60
    const match = seenUrls[0].match(/fromdate=(\d+)/)
    expect(match).not.toBeNull()
    expect(Math.abs(parseInt(match[1], 10) - oneYearAgo)).toBeLessThan(2 * 24 * 60 * 60)
  })

  it('search tolerates a tag-search response missing an items array (data.items || []) and still runs the text fallback with the same guard', async () => {
    // Both fetches return no `items` field at all — exercises `data.items || []` on both paths.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ quota_remaining: 500 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    const project = { name: 'kubevirt', sources: { stackoverflow: { tags: ['kubernetes'] } } }
    const result = await source.search(project, { lastSearched: '2025-01-01T00:00:00Z', processedIds: [], cursor: null })
    expect(result.items).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('extractMission uses all default fallbacks when item fields (title/body/link/tags) are absent and the answer has no body', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    // Answer object present but WITHOUT a `body` field — hits the three `answer.body || ''` fallbacks
    // in stripHtml/extractHtmlCodeBlocks/extractStepsFromHtml call sites.
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({ is_accepted: true })
    const item = { question_id: 42, score: 3 } // no title, body, link, or tags
    const mission = await source.extractMission(item, { name: 'kubevirt', category: 'virtualization' })
    // Should still produce a mission object rather than throwing on undefined property accesses;
    // reaching this line proves the item.title/body/link/tags AND the answer.body default fallbacks
    // all executed without throwing.
    expect(mission).toBeTruthy()
    // The default title "Stack Overflow Q&A" flows into slug generation.
    expect(mission.name).toContain('stack-overflow')
    // The default link fallback URL is recorded somewhere in the mission's source metadata.
    expect(JSON.stringify(mission)).toContain('stackoverflow.com/q/42')
  })

  it('fetchAcceptedAnswer returns null when the API returns no items[] field (data.items || [] fallback)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    expect(await source.fetchAcceptedAnswer(999)).toBeNull()
  })
})
