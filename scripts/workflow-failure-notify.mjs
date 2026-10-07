#!/usr/bin/env node
/**
 * CLI entry point rendering the comment/issue bodies for a proposed "Open
 * Issue on Scheduled Workflow Failure" workflow (see
 * scripts/lib/workflow-failure-notify.mjs for the full gap description and
 * docs/slo.md's "Follow-up not covered by this document" section).
 *
 * Mirrors kubestellar/homebrew-tap's scripts/workflow_failure_notify.sh
 * modes, applied there via .github/workflows/scheduled-workflow-failure-issue.yml:
 *
 *   node scripts/workflow-failure-notify.mjs comment-body
 *   node scripts/workflow-failure-notify.mjs issue-body
 *   node scripts/workflow-failure-notify.mjs failed-jobs
 *
 * Required env vars (mirroring the workflow_run event context):
 *   WORKFLOW_NAME   - e.g. "CodeQL Analysis"
 *   RUN_ID          - e.g. "123456789"
 *   RUN_URL         - e.g. "https://github.com/.../actions/runs/123456789"
 * issue-body also requires:
 *   WORKFLOW_FILE   - e.g. ".github/workflows/codeql.yml"
 * Optional for comment-body / issue-body:
 *   FAILED_JOBS     - comma-joined failed job names; omitted row/line if unset/empty.
 *   NOW             - override the timestamp line (used by tests); defaults
 *                     to the current UTC time.
 * failed-jobs mode uses:
 *   REPOSITORY      - e.g. "kubestellar/console-kb"
 *   RUN_ID          - e.g. "123456789"
 * failed-jobs prints the comma-joined names of jobs whose conclusion is
 * "failure" for that run, or the empty string if `gh run view` errors
 * (swallow-on-error, so a calling workflow step is never blocked).
 *
 * Exit status: 0 on success (including failed-jobs' swallow-on-error
 * case), 1 on an unknown mode or a missing required env var.
 */
import { execFileSync } from 'node:child_process'
import {
  renderCommentBody,
  renderIssueBody,
  joinFailedJobNames,
} from './lib/workflow-failure-notify.mjs'

function requireEnv(name, env) {
  const value = env[name]
  if (!value) {
    process.stderr.write(`workflow-failure-notify.mjs: missing required env var ${name}\n`)
    process.exit(1)
  }
  return value
}

function nowUtc(env) {
  if (env.NOW) return env.NOW
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

export function main(mode, env = process.env) {
  switch (mode) {
    case 'comment-body': {
      const workflowName = requireEnv('WORKFLOW_NAME', env)
      const runId = requireEnv('RUN_ID', env)
      const runUrl = requireEnv('RUN_URL', env)
      process.stdout.write(
        renderCommentBody({
          workflowName,
          runId,
          runUrl,
          failedJobs: env.FAILED_JOBS || '',
          now: nowUtc(env),
        }),
      )
      return 0
    }
    case 'issue-body': {
      const workflowName = requireEnv('WORKFLOW_NAME', env)
      const runId = requireEnv('RUN_ID', env)
      const runUrl = requireEnv('RUN_URL', env)
      const workflowFile = requireEnv('WORKFLOW_FILE', env)
      process.stdout.write(
        renderIssueBody({
          workflowName,
          runId,
          runUrl,
          workflowFile,
          failedJobs: env.FAILED_JOBS || '',
          now: nowUtc(env),
        }),
      )
      return 0
    }
    case 'failed-jobs': {
      const repository = requireEnv('REPOSITORY', env)
      const runId = requireEnv('RUN_ID', env)
      try {
        const jobsJson = execFileSync(
          'gh',
          ['run', 'view', runId, '--repo', repository, '--json', 'jobs'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        )
        const { jobs } = JSON.parse(jobsJson)
        process.stdout.write(`${joinFailedJobNames(jobs)}\n`)
      } catch {
        // Swallow-on-error: matches the bash original's `2>/dev/null || echo ""`.
        process.stdout.write('\n')
      }
      return 0
    }
    default:
      process.stderr.write(
        `workflow-failure-notify.mjs: unknown mode '${mode}' (expected comment-body|issue-body|failed-jobs)\n`,
      )
      process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2])
}
