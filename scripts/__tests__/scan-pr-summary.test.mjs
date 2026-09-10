/**
 * scan-pr-summary.test.mjs
 *
 * Verifies scan-pr.mjs emits a single-line structured JSON summary event
 * (via lib/logger.mjs, the same mechanism validate-schema.mjs and
 * test-kb-quality-ci.mjs already use) so CI log tooling can parse
 * aggregate scan outcomes without scraping the per-file markdown report.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_PR = resolve(__dirname, '..', 'scan-pr.mjs')

const VALID_MISSION = {
  version: 'kc-mission-v1',
  name: 'install-sample',
  mission: {
    title: 'Install Sample',
    steps: [{ title: 'Do a thing', description: 'kubectl get pods' }],
  },
}

function runScanPR(cwd, args = []) {
  return spawnSync(process.execPath, [SCAN_PR, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-pr-summary-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function findSummaryEvent(output) {
  return output
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

describe('scan-pr.mjs structured summary (CI observability)', () => {
  it('emits a bounded summary line with total=0 when no files are provided', () => {
    withTempDir(dir => {
      const result = runScanPR(dir, [])
      const summary = findSummaryEvent(result.stdout)
      expect(summary).toMatchObject({
        event: 'mission-scan-summary',
        trigger: 'changed-files',
        total: 0,
        readErrors: 0,
        parseErrors: 0,
        schemaInvalid: 0,
        maliciousFindings: 0,
        sensitiveFindings: 0,
        hasFailures: false,
      })
    })
  })

  it('emits total/readErrors and hasFailures=true for a missing file', () => {
    withTempDir(dir => {
      const result = runScanPR(dir, ['does-not-exist.json'])
      expect(result.status).toBe(1)
      const summary = findSummaryEvent(result.stdout)
      expect(summary).toMatchObject({
        event: 'mission-scan-summary',
        total: 1,
        readErrors: 1,
        hasFailures: true,
      })
    })
  })

  it('emits schemaInvalid count and hasFailures=true for a mission missing required fields', () => {
    withTempDir(dir => {
      const bad = { name: 'no-version', mission: { title: 't', steps: [] } }
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad))
      const result = runScanPR(dir, ['bad.json'])
      const summary = findSummaryEvent(result.stdout)
      expect(summary).toMatchObject({
        event: 'mission-scan-summary',
        total: 1,
        schemaInvalid: 1,
        hasFailures: true,
      })
    })
  })

  it('emits total>0 and hasFailures=false for an all-valid scan', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'valid.json'), JSON.stringify(VALID_MISSION))
      const result = runScanPR(dir, ['valid.json'])
      const summary = findSummaryEvent(result.stdout)
      expect(summary).toMatchObject({
        event: 'mission-scan-summary',
        trigger: 'changed-files',
        total: 1,
        readErrors: 0,
        parseErrors: 0,
        schemaInvalid: 0,
        hasFailures: false,
      })
    })
  })

  it('reports trigger="all" for --all discovery scans', () => {
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'root.json'), JSON.stringify(VALID_MISSION))
      const result = runScanPR(dir, ['--all'])
      const summary = findSummaryEvent(result.stdout)
      expect(summary).toMatchObject({
        event: 'mission-scan-summary',
        trigger: 'all',
        total: 1,
        hasFailures: false,
      })
    })
  })
})
