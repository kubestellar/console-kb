/**
 * Search state ledger — tracks which items have been processed per project per source.
 * Committed to the repo so state persists across workflow runs.
 *
 * Schema:
 *   { lastUpdated, projects: { "owner/repo": { "source-id": { lastSearched, processedIds, cursor } } } }
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const STATE_FILE = 'search-state.json'

const EMPTY_STATE = {
  version: 1,
  lastUpdated: null,
  projects: {},
}

/**
 * Load search state from disk. Returns empty state if file doesn't exist.
 */
export function loadSearchState(baseDir = process.cwd()) {
  const path = join(baseDir, STATE_FILE)
  if (!existsSync(path)) return structuredClone(EMPTY_STATE)
  try {
    const raw = readFileSync(path, 'utf-8')
    const state = JSON.parse(raw)
    if (!state.version) state.version = 1
    if (!state.projects) state.projects = {}
    return state
  } catch (err) {
    console.warn(`Warning: Could not parse ${STATE_FILE}, starting fresh: ${err.message}`)
    return structuredClone(EMPTY_STATE)
  }
}

/**
 * Save search state to disk.
 */
export function saveSearchState(state, baseDir = process.cwd()) {
  state.lastUpdated = new Date().toISOString()
  const path = join(baseDir, STATE_FILE)
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

/**
 * Get the source state for a specific project + source combo.
 * Returns { lastSearched, processedIds, cursor } or defaults.
 */
export function getSourceState(state, projectRepo, sourceId) {
  const proj = state.projects[projectRepo]
  if (!proj || !proj[sourceId]) {
    return { lastSearched: null, processedIds: [], cursor: null }
  }
  const s = proj[sourceId]
  return {
    lastSearched: s.lastSearched || null,
    processedIds: s.processedIds || [],
    cursor: s.cursor || null,
  }
}

/**
 * Update source state after processing a batch of items.
 * @param {string[]} newIds - Canonical IDs of newly processed items
 * @param {string|null} cursor - Pagination cursor for next run
 */
export function updateSourceState(state, projectRepo, sourceId, newIds, cursor = null) {
  if (!state.projects[projectRepo]) {
    state.projects[projectRepo] = {}
  }
  const existing = state.projects[projectRepo][sourceId] || {
    lastSearched: null,
    processedIds: [],
    cursor: null,
  }
  existing.lastSearched = new Date().toISOString()
  existing.processedIds = [...new Set([...existing.processedIds, ...newIds])]
  existing.cursor = cursor
  state.projects[projectRepo][sourceId] = existing
}

/**
 * Check if a canonical ID has already been processed.
 */
export function isProcessed(state, projectRepo, sourceId, canonicalId) {
  const s = getSourceState(state, projectRepo, sourceId)
  return s.processedIds.includes(canonicalId)
}

/**
 * Compute a "since" date from lastSearched, or null for a full scan.
 * @param {object} sourceState - from getSourceState()
 * @param {string} searchWindow - e.g. "90d", "180d", "365d"
 * @returns {string|null} ISO date string for incremental search, or null
 */
export function computeSinceDate(sourceState, searchWindow) {
  if (sourceState.lastSearched) {
    return sourceState.lastSearched
  }
  // First run: use searchWindow to limit how far back we go
  if (searchWindow) {
    const match = searchWindow.match(/^(\d+)d$/)
    if (match) {
      const days = parseInt(match[1], 10)
      const since = new Date()
      since.setDate(since.getDate() - days)
      return since.toISOString()
    }
  }
  return null
}
