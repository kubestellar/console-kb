/**
 * generate-cncf-outreach-issues-runcli.test.mjs
 *
 * Drives the CLI wrapper `scripts/generate-cncf-outreach-issues.mjs`
 * in-process via `runCli`.
 *
 * This provides direct v8 test coverage on `generate-cncf-outreach-issues.mjs`
 * which reported 0% because the existing test suite drove it solely as an external
 * subprocess (see vitest.config.mjs notes on subprocess coverage).
 */
import { describe, it, expect, vi } from 'vitest'
import { runCli, runOutreachGenerator } from '../generate-cncf-outreach-issues.mjs'

describe('generate-cncf-outreach-issues runCli in-process', () => {
  it('exports runOutreachGenerator helper', () => {
    expect(typeof runOutreachGenerator).toBe('function')
  })

  it('runs CLI in dry-run mode and returns exit code 0', () => {
    const logs = []
    const exitCode = runCli(['--dry-run', '--project=argo'], {
      projects: [{ name: 'argo', repo: 'argoproj/argo-cd' }],
      fs: { existsSync: () => true },
      out: { log: (msg) => logs.push(msg), error: () => {} },
    })

    expect(exitCode).toBe(0)
    expect(logs.some(l => l.includes('Project: argo'))).toBe(true)
  })

  it('returns exit code 1 when --project is not found', () => {
    const errors = []
    const exitCode = runCli(['--project=unknown-project-xyz'], {
      projects: [{ name: 'argo', repo: 'argoproj/argo-cd' }],
      out: { log: () => {}, error: (msg) => errors.push(msg) },
    })

    expect(exitCode).toBe(1)
    expect(errors[0]).toContain("Project 'unknown-project-xyz' not found")
  })
})
