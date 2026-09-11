/**
 * scan-pr-summary.test.mjs
 *
 * Coverage for the structured `mission-scan-summary` JSON line that
 * scan-pr.mjs now emits on stdout (matching the pattern already
 * established by validate-schema.mjs's `schema-validation-summary`,
 * see validate-schema-cli.test.mjs). Before this change, scan-pr.mjs
 * only produced free-form console.log/console.error output and the
 * scan-results.md file — there was no single machine-parseable line
 * summarizing a run, which meant CI log tooling had no bounded way to
 * pull scanned/failed counts out of a scheduled/push/dispatch run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { runScan } from '../scan-pr.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', 'scan-pr.mjs')

const VALID_MISSION = {
  version: 'kc-mission-v1',
  name: 'install-sample',
  mission: {
    title: 'Install Sample',
    steps: [{ title: 'Do a thing', description: 'kubectl get pods' }],
  },
}

function parseSummaryLine(stdout) {
  return stdout
    .split('\n')
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find(parsed => parsed && parsed.event === 'mission-scan-summary')
}

describe('runScan (exported)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scan-pr-summary-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('tallies scannedCount/failedCount/total for a mix of valid and invalid files', () => {
    const validFile = join(dir, 'valid.json')
    const invalidFile = join(dir, 'invalid.json')
    writeFileSync(validFile, JSON.stringify(VALID_MISSION))
    writeFileSync(invalidFile, JSON.stringify({ name: 'missing-fields' }))

    const result = runScan([validFile, invalidFile], { isFullScan: false })

    expect(result.hasFailures).toBe(true)
    expect(result.scannedCount).toBe(2)
    expect(result.failedCount).toBe(1)
    expect(result.total).toBe(2)
    expect(result.report).toContain('Mission Scan Results')
  })

  it('counts unreadable files as scanned+failed rather than throwing', () => {
    const missing = join(dir, 'does-not-exist.json')
    const result = runScan([missing], { isFullScan: false })
    expect(result.hasFailures).toBe(true)
    expect(result.scannedCount).toBe(1)
    expect(result.failedCount).toBe(1)
  })

  it('reports no failures when all files are valid', () => {
    const validFile = join(dir, 'valid.json')
    writeFileSync(validFile, JSON.stringify(VALID_MISSION))
    const result = runScan([validFile], { isFullScan: false })
    expect(result.hasFailures).toBe(false)
    expect(result.scannedCount).toBe(1)
    expect(result.failedCount).toBe(0)
  })
})

describe('scan-pr.mjs CLI — structured summary line', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scan-pr-summary-cli-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits a mission-scan-summary event when files are provided', () => {
    const validFile = join(dir, 'valid.json')
    writeFileSync(validFile, JSON.stringify(VALID_MISSION))

    const stdout = execFileSync('node', [SCRIPT_PATH, validFile], { cwd: dir, encoding: 'utf8' })
    const summaryLine = parseSummaryLine(stdout)

    expect(summaryLine).toMatchObject({
      event: 'mission-scan-summary',
      level: 'info',
      trigger: 'changed-files',
      total: 1,
      scannedCount: 1,
      failedCount: 0,
    })
    expect(typeof summaryLine.durationMs).toBe('number')
  })

  it('emits an error-level summary and exits non-zero when a mission fails scanning', () => {
    const invalidFile = join(dir, 'invalid.json')
    writeFileSync(invalidFile, JSON.stringify({ name: 'missing-fields' }))

    let stdout = ''
    let exitCode = 0
    try {
      execFileSync('node', [SCRIPT_PATH, invalidFile], { cwd: dir, encoding: 'utf8' })
    } catch (err) {
      stdout = err.stdout
      exitCode = err.status
    }

    expect(exitCode).toBe(1)
    const summaryLine = parseSummaryLine(stdout)
    expect(summaryLine).toMatchObject({
      event: 'mission-scan-summary',
      level: 'error',
      total: 1,
      scannedCount: 1,
      failedCount: 1,
    })
  })

  it('emits a total=0 summary and exits 0 when no files are provided', () => {
    const stdout = execFileSync('node', [SCRIPT_PATH], { cwd: dir, encoding: 'utf8' })
    const summaryLine = parseSummaryLine(stdout)
    expect(summaryLine).toMatchObject({
      event: 'mission-scan-summary',
      level: 'info',
      total: 0,
      scannedCount: 0,
      failedCount: 0,
    })
  })

  it('sets trigger="all" for --all discovery runs', () => {
    const fixes = join(dir, 'fixes')
    mkdirSync(fixes, { recursive: true })
    writeFileSync(join(fixes, 'root.json'), JSON.stringify(VALID_MISSION))

    const stdout = execFileSync('node', [SCRIPT_PATH, '--all'], { cwd: dir, encoding: 'utf8' })
    const summaryLine = parseSummaryLine(stdout)
    expect(summaryLine).toMatchObject({
      event: 'mission-scan-summary',
      trigger: 'all',
      total: 1,
    })
  })
})
