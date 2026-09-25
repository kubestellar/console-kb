import { describe, it, expect } from 'vitest'
import { mergeProjectsInto, mergeSearchStates } from '../lib/search-state-merge.mjs'

describe('mergeProjectsInto', () => {
  it('creates a new project entry when the accumulator has none', () => {
    const merged = { projects: {} }
    mergeProjectsInto(merged, {
      projects: { 'kubestellar/kubestellar': { reddit: { lastSearched: '2024-01-01T00:00:00Z', cursor: 'c1', processedIds: ['a', 'b'] } } },
    })
    expect(merged.projects['kubestellar/kubestellar'].reddit.processedIds).toEqual(['a', 'b'])
    expect(merged.projects['kubestellar/kubestellar'].reddit.cursor).toBe('c1')
  })

  it('dedupes processedIds across repeated merges of the same source', () => {
    const merged = { projects: { repo: { reddit: { processedIds: ['a', 'b'], lastSearched: null, cursor: null } } } }
    mergeProjectsInto(merged, { projects: { repo: { reddit: { processedIds: ['b', 'c'] } } } })
    expect(merged.projects.repo.reddit.processedIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps existing lastSearched/cursor when the batch does not provide them', () => {
    const merged = { projects: { repo: { reddit: { processedIds: ['a'], lastSearched: '2024-01-01T00:00:00Z', cursor: 'keep-me' } } } }
    mergeProjectsInto(merged, { projects: { repo: { reddit: { processedIds: ['b'] } } } })
    expect(merged.projects.repo.reddit.lastSearched).toBe('2024-01-01T00:00:00Z')
    expect(merged.projects.repo.reddit.cursor).toBe('keep-me')
  })

  it('overwrites lastSearched/cursor when the batch provides newer values', () => {
    const merged = { projects: { repo: { reddit: { processedIds: [], lastSearched: '2024-01-01T00:00:00Z', cursor: 'old' } } } }
    mergeProjectsInto(merged, { projects: { repo: { reddit: { lastSearched: '2024-06-01T00:00:00Z', cursor: 'new', processedIds: [] } } } })
    expect(merged.projects.repo.reddit.lastSearched).toBe('2024-06-01T00:00:00Z')
    expect(merged.projects.repo.reddit.cursor).toBe('new')
  })

  it('honors explicit null cursor/lastSearched values from the batch', () => {
    const merged = { projects: { repo: { reddit: { processedIds: [], lastSearched: '2024-01-01T00:00:00Z', cursor: 'stale' } } } }
    mergeProjectsInto(merged, { projects: { repo: { reddit: { lastSearched: null, cursor: null, processedIds: [] } } } })
    expect(merged.projects.repo.reddit.lastSearched).toBeNull()
    expect(merged.projects.repo.reddit.cursor).toBeNull()
  })

  it('handles a batch with no projects gracefully', () => {
    const merged = { projects: { repo: { reddit: { processedIds: ['a'] } } } }
    mergeProjectsInto(merged, {})
    expect(merged.projects.repo.reddit.processedIds).toEqual(['a'])
  })

  it('adds independent sources for the same repo without clobbering each other', () => {
    const merged = { projects: { repo: { reddit: { processedIds: ['a'] } } } }
    mergeProjectsInto(merged, { projects: { repo: { stackoverflow: { processedIds: ['x'] } } } })
    expect(merged.projects.repo.reddit.processedIds).toEqual(['a'])
    expect(merged.projects.repo.stackoverflow.processedIds).toEqual(['x'])
  })
})

describe('mergeSearchStates', () => {
  const fixedNow = () => '2024-12-25T00:00:00.000Z'

  it('starts from an empty state when baseState is null', () => {
    const result = mergeSearchStates(null, [], fixedNow)
    expect(result.version).toBe(1)
    expect(result.projects).toEqual({})
    expect(result.lastUpdated).toBe(fixedNow())
  })

  it('preserves projects already present in baseState', () => {
    const base = { version: 1, projects: { repo: { reddit: { processedIds: ['a'] } } } }
    const result = mergeSearchStates(base, [], fixedNow)
    expect(result.projects.repo.reddit.processedIds).toEqual(['a'])
  })

  it('merges multiple batch states in order without mutating the inputs', () => {
    const base = { version: 1, projects: { repo: { reddit: { processedIds: ['a'] } } } }
    const batch1 = { projects: { repo: { reddit: { processedIds: ['b'] } } } }
    const batch2 = { projects: { repo: { stackoverflow: { processedIds: ['x'] } } } }

    const result = mergeSearchStates(base, [batch1, batch2], fixedNow)

    expect(result.projects.repo.reddit.processedIds.sort()).toEqual(['a', 'b'])
    expect(result.projects.repo.stackoverflow.processedIds).toEqual(['x'])
    // Inputs must be untouched
    expect(base.projects.repo.reddit.processedIds).toEqual(['a'])
    expect(batch1.projects.repo.reddit.processedIds).toEqual(['b'])
  })

  it('skips null/non-object batch entries without throwing', () => {
    const result = mergeSearchStates(null, [null, undefined, {}], fixedNow)
    expect(result.projects).toEqual({})
  })

  it('sets lastUpdated to the injected clock value', () => {
    const result = mergeSearchStates(null, [], fixedNow)
    expect(result.lastUpdated).toBe('2024-12-25T00:00:00.000Z')
  })
})
