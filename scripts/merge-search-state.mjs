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
import { readdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { mergeSearchStates } from './lib/search-state-merge.mjs'

// Best-effort: append a warning to the GitHub Actions job summary so a
// self-healed corrupt base is visible in the run's UI, not just in raw logs.
// GITHUB_STEP_SUMMARY is a runner-provided env var available to every step
// without any .github/workflows/*.yml change — see
// https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary.
// Note the preserved `search-state.json.corrupt-<ts>` file itself is NOT
// retrievable after this: it lives only on the ephemeral runner's
// filesystem, is never uploaded as a workflow artifact, and is gone once
// the job ends — this summary line is the only surviving detection signal.
function postSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  try {
    appendFileSync(summaryPath, `${message}\n`)
  } catch (_) {
    // Non-fatal: summary is a detection aid, not required for the merge itself.
  }
}

function main() {
  let baseState = null
  if (existsSync('search-state.json')) {
    try {
      baseState = JSON.parse(readFileSync('search-state.json', 'utf8'))
    } catch (e) {
      // Base state is corrupt. The previous behaviour was to exit(1), which
      // permanently broke the scheduled cncf-mission-gen workflow (see
      // kubestellar/console-kb#3197 discussion and the daily run failure on
      // 2026-09-27) until a human hand-edited the file on master.
      //
      // Batch files already self-heal on parse errors (warn + continue). Do
      // the same for the base: preserve the corrupt file on disk under a
      // timestamped name (best-effort — this copy does not survive the
      // runner and is not the detection mechanism, see postSummary above),
      // log loudly to stderr, post a job-summary warning, and treat
      // baseState as empty so incoming batches still merge. The
      // corrupt-<ts> file is NOT staged by cncf-mission-gen.yml's "Commit
      // search state" step (it only `git add search-state.json`), so it
      // stays out of the repo history.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const preserved = `search-state.json.corrupt-${stamp}`
      try {
        renameSync('search-state.json', preserved)
      } catch (_) {
        // Non-fatal: if we can't preserve it we still continue with empty base.
      }
      console.error(
        `Error parsing search-state.json: ${e.message} — treating base as empty and continuing (preserved to ${preserved})`,
      )
      postSummary(
        `### ⚠️ search-state.json self-healed from corrupt base\n\n` +
          `\`search-state.json\` failed to parse (\`${e.message}\`). The merge ` +
          `continued with an empty base state — this run's incoming batches ` +
          `were still recorded, but any dedup history from before this run ` +
          `was dropped. See ` +
          `[runbooks/incident-response-search-state-corruption.md](https://github.com/kubestellar/console-kb/blob/master/runbooks/incident-response-search-state-corruption.md).`,
      )
      baseState = null
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
