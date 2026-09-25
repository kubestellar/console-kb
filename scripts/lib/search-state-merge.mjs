/**
 * Pure deep-merge logic for CNCF mission search-state batch artifacts.
 *
 * Extracted from the "Merge search state files" step of
 * .github/workflows/cncf-mission-gen.yml (see kubestellar/console-kb#3197)
 * so the merge algorithm can be unit-tested without shelling out to `node -e`.
 */

/**
 * Deep-merge one batch's `projects` map into an accumulator, combining
 * per-source `processedIds` (deduped) and taking the most recent
 * `lastSearched`/`cursor` values present in the batch.
 *
 * @param {object} merged - accumulator with a `projects` map (mutated and returned)
 * @param {object} batch - parsed batch search-state.json contents
 * @returns {object} the same `merged` object, updated in place
 */
export function mergeProjectsInto(merged, batch) {
  for (const [repo, sources] of Object.entries(batch.projects || {})) {
    if (!merged.projects[repo]) merged.projects[repo] = {}
    for (const [srcId, srcData] of Object.entries(sources)) {
      const existing = merged.projects[repo][srcId] || { processedIds: [] }
      if (Object.prototype.hasOwnProperty.call(srcData, 'lastSearched')) {
        existing.lastSearched = srcData.lastSearched
      }
      if (Object.prototype.hasOwnProperty.call(srcData, 'cursor')) {
        existing.cursor = srcData.cursor
      }
      const ids = new Set([...(existing.processedIds || []), ...(srcData.processedIds || [])])
      existing.processedIds = [...ids]
      merged.projects[repo][srcId] = existing
    }
  }
  return merged
}

/**
 * Merge a base search-state object with any number of batch search-state
 * objects, returning a fresh merged state (does not mutate inputs).
 *
 * @param {object|null} baseState - existing search-state.json contents, or null
 * @param {object[]} batchStates - parsed batch-*.json contents, in any order
 * @param {() => string} [now] - injectable clock for `lastUpdated`, for tests
 * @returns {object} merged state: { version, lastUpdated, projects }
 */
export function mergeSearchStates(baseState, batchStates, now = () => new Date().toISOString()) {
  const merged = { version: 1, lastUpdated: now(), projects: {} }
  if (baseState && typeof baseState === 'object') {
    Object.assign(merged, structuredClone(baseState))
    merged.projects = merged.projects || {}
  }
  for (const batch of batchStates) {
    if (batch && typeof batch === 'object') {
      mergeProjectsInto(merged, batch)
    }
  }
  merged.lastUpdated = now()
  return merged
}
