/**
 * workflow-failure-notify-cli.test.mjs
 *
 * Exercises scripts/workflow-failure-notify.mjs's CLI wrapper the same way
 * a workflow step would: spawn `node workflow-failure-notify.mjs <mode>`
 * with env vars set, and assert on stdout/stderr/exit code. Mirrors
 * render-ci-step-summary-cli.test.mjs's spawnSync pattern.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'workflow-failure-notify.mjs')

function runScript(mode, env) {
  return spawnSync(process.execPath, [SCRIPT, mode], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('workflow-failure-notify.mjs CLI', () => {
  it('comment-body: writes the rendered comment to stdout', () => {
    const result = runScript('comment-body', {
      WORKFLOW_NAME: 'Stale Issues',
      RUN_ID: '42',
      RUN_URL: 'https://example.invalid/runs/42',
      NOW: '2026-10-06 20:00 UTC',
      FAILED_JOBS: '',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('**Still failing** — `Stale Issues` failed again.')
    expect(result.stdout).toContain('- **Time:** 2026-10-06 20:00 UTC')
  })

  it('comment-body: exits 1 and reports a missing required env var', () => {
    const result = runScript('comment-body', {
      WORKFLOW_NAME: '',
      RUN_ID: '',
      RUN_URL: '',
      FAILED_JOBS: '',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing required env var WORKFLOW_NAME')
  })

  it('issue-body: writes the rendered issue body to stdout', () => {
    const result = runScript('issue-body', {
      WORKFLOW_NAME: 'OpenSSF Scorecard',
      RUN_ID: '99',
      RUN_URL: 'https://example.invalid/runs/99',
      WORKFLOW_FILE: '.github/workflows/scorecard.yml',
      NOW: '2026-10-06 20:00 UTC',
      FAILED_JOBS: '',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('## Workflow Failure')
    expect(result.stdout).toContain('| **File** | `.github/workflows/scorecard.yml` |')
  })

  it('issue-body: exits 1 when WORKFLOW_FILE is missing', () => {
    const result = runScript('issue-body', {
      WORKFLOW_NAME: 'OpenSSF Scorecard',
      RUN_ID: '99',
      RUN_URL: 'https://example.invalid/runs/99',
      WORKFLOW_FILE: '',
      FAILED_JOBS: '',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing required env var WORKFLOW_FILE')
  })

  it('failed-jobs: swallows a gh failure and prints an empty line', () => {
    // No GH_TOKEN/auth available in the test sandbox, and an
    // unreachable-in-CI repo/run-id combination, so `gh run view` is
    // expected to error here — exercising the swallow-on-error path.
    const result = runScript('failed-jobs', {
      REPOSITORY: 'kubestellar/console-kb',
      RUN_ID: '0',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('\n')
  })

  it('failed-jobs: exits 1 when REPOSITORY is missing', () => {
    const result = runScript('failed-jobs', { REPOSITORY: '', RUN_ID: '0' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing required env var REPOSITORY')
  })

  it('rejects an unknown mode', () => {
    const result = runScript('bogus-mode', {})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unknown mode 'bogus-mode'")
  })
})
