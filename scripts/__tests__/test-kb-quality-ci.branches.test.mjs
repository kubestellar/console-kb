/**
 * test-kb-quality-ci.branches.test.mjs
 *
 * Extends the existing test-kb-quality-ci-summary suite with three
 * previously-uncovered branches of scripts/test-kb-quality-ci.mjs, the
 * CLI entry point kb-quality-enforcement.yml runs on every PR that
 * touches fixes/**.json:
 *
 *   1. readFileSync ENOENT (non-existent path) — the existing suite only
 *      exercises JSON.parse throwing on a syntactically bad file, so the
 *      separate ENOENT error path through the same catch block was not
 *      structurally covered.
 *   2. Below-threshold-but-parseable mission — the `if (!result.pass)`
 *      branch, distinct from the catch (e) branch, was previously only
 *      reached via a parse error. This test drives it with a minimal
 *      parseable mission that scores below the threshold.
 *   3. Passing mission with QUALITY_THRESHOLD=0 — exercises the pass
 *      branch (result.pass=true, `failed` stays at 0, exit 0) and the
 *      "Unknown" project fallback when metadata.cncfProjects is missing,
 *      which the failure-path tests could not verify.
 *
 * Runs the script as a subprocess like the sibling suite, since it
 * reads argv, walks the filesystem, and calls process.exit.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'test-kb-quality-ci.mjs')

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-quality-ci-branches-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function parseSummary(stdout) {
  const line = stdout
    .split('\n')
    .find(l => l.includes('"event":"kb-quality-ci-summary"'))
  expect(line, `expected a kb-quality-ci-summary line in stdout, got:\n${stdout}`).toBeTruthy()
  return JSON.parse(line)
}

describe('test-kb-quality-ci.mjs additional branches', () => {
  it('reports failure and exits 1 when the input path does not exist (ENOENT)', () => {
    withTempDir(dir => {
      const missing = join(dir, 'does-not-exist.json')
      const result = runCli([missing])
      expect(result.status).toBe(1)
      // The catch block prints an error line for the missing file.
      expect(result.stderr + result.stdout).toContain('does-not-exist.json')
      const summary = parseSummary(result.stdout)
      expect(summary.total).toBe(1)
      expect(summary.failed).toBe(1)
      expect(summary.passed).toBe(0)
    })
  })

  it('counts a parseable-but-below-threshold mission as failed via the result.pass branch (not the catch branch)', () => {
    withTempDir(dir => {
      // Minimal parseable JSON: no error in readFileSync/JSON.parse, but
      // the mission is nowhere near a passing quality score. This drives
      // the `if (!result.pass)` failure branch specifically, distinct
      // from the JSON-parse and ENOENT catch branches.
      const file = join(dir, 'weak.json')
      writeFileSync(file, JSON.stringify({ version: 'kc-mission-v1' }))

      const result = runCli([file])
      expect(result.status).toBe(1)
      const summary = parseSummary(result.stdout)
      expect(summary.total).toBe(1)
      expect(summary.failed).toBe(1)
      expect(summary.passed).toBe(0)
      // No parse error should have been printed for this file.
      expect(result.stderr).not.toContain('Error evaluating')
    })
  })

  it('counts a parseable mission as passed when QUALITY_THRESHOLD=0 and falls back to project "Unknown" when metadata is missing', () => {
    withTempDir(dir => {
      // With MIN_SCORE=0 (via QUALITY_THRESHOLD=0) any non-negative score
      // passes, so this exercises the pass branch (`failed` stays 0,
      // exit 0) and the `|| 'Unknown'` fallback when
      // metadata.cncfProjects is absent.
      const file = join(dir, 'noproject.json')
      writeFileSync(file, JSON.stringify({ version: 'kc-mission-v1' }))

      const result = runCli([file], { QUALITY_THRESHOLD: '0' })
      expect(result.status).toBe(0)
      const summary = parseSummary(result.stdout)
      expect(summary).toEqual({ event: 'kb-quality-ci-summary', total: 1, passed: 1, failed: 0 })
      // The console.log line shows the resolved project name, which
      // should be the 'Unknown' fallback.
      expect(result.stdout).toContain('Project: Unknown')
    })
  })
})
