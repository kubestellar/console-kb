#!/usr/bin/env node
/**
 * CLI entry point for the "Score and auto-merge passing mission PRs" step of
 * .github/workflows/cncf-mission-gen.yml (see kubestellar/console-kb#3197).
 *
 * Lists open cncf-mission-gen PRs, scores each one's mission JSON, and
 * merges those that pass the quality threshold *and* the required status
 * checks (mission safety scan + schema validation) — closing the gap where
 * `gh pr merge --admin` would otherwise bypass branch protection regardless
 * of check outcome (see #3157).
 *
 * Uses execFileSync with argument arrays (not string-interpolated execSync)
 * so PR titles/numbers/branch names can never be interpreted as shell
 * metacharacters.
 */
import { execFileSync } from 'child_process'
import { scoreMission } from './quality-scorer.mjs'
import {
  filterRecentPRs,
  requiredChecksPassed,
  findMissionFile,
  decodeMissionContent,
} from './lib/mission-auto-merge.mjs'

const QUALITY_THRESHOLD = parseInt(process.env.QUALITY_THRESHOLD || '70', 10)
const LABEL = 'cncf-mission-gen'
const LOOKBACK_HOURS = 6
const REQUIRED_CHECKS = ['Mission Safety Scan', 'Validate Mission Schema']

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...opts })
}

function checkRequiredChecks(prNumber) {
  let checksJson
  try {
    checksJson = gh(['pr', 'checks', String(prNumber), '--json', 'name,state,bucket'])
  } catch (err) {
    // gh pr checks exits non-zero if any check failed or is pending;
    // stdout still contains the JSON we need to inspect.
    checksJson = err.stdout ? err.stdout.toString() : ''
  }
  return requiredChecksPassed(checksJson, REQUIRED_CHECKS)
}

export async function main() {
  // Find open PRs with the cncf-mission-gen label created recently
  const prsJson = gh(['pr', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,headRefName,title,createdAt', '--limit', '50'])
  const prs = JSON.parse(prsJson)
  const recentPrs = filterRecentPRs(prs, LOOKBACK_HOURS)

  console.log(`Found ${recentPrs.length} recent mission PRs (last ${LOOKBACK_HOURS}h)`)
  if (!recentPrs.length) return

  let merged = 0
  let failed = 0

  for (const pr of recentPrs) {
    try {
      // List changed files in the PR to find the mission JSON
      const filesJson = gh(['pr', 'diff', String(pr.number), '--name-only'])
      const missionFile = findMissionFile(filesJson)

      if (!missionFile) {
        console.log(`PR #${pr.number}: no mission JSON found, skipping`)
        continue
      }

      // Fetch the file content from the PR branch
      const content = gh(['api', 'repos/{owner}/{repo}/contents/' + encodeURIComponent(missionFile) + '?ref=' + pr.headRefName, '--jq', '.content'])
      const mission = decodeMissionContent(content)

      // Score the mission
      const result = scoreMission(mission, QUALITY_THRESHOLD)
      console.log(`PR #${pr.number} (${pr.title}): score=${result.score}/100 pass=${result.pass}`)
      console.log(`  Breakdown: ${JSON.stringify(result.breakdown)}`)

      if (result.pass) {
        // Gate the merge on the mission safety scan and schema
        // validation checks — --admin bypasses branch protection,
        // so we must verify these ourselves before using it.
        const gate = checkRequiredChecks(pr.number)
        if (!gate.pass) {
          gh(['pr', 'comment', String(pr.number), '--body', `Auto-merge blocked: quality score ${result.score}/100 passed, but required check '${gate.name}' has not passed (state: ${gate.state}). Needs manual review.`])
          console.log(`  -> Blocked: required check '${gate.name}' not passed (state: ${gate.state})`)
          failed++
          continue
        }

        // Add score comment before merging
        gh(['pr', 'comment', String(pr.number), '--body', `Auto-merge: quality score ${result.score}/100 (threshold: ${QUALITY_THRESHOLD}). Breakdown: ${JSON.stringify(result.breakdown)}`])
        // Merge the PR
        gh(['pr', 'merge', String(pr.number), '--squash', '--admin', '--delete-branch'])
        console.log(`  -> Merged PR #${pr.number}`)
        merged++
      } else {
        // Add comment explaining why it didn't pass
        gh(['pr', 'comment', String(pr.number), '--body', `Quality score ${result.score}/100 — below threshold (${QUALITY_THRESHOLD}). Needs manual review. Breakdown: ${JSON.stringify(result.breakdown)}`])
        console.log(`  -> Below threshold, left open for review`)
        failed++
      }
    } catch (err) {
      console.error(`PR #${pr.number}: error - ${err.message}`)
      failed++
    }
  }

  console.log(`\nDone: ${merged} merged, ${failed} left for review`)
}

// When invoked as a script (node score-and-merge-mission-prs.mjs), run
// main(). Skip main() on import so unit tests can exercise the module
// (and verify no accidental live `gh` calls happen at import time)
// without kicking off the full auto-merge orchestration. This mirrors
// the guard already used by ci-test-summary.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
