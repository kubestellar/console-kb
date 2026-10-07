/**
 * workflow-failure-notify.mjs
 *
 * Pure markdown-rendering helpers for a proposed "Open Issue on Scheduled
 * Workflow Failure" workflow (see docs/slo.md's "Follow-up not covered by
 * this document" section): none of `codeql.yml` (schedule), `scorecard.yml`
 * (schedule), or `stale.yml` (schedule) alert anyone when the *scheduled run
 * itself* fails — a red run there is visible only via the Actions tab.
 *
 * Ported from `kubestellar/homebrew-tap`'s `scripts/workflow_failure_notify.sh`
 * (applied there via `.github/workflows/scheduled-workflow-failure-issue.yml`),
 * rewritten as an ESM module with pure, unit-tested render functions rather
 * than inline printf/heredoc blocks, matching this repo's
 * lib-module-plus-thin-CLI pattern (see `lib/ci-test-summary.mjs`,
 * `lib/logger.mjs`).
 *
 * Stdout-only: no exporter, metrics backend, or off-box data flow. The
 * caller (`scripts/workflow-failure-notify.mjs`) is designed to be invoked
 * from a `workflow_run` job and write its own issue/comment via `gh`.
 */

export function renderCommentBody({ workflowName, runId, runUrl, failedJobs, now }) {
  const lines = [
    `**Still failing** — \`${workflowName}\` failed again.`,
    '',
    `- **Run:** [#${runId}](${runUrl})`,
    `- **Time:** ${now}`,
  ]
  if (failedJobs) {
    lines.push(`- **Failed jobs:** \`${failedJobs}\``)
  }
  return `${lines.join('\n')}\n`
}

export function renderIssueBody({ workflowName, runId, runUrl, workflowFile, failedJobs, now }) {
  const lines = [
    '## Workflow Failure',
    '',
    `The **${workflowName}** workflow failed.`,
    '',
    '| Detail | Value |',
    '|--------|-------|',
    `| **Workflow** | \`${workflowName}\` |`,
    `| **Run** | [#${runId}](${runUrl}) |`,
    `| **File** | \`${workflowFile}\` |`,
    `| **Time** | ${now} |`,
  ]
  if (failedJobs) {
    lines.push(`| **Failed jobs** | \`${failedJobs}\` |`)
  }
  lines.push(
    '',
    '### Next Steps',
    `1. Check the [failed run](${runUrl}) for error details`,
    '2. Follow the [Scheduled Workflow Failure runbook](https://github.com/kubestellar/console-kb/blob/master/runbooks/incident-response-scheduled-workflow-failure.md)',
    '3. Fix the underlying issue',
    '4. **Do not close** this issue until the workflow passes on `master`',
    '',
    '---',
    '*This issue was automatically created by the scheduled workflow failure monitor.*',
  )
  return `${lines.join('\n')}\n`
}

// Mirrors the swallow-on-error contract of the bash original's
// `failed-jobs` mode: a caller that cannot determine failed jobs (e.g. a
// `gh run view` error) passes `jobs: []` here and gets back an empty
// string rather than throwing, so the calling step is never blocked.
export function joinFailedJobNames(jobs) {
  if (!Array.isArray(jobs)) return ''
  return jobs
    .filter((job) => job && job.conclusion === 'failure' && typeof job.name === 'string')
    .map((job) => job.name)
    .join(', ')
}
