/**
 * validate-schema-cli-discover.test.mjs
 *
 * Tests for validate-schema.mjs's `--all` CLI mode and the underlying
 * discoverMissionFiles walker. These paths were structurally uncovered:
 * existing suites (validate-schema-cli.test.mjs,
 * validate-schema-runValidation.test.mjs, validate-schema.test.mjs) only
 * exercise runValidation with explicit file paths and the changed-files
 * CLI trigger — never the `--all` branch that push/schedule/dispatch
 * workflows use.
 *
 * Sibling scan-pr-cli-branches.test.mjs covers the identical
 * discoverMissionFiles helper in scan-pr.mjs; this file mirrors that
 * pattern for validate-schema.mjs so a divergent regression in one of
 * the two copies would surface.
 *
 * Branches guarded:
 *
 *   1. `--all` on an empty fixes/ tree → "No files to validate." plus
 *      the changed-files vs all trigger distinction in the summary.
 *   2. Recursive descent into nested directories under fixes/.
 *   3. `.yml` extension is discovered (not just `.yaml`).
 *   4. Non-mission extensions at fixes/ root are skipped by the
 *      MISSION_EXTENSIONS Set filter.
 *   5. `index.json` is skipped by the SKIP_FILENAMES Set filter even
 *      though its extension matches.
 *   6. `--all` mode emits a summary with trigger="all".
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'validate-schema.mjs')

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

const VALID_YAML =
  'version: kc-mission-v1\n' +
  'name: install-sample\n' +
  'mission:\n' +
  '  title: Install Sample\n' +
  '  steps:\n' +
  '    - title: Do a thing\n' +
  '      description: kubectl get pods\n'

function runCli(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-schema-discover-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function parseSummary(stdout) {
  return stdout
    .split('\n')
    .map(line => {
      try { return JSON.parse(line) } catch { return null }
    })
    .find(parsed => parsed && parsed.event === 'schema-validation-summary')
}

describe('validate-schema.mjs --all discovery', () => {
  it('reports "No files to validate." when fixes/ is empty and exits 0', () => {
    withTempDir(dir => {
      mkdirSync(join(dir, 'fixes'), { recursive: true })
      const result = runCli(dir, ['--all'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Discovered 0 mission files to validate.')
      expect(result.stdout).toContain('No files to validate.')

      // Even the empty batch must emit a summary so CI observability stays
      // consistent across "no changes" and "all clean" runs, and the
      // trigger must reflect --all (not changed-files).
      const summary = parseSummary(result.stdout)
      expect(summary).toMatchObject({
        event: 'schema-validation-summary',
        level: 'info',
        trigger: 'all',
        total: 0,
        validCount: 0,
        invalidCount: 0,
      })
    })
  })

  it('recursively discovers .json/.yaml missions under multiple nested directories', () => {
    withTempDir(dir => {
      const deep = join(dir, 'fixes', 'a', 'b', 'c')
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'x.json'), JSON.stringify(VALID_MISSION))
      writeFileSync(join(dir, 'fixes', 'a', 'y.yaml'), VALID_YAML)

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 2 mission files to validate\./)
      expect(result.stdout).toContain('x.json')
      expect(result.stdout).toContain('y.yaml')

      const summary = parseSummary(result.stdout)
      expect(summary).toMatchObject({
        trigger: 'all',
        total: 2,
        validCount: 2,
        invalidCount: 0,
      })
    })
  })

  it('discovers .yml files (not only .yaml)', () => {
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'a.yml'), VALID_YAML)

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 1 mission files to validate\./)
      expect(result.stdout).toContain('a.yml')
    })
  })

  it('skips files with non-mission extensions at the fixes/ root', () => {
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'notes.txt'), 'this is not a mission')
      writeFileSync(join(fixes, 'README.md'), '# not a mission')
      writeFileSync(join(fixes, 'ok.json'), JSON.stringify(VALID_MISSION))

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 1 mission files to validate\./)
      expect(result.stdout).not.toContain('notes.txt')
      expect(result.stdout).not.toContain('README.md')
      expect(result.stdout).toContain('ok.json')
    })
  })

  it('skips index.json even though its extension matches', () => {
    // index.json is generated output; if the SKIP_FILENAMES filter
    // regressed, the auto-generated index would be schema-validated and
    // fail, flipping every push/schedule CI run to red.
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'ok.json'), JSON.stringify(VALID_MISSION))
      // index.json is intentionally malformed for the SKIP guard test:
      // if it were NOT skipped, runValidation would report it invalid.
      writeFileSync(join(fixes, 'index.json'), JSON.stringify({ ignored: true }))

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 1 mission files to validate\./)
      expect(result.stdout).not.toContain('index.json')
      expect(result.stdout).toContain('ok.json')

      const summary = parseSummary(result.stdout)
      expect(summary).toMatchObject({
        trigger: 'all',
        total: 1,
        validCount: 1,
        invalidCount: 0,
      })
    })
  })

  it('also discovers mission files under runbooks/, in addition to fixes/', () => {
    // Guards against the false-green regression where --all only ever
    // scanned fixes/: runbooks/*.json uses the same kc-mission-v1 schema
    // (see runbooks/README.md) but previously had zero scheduled/push
    // validation coverage because ALL_MODE_DIRS omitted it.
    withTempDir(dir => {
      mkdirSync(join(dir, 'fixes'), { recursive: true })
      mkdirSync(join(dir, 'runbooks'), { recursive: true })
      writeFileSync(join(dir, 'fixes', 'a.json'), JSON.stringify(VALID_MISSION))
      writeFileSync(join(dir, 'runbooks', 'b.json'), JSON.stringify(VALID_MISSION))

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 2 mission files to validate\./)
      expect(result.stdout).toContain('a.json')
      expect(result.stdout).toContain('b.json')

      const summary = parseSummary(result.stdout)
      expect(summary).toMatchObject({
        trigger: 'all',
        total: 2,
        validCount: 2,
        invalidCount: 0,
      })
    })
  })

  it('--all mode still works when runbooks/ does not exist (no crash)', () => {
    // ALL_MODE_DIRS must tolerate a missing runbooks/ directory rather than
    // throwing ENOENT, so this doesn't regress environments/checkouts that
    // don't have one.
    withTempDir(dir => {
      mkdirSync(join(dir, 'fixes'), { recursive: true })
      writeFileSync(join(dir, 'fixes', 'a.json'), JSON.stringify(VALID_MISSION))

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/Discovered 1 mission files to validate\./)
    })
  })

  it('sets summary trigger to "all" and level to "error" when a discovered file is invalid', () => {
    // Guards the trigger vs level distinction: trigger reflects the CLI
    // switch, level reflects the outcome. A regression that swapped them
    // would silently confuse the CI dashboard.
    withTempDir(dir => {
      const fixes = join(dir, 'fixes')
      mkdirSync(fixes, { recursive: true })
      writeFileSync(join(fixes, 'bad.json'),
        JSON.stringify({ name: 'missing-fields' }))

      const result = runCli(dir, ['--all'])

      expect(result.status).toBe(1)
      const summary = parseSummary(result.stdout)
      expect(summary).toMatchObject({
        event: 'schema-validation-summary',
        level: 'error',
        trigger: 'all',
        total: 1,
        validCount: 0,
        invalidCount: 1,
      })
      expect(typeof summary.durationMs).toBe('number')
    })
  })
})
