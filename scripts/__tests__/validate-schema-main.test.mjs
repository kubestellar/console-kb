import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, cpSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', 'validate-schema.mjs')

/**
 * Copy validate-schema.mjs (and its ESM neighbors it imports from) into a
 * scratch working directory so we can run `node validate-schema.mjs --all`
 * against a controlled fixes/ tree without polluting the real repo.
 * The script imports from ./scanner.mjs (which imports lib/text-utils.mjs),
 * so we mirror those alongside.
 */
function stageScript(dir) {
  const scriptsDir = join(__dirname, '..')
  cpSync(join(scriptsDir, 'validate-schema.mjs'), join(dir, 'validate-schema.mjs'))
  cpSync(join(scriptsDir, 'scanner.mjs'), join(dir, 'scanner.mjs'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  cpSync(join(scriptsDir, 'lib'), join(dir, 'lib'), { recursive: true })
  // Symlink node_modules so `import 'js-yaml'` resolves. Symlinks avoid a
  // multi-MB copy and are fine because the script only reads from it.
  symlinkSync(join(scriptsDir, 'node_modules'), join(dir, 'node_modules'), 'dir')
}

function runCLI(cwd, args) {
  let stdout = ''
  let exitCode = 0
  try {
    stdout = execFileSync('node', ['validate-schema.mjs', ...args], {
      cwd,
      encoding: 'utf8',
    })
  } catch (err) {
    stdout = err.stdout || ''
    exitCode = err.status
  }
  return { stdout, exitCode }
}

function findSummary(stdout) {
  return stdout
    .split('\n')
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find(parsed => parsed && parsed.event === 'schema-validation-summary')
}

describe('validate-schema.mjs CLI main() untested arms', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'validate-schema-main-'))
    stageScript(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits 0 with trigger=changed-files and total=0 when no file args are given', () => {
    const { stdout, exitCode } = runCLI(dir, [])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No files to validate.')

    const summary = findSummary(stdout)
    expect(summary).toMatchObject({
      event: 'schema-validation-summary',
      level: 'info',
      trigger: 'changed-files',
      total: 0,
      validCount: 0,
      invalidCount: 0,
    })
    expect(typeof summary.durationMs).toBe('number')
  })

  it('exits 0 with trigger=all and total=0 when --all is passed and fixes/ contains no mission files', () => {
    mkdirSync(join(dir, 'fixes'))
    const { stdout, exitCode } = runCLI(dir, ['--all'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Discovered 0 mission files')

    const summary = findSummary(stdout)
    expect(summary).toMatchObject({
      event: 'schema-validation-summary',
      trigger: 'all',
      total: 0,
    })
  })

  it('--all recursively discovers .json/.yaml/.yml under fixes/ and validates every match', () => {
    const fixes = join(dir, 'fixes')
    const nested = join(fixes, 'group-a', 'nested')
    mkdirSync(nested, { recursive: true })

    // Valid JSON at the top level of fixes/.
    writeFileSync(
      join(fixes, 'top.json'),
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'top',
        mission: { title: 'T', steps: [] },
      })
    )
    // Valid YAML in a nested subdirectory (exercises the recursion branch).
    writeFileSync(
      join(nested, 'deep.yaml'),
      [
        'version: kc-mission-v1',
        'name: deep',
        'mission:',
        '  title: T',
        '  steps: []',
        '',
      ].join('\n')
    )
    // Valid YAML with .yml extension.
    writeFileSync(
      join(fixes, 'alt-ext.yml'),
      [
        'version: kc-mission-v1',
        'name: alt',
        'mission:',
        '  title: T',
        '  steps: []',
        '',
      ].join('\n')
    )
    // Skipped by SKIP_FILENAMES.
    writeFileSync(join(fixes, 'index.json'), JSON.stringify({ irrelevant: true }))
    // Skipped by extension filter.
    writeFileSync(join(fixes, 'README.md'), '# ignore me')

    const { stdout, exitCode } = runCLI(dir, ['--all'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Discovered 3 mission files')

    const summary = findSummary(stdout)
    expect(summary).toMatchObject({
      event: 'schema-validation-summary',
      trigger: 'all',
      total: 3,
      validCount: 3,
      invalidCount: 0,
      level: 'info',
    })
  })

  it('--all exits 1 when any discovered mission file is invalid', () => {
    const fixes = join(dir, 'fixes')
    mkdirSync(fixes)
    // One valid mission.
    writeFileSync(
      join(fixes, 'ok.json'),
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'ok',
        mission: { title: 'T', steps: [] },
      })
    )
    // One invalid mission (missing required fields).
    writeFileSync(join(fixes, 'bad.json'), JSON.stringify({ name: 'nope' }))

    const { stdout, exitCode } = runCLI(dir, ['--all'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Discovered 2 mission files')

    const summary = findSummary(stdout)
    expect(summary).toMatchObject({
      trigger: 'all',
      total: 2,
      validCount: 1,
      invalidCount: 1,
      level: 'error',
    })
  })

  it('changed-files mode splits whitespace-separated file arguments', () => {
    // The main() branch does args.flatMap(a => a.split(/\s+/)) — verify
    // a single arg with two space-separated paths expands to two files.
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    for (const p of [a, b]) {
      writeFileSync(
        p,
        JSON.stringify({
          version: 'kc-mission-v1',
          name: 'x',
          mission: { title: 'T', steps: [] },
        })
      )
    }

    const { stdout, exitCode } = runCLI(dir, [`${a} ${b}`])
    expect(exitCode).toBe(0)

    const summary = findSummary(stdout)
    expect(summary).toMatchObject({
      trigger: 'changed-files',
      total: 2,
      validCount: 2,
      invalidCount: 0,
    })
  })
})
