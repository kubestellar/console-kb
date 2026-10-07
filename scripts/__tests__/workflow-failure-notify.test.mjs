/**
 * workflow-failure-notify.test.mjs
 *
 * Unit tests for scripts/lib/workflow-failure-notify.mjs's pure render
 * functions (ported from kubestellar/homebrew-tap's
 * scripts/test_workflow_failure_notify.sh).
 */
import { describe, it, expect } from 'vitest'
import {
  renderCommentBody,
  renderIssueBody,
  joinFailedJobNames,
} from '../lib/workflow-failure-notify.mjs'

const BASE = {
  workflowName: 'CodeQL Analysis',
  runId: '123456789',
  runUrl: 'https://github.com/kubestellar/console-kb/actions/runs/123456789',
  now: '2026-10-06 20:00 UTC',
}

describe('renderCommentBody', () => {
  it('renders without a failed-jobs line when none is given', () => {
    const body = renderCommentBody({ ...BASE, failedJobs: '' })
    expect(body).toContain('**Still failing** — `CodeQL Analysis` failed again.')
    expect(body).toContain('- **Run:** [#123456789](https://github.com/kubestellar/console-kb/actions/runs/123456789)')
    expect(body).toContain('- **Time:** 2026-10-06 20:00 UTC')
    expect(body).not.toContain('Failed jobs')
  })

  it('includes a failed-jobs line when given', () => {
    const body = renderCommentBody({ ...BASE, failedJobs: 'analyze (javascript), analyze (go)' })
    expect(body).toContain('- **Failed jobs:** `analyze (javascript), analyze (go)`')
  })
})

describe('renderIssueBody', () => {
  it('renders the detail table and next-steps without a failed-jobs row when none is given', () => {
    const body = renderIssueBody({
      ...BASE,
      workflowFile: '.github/workflows/codeql.yml',
      failedJobs: '',
    })
    expect(body).toContain('## Workflow Failure')
    expect(body).toContain('The **CodeQL Analysis** workflow failed.')
    expect(body).toContain('| **File** | `.github/workflows/codeql.yml` |')
    expect(body).toContain('| **Time** | 2026-10-06 20:00 UTC |')
    expect(body).not.toContain('Failed jobs')
    expect(body).toContain('**Do not close** this issue until the workflow passes on `master`')
  })

  it('includes a failed-jobs row when given', () => {
    const body = renderIssueBody({
      ...BASE,
      workflowFile: '.github/workflows/codeql.yml',
      failedJobs: 'analyze (javascript)',
    })
    expect(body).toContain('| **Failed jobs** | `analyze (javascript)` |')
  })
})

describe('joinFailedJobNames', () => {
  it('joins only failed job names, comma-separated', () => {
    const jobs = [
      { name: 'analyze (javascript)', conclusion: 'failure' },
      { name: 'analyze (go)', conclusion: 'success' },
      { name: 'analyze (python)', conclusion: 'failure' },
    ]
    expect(joinFailedJobNames(jobs)).toBe('analyze (javascript), analyze (python)')
  })

  it('returns an empty string when no jobs failed', () => {
    const jobs = [{ name: 'analyze (javascript)', conclusion: 'success' }]
    expect(joinFailedJobNames(jobs)).toBe('')
  })

  it('returns an empty string for non-array input (swallow-on-error contract)', () => {
    expect(joinFailedJobNames(undefined)).toBe('')
    expect(joinFailedJobNames(null)).toBe('')
  })

  it('ignores malformed job entries', () => {
    const jobs = [null, { conclusion: 'failure' }, { name: 42, conclusion: 'failure' }]
    expect(joinFailedJobNames(jobs)).toBe('')
  })
})
