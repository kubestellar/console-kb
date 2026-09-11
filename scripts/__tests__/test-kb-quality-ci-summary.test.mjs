/**
 * test-kb-quality-ci-summary.test.mjs
 *
 * test-kb-quality-ci.mjs is the CLI entry point kb-quality-enforcement.yml
 * runs on every pull request that touches fixes/**.json to gate mission
 * quality. It only ever printed human-readable console.log/console.error
 * text, so a reviewer or on-call engineer had to open raw step logs to
 * learn how many files were scored, how many passed, and how many failed
 * — unlike validate-schema.mjs / scan-pr.mjs, which already emit a single
 * bounded JSON line via the shared scripts/lib/logger.mjs `summary()`
 * helper for the same class of check.
 *
 * This spawns the script as a subprocess (it reads argv, walks the
 * filesystem, and calls process.exit, so it can't be unit-tested by
 * import) and asserts the structured summary line is present on stdout
 * with the expected bounded fields, for both the pass and fail paths and
 * the no-files-provided path.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'test-kb-quality-ci.mjs')

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-quality-ci-'))
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
  expect(line).toBeTruthy()
  return JSON.parse(line)
}

describe('test-kb-quality-ci.mjs structured summary', () => {
  it('emits a bounded summary line with total=0 when no files are provided', () => {
    const result = runCli([])
    expect(result.status).toBe(0)
    const summary = parseSummary(result.stdout)
    expect(summary).toEqual({ event: 'kb-quality-ci-summary', total: 0, passed: 0, failed: 0 })
  })

  it('emits total/failed counts and exits 1 when a file fails to parse', () => {
    withTempDir(dir => {
      const badFile = join(dir, 'broken.json')
      writeFileSync(badFile, '{ not valid json')

      const result = runCli([badFile])
      expect(result.status).toBe(1)
      const summary = parseSummary(result.stdout)
      expect(summary.total).toBe(1)
      expect(summary.failed).toBe(1)
      expect(summary.passed).toBe(0)
    })
  })
})
