import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  computeSinceDate,
  getSourceState,
  isProcessed,
  loadSearchState,
  saveSearchState,
  updateSourceState,
} from '../../sources/search-state.mjs'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PREFIX = join(TESTS_DIR, 'search-state-fixture-')
const STATE_FILE = 'search-state.json'
const FIXED_NOW = new Date('2024-05-10T12:00:00.000Z')

let fixtureDir

describe('search-state', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(FIXTURE_PREFIX)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (fixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true })
      fixtureDir = null
    }
  })

  it('returns an empty state when no persisted file exists', () => {
    const state = loadSearchState(fixtureDir)

    expect(state).toEqual({
      version: 1,
      lastUpdated: null,
      projects: {},
    })
    expect(getSourceState(state, 'kubernetes/kubernetes', 'reddit')).toEqual({
      lastSearched: null,
      processedIds: [],
      cursor: null,
    })
  })

  it('persists project state and deduplicates processed IDs per source', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)

    const state = loadSearchState(fixtureDir)
    updateSourceState(state, 'kubernetes/kubernetes', 'reddit', ['reddit:1', 'reddit:1', 'reddit:2'], 'cursor-1')
    updateSourceState(state, 'kubestellar/console', 'reddit', ['reddit:3'], null)
    updateSourceState(state, 'kubernetes/kubernetes', 'stackoverflow', ['so:7'], 'cursor-2')
    saveSearchState(state, fixtureDir)

    const persisted = JSON.parse(readFileSync(join(fixtureDir, STATE_FILE), 'utf-8'))
    expect(persisted.lastUpdated).toBe(FIXED_NOW.toISOString())

    const reloaded = loadSearchState(fixtureDir)
    expect(getSourceState(reloaded, 'kubernetes/kubernetes', 'reddit')).toEqual({
      lastSearched: FIXED_NOW.toISOString(),
      processedIds: ['reddit:1', 'reddit:2'],
      cursor: 'cursor-1',
    })
    expect(getSourceState(reloaded, 'kubestellar/console', 'reddit').processedIds).toEqual(['reddit:3'])
    expect(getSourceState(reloaded, 'kubernetes/kubernetes', 'stackoverflow')).toEqual({
      lastSearched: FIXED_NOW.toISOString(),
      processedIds: ['so:7'],
      cursor: 'cursor-2',
    })
    expect(isProcessed(reloaded, 'kubernetes/kubernetes', 'reddit', 'reddit:2')).toBe(true)
    expect(isProcessed(reloaded, 'kubernetes/kubernetes', 'reddit', 'reddit:missing')).toBe(false)
  })

  it('repairs malformed files by warning and starting fresh', () => {
    writeFileSync(join(fixtureDir, STATE_FILE), '{not valid json\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const state = loadSearchState(fixtureDir)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not parse search-state.json'))
    expect(state.projects).toEqual({})
    expect(state.version).toBe(1)
  })

  it('computes incremental since dates from either last search time or the search window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)

    expect(computeSinceDate({ lastSearched: '2024-05-01T00:00:00.000Z' }, '90d')).toBe('2024-05-01T00:00:00.000Z')
    expect(computeSinceDate({ lastSearched: null }, '30d')).toBe('2024-04-10T12:00:00.000Z')
    expect(computeSinceDate({ lastSearched: null }, 'not-a-window')).toBeNull()
  })
})
