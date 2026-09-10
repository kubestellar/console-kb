/**
 * scan-pr-cli-branches.test.mjs
 *
 * Additional CLI-level branch tests for scan-pr.mjs targeting behaviors
 * that the existing scan-pr-cli.test.mjs does not exercise:
 *
 *   1. Malicious content in --all mode is REPORTED but does not flip the
 *      exit code, per the deliberate skip in scan-pr.mjs. If this
 *      inverts, silent CI failures would result for every push/schedule.
 *   2. Malicious content in non-full-scan (PR) mode DOES flip the exit
 *      code to 1. This is the primary defense against introducing XSS
 *      or privileged YAML through a PR.
 *   3. Files with .yml extension (as opposed to .yaml) are discovered.
 *   4. Non-mission-extension files at the fixes/ root (e.g. .txt) are
 *      skipped by --all discovery.
 *   5. Files nested at multiple depths are all discovered.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAN_PR = resolve(__dirname, '..', 'scan-pr.mjs')

// Minimal schema-valid mission that scanner will accept. All extra tests
// build on this so they only vary the one field they mean to exercise.
const VALID_MISSION = {
  version: 'kc-mission-v1',
  name: 'install-sample',
  mission: {
    title: 'Install Sample',
    steps: [
      { title: 'Do a thing', description: 'kubectl get pods' },
    ],
  },
}

// A schema-valid mission whose step description contains an XSS payload
// (script tag). This matches the "XSS: script tag" MALICIOUS_PATTERN in
// scanner.mjs and is exactly the class of input CI must catch on PRs.
const MISSION_WITH_XSS = {
  ...VALID_MISSION,
  mission: {
    ...VALID_MISSION.mission,
    steps: [
      {
        title: 'Do a thing',
        description: 'kubectl get pods <script>alert(1)</script>',
      },
    ],
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
  const dir = mkdtempSync(join(tmpdir(), 'scan-pr-cli-branches-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('scan-pr.mjs malicious-content branch', () => {
  it('non-full-scan (PR mode) with malicious content exits 1', () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(MISSION_WITH_XSS))
      const result = runScanPR(dir, ['bad.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Scan completed with failures.')
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      // Report must call out the finding, whatever its exact prose is.
      expect(report.toLowerCase()).toMatch(/xss|script|malicious/)
    })
  })

  it('--all mode reports malicious content but does NOT flip exit code', () => {
    // scan-pr.mjs deliberately skips the malicious check when isFullScan
    // is true (push/schedule/dispatch) to avoid false-positives on
    // curl|bash / awk patterns in already-reviewed missions. Regressing
    // this branch would break every push CI run.
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'legacy-with-script.json'),
        JSON.stringify(MISSION_WITH_XSS))
      const result = runScanPR(dir, ['--all'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('All missions passed scanning.')
    })
  })
})

describe('scan-pr.mjs --all extension handling', () => {
  it('discovers .yml files (not only .yaml)', () => {
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'a.yml'),
        'version: kc-mission-v1\nname: a\nmission:\n  title: t\n  steps:\n    - title: s\n      description: d\n')
      const result = runScanPR(dir, ['--all'])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 1 mission files/)
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).toContain('a.yml')
    })
  })

  it('skips files with non-mission extensions at fixes/ root', () => {
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'notes.txt'), 'this is not a mission')
      writeFileSync(join(fixes, 'ok.json'), JSON.stringify(VALID_MISSION))
      const result = runScanPR(dir, ['--all'])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 1 mission files/)
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).not.toContain('notes.txt')
      expect(report).toContain('ok.json')
    })
  })

  it('recursively descends into multiple nested directories', () => {
    withTempDir(dir => {
      const deep = join(dir, 'fixes', 'a', 'b', 'c')
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'x.json'), JSON.stringify(VALID_MISSION))
      writeFileSync(join(dir, 'fixes', 'a', 'y.json'),
        JSON.stringify(VALID_MISSION))
      const result = runScanPR(dir, ['--all'])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 2 mission files/)
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).toContain('x.json')
      expect(report).toContain('y.json')
    })
  })
})
