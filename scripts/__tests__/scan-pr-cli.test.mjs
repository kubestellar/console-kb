/**
 * scan-pr-cli.test.mjs
 *
 * End-to-end tests for scan-pr.mjs — the CLI entry point CI runs on every
 * pull request to validate mission files.
 *
 * scan-pr.mjs is a top-level-side-effecting script (it reads argv, walks the
 * filesystem, writes scan-results.md, and calls process.exit), so it can't
 * be unit-tested by import. Instead we spawn it as a subprocess with a
 * disposable cwd whose `fixes/` subtree contains fixture mission files, and
 * assert on stdout / scan-results.md / exit code.
 *
 * Previously nothing in __tests__/ covered scan-pr.mjs; a template regression
 * that (for example) inverted the `--all` filter for index.json, dropped the
 * error-branch exit-1 semantic on missing files, or crossed the malicious-
 * content branch would land silently past CI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
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
    steps: [
      { title: 'Do a thing', description: 'kubectl get pods' },
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
  const dir = mkdtempSync(join(tmpdir(), 'scan-pr-cli-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('scan-pr.mjs CLI', () => {
  it('exits 0 with a helpful message when no files are provided', () => {
    withTempDir(dir => {
      const result = runScanPR(dir, [])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('No mission files to scan.')
    })
  })

  it('exits 0 and writes scan-results.md for a single valid mission', () => {
    withTempDir(dir => {
      const missionPath = join(dir, 'valid.json')
      writeFileSync(missionPath, JSON.stringify(VALID_MISSION))

      const result = runScanPR(dir, ['valid.json'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('All missions passed scanning.')
      expect(existsSync(join(dir, 'scan-results.md'))).toBe(true)
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).toContain('Mission Scan Results')
      expect(report).toContain('valid.json')
    })
  })

  it('exits 1 with a read-error section when a specified file does not exist', () => {
    withTempDir(dir => {
      const result = runScanPR(dir, ['does-not-exist.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Scan completed with failures.')
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).toContain('Could not read file')
      expect(report).toContain('does-not-exist.json')
    })
  })

  it('exits 1 when a mission fails schema validation (non-full-scan mode)', () => {
    withTempDir(dir => {
      // Missing required `version` field → validateMissionExport rejects.
      const bad = { name: 'no-version', mission: { title: 't', steps: [] } }
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad))
      const result = runScanPR(dir, ['bad.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Scan completed with failures.')
    })
  })

  it('scans multiple files when each is passed as its own argv entry', () => {
    // Callers (scan-missions.yml) must pass one path per argv entry, e.g.
    // via `node scripts/scan-pr.mjs "${FILES[@]}"` after a NUL-delimited
    // `git diff -z` + `mapfile -d ''`. scan-pr.mjs must NOT re-split argv on
    // whitespace: doing so silently breaks any mission file whose path
    // contains a space or tab into nonexistent paths (see #3280).
    withTempDir(dir => {
      writeFileSync(join(dir, 'a.json'), JSON.stringify(VALID_MISSION))
      writeFileSync(join(dir, 'b.json'), JSON.stringify(VALID_MISSION))
      const result = runScanPR(dir, ['a.json', 'b.json'])
      expect(result.status).toBe(0)
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).toContain('a.json')
      expect(report).toContain('b.json')
    })
  })

  it('does not word-split a single argv entry whose path contains a space', () => {
    // Regression test for #3280: a mission file path with a whitespace
    // character must be treated as one path, not split into two (likely
    // nonexistent) paths that silently skip the scan.
    withTempDir(dir => {
      writeFileSync(join(dir, 'my mission.json'), JSON.stringify(VALID_MISSION))
      const result = runScanPR(dir, ['my mission.json'])
      expect(result.status).toBe(0)
      const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
      expect(report).toContain('my mission.json')
    })
  })

  describe('--all discovery', () => {
    function setupMissionRoots(dir) {
      const fixes = join(dir, 'fixes')
      const runbooks = join(dir, 'runbooks')
      mkdirSync(fixes, { recursive: true })
      mkdirSync(join(fixes, 'nested'), { recursive: true })
      mkdirSync(runbooks, { recursive: true })
      writeFileSync(join(fixes, 'root.json'), JSON.stringify(VALID_MISSION))
      writeFileSync(join(fixes, 'nested', 'deep.yaml'),
        'version: kc-mission-v1\nname: nested\nmission:\n  title: t\n  steps:\n    - title: s\n      description: d\n')
      writeFileSync(join(runbooks, 'runbook.json'), JSON.stringify({ ...VALID_MISSION, name: 'runbook-sample' }))
      // Ignored: index.json (SKIP_FILENAMES) and README.md (extension not in set).
      writeFileSync(join(fixes, 'index.json'), '{"ignored": true}')
      writeFileSync(join(fixes, 'README.md'), '# not a mission')
    }

    it('recursively discovers all .json/.yaml/.yml missions under fixes/ and runbooks/', () => {
      withTempDir(dir => {
        setupMissionRoots(dir)
        const result = runScanPR(dir, ['--all'])
        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/Discovered 3 mission files/)
        const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
        expect(report).toContain('root.json')
        expect(report).toContain('deep.yaml')
        expect(report).toContain('runbook.json')
      })
    })

    it('skips index.json even when its extension matches', () => {
      withTempDir(dir => {
        setupMissionRoots(dir)
        const result = runScanPR(dir, ['--all'])
        const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
        // index.json is invalid ({"ignored":true} lacks required fields);
        // if the SKIP_FILENAMES filter regressed, it would be scanned and
        // failed, flipping the exit code.
        expect(result.status).toBe(0)
        expect(report).not.toContain('index.json')
      })
    })

    it('skips non-mission extensions (README.md)', () => {
      withTempDir(dir => {
        setupMissionRoots(dir)
        const result = runScanPR(dir, ['--all'])
        const report = readFileSync(join(dir, 'scan-results.md'), 'utf8')
        expect(report).not.toContain('README.md')
        expect(result.status).toBe(0)
      })
    })
  })

  describe('GitHub Actions step summary', () => {
    it('appends the scan report to $GITHUB_STEP_SUMMARY when it is set', () => {
      withTempDir(dir => {
        const missionPath = join(dir, 'valid.json')
        writeFileSync(missionPath, JSON.stringify(VALID_MISSION))
        const summaryFile = join(dir, 'step-summary.md')
        writeFileSync(summaryFile, '')

        const result = spawnSync(process.execPath, [SCAN_PR, 'valid.json'], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1', GITHUB_STEP_SUMMARY: summaryFile },
        })

        expect(result.status).toBe(0)
        const summaryContent = readFileSync(summaryFile, 'utf8')
        expect(summaryContent).toContain('Mission Scan Results')
        expect(summaryContent).toContain('valid.json')
      })
    })

    it('does not touch $GITHUB_STEP_SUMMARY when it is unset', () => {
      withTempDir(dir => {
        const missionPath = join(dir, 'valid.json')
        writeFileSync(missionPath, JSON.stringify(VALID_MISSION))
        const env = { ...process.env, NO_COLOR: '1' }
        delete env.GITHUB_STEP_SUMMARY

        const result = spawnSync(process.execPath, [SCAN_PR, 'valid.json'], { cwd: dir, encoding: 'utf8', env })
        expect(result.status).toBe(0)
      })
    })
  })
})
