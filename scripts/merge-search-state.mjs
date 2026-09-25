#!/usr/bin/env node
/**
 * CLI entry point for the "Merge search state files" step of
 * .github/workflows/cncf-mission-gen.yml (see kubestellar/console-kb#3197).
 *
 * Reads search-state.json (if present) plus any per-batch
 * search-state-<N>.json files in the current directory, deep-merges them
 * by project/source, and writes the result back to search-state.json.
 *
 * All I/O lives here; the merge algorithm itself is in
 * lib/search-state-merge.mjs so it can be unit-tested directly.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { mergeSearchStates } from './lib/search-state-merge.mjs'

function main() {
  let baseState = null
  if (existsSync('search-state.json')) {
    try {
      baseState = JSON.parse(readFileSync('search-state.json', 'utf8'))
    } catch (e) {
      console.error(`Error parsing search-state.json: ${e.message}`)
      process.exit(1)
    }
  }

  const batchFiles = readdirSync('.').filter((f) => /^search-state-\d+\.json$/.test(f))
  const batchStates = []
  for (const f of batchFiles) {
    try {
      batchStates.push(JSON.parse(readFileSync(f, 'utf8')))
    } catch (e) {
      console.warn(`Error merging ${f}: ${e.message}`)
    }
  }

  const merged = mergeSearchStates(baseState, batchStates)
  writeFileSync('search-state.json', JSON.stringify(merged, null, 2))
  console.log(`Merged search state: ${Object.keys(merged.projects).length} projects`)
}

main()
