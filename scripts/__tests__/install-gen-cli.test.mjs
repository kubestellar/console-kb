/**
 * install-gen-cli.test.mjs
 *
 * scripts/install-gen/*.mjs are the CI entry points for the "Merge reports"
 * and "Review: Security scan" steps of .github/workflows/cncf-install-gen.yml
 * (see kubestellar/console-kb#3164), but were excluded from
 * scripts/vitest.config.mjs's coverage.include — a regression in any of them
 * would not move the reported aggregate and the coverage gate could not
 * catch it (kubestellar/console-kb#3516).
 *
 * These tests import each script in-process with a cache-busting query
 * (mirroring the pattern in merge-search-state-cli.test.mjs) so v8 coverage
 * attributes their executed lines correctly, rather than spawning a
 * subprocess which would be invisible to the coverage collector.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTALL_GEN_DIR = resolve(__dirname, '..', 'install-gen')

function scriptUrl(name) {
  return pathToFileURL(resolve(INSTALL_GEN_DIR, name)).href
}

// Imports a script in-process, capturing console output and process.exit
// calls instead of letting them tear down the test runner.
async function runScript(name, { cwd, env = {} } = {}) {
  const prevCwd = process.cwd()
  const prevEnv = { ...process.env }
  const logs = []
  const errs = []
  const exitCalls = []

  const logSpy = vi.spyOn(console, 'log').mockImplementation((m) => logs.push(String(m)))
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m) => errs.push(String(m)))
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    exitCalls.push(code)
    throw new Error(`__exit__:${code}`)
  })

  if (cwd) process.chdir(cwd)
  Object.assign(process.env, env)

  let threwExit = null
  try {
    await import(`${scriptUrl(name)}?t=${Date.now()}-${Math.random()}`)
  } catch (e) {
    if (typeof e.message === 'string' && e.message.startsWith('__exit__:')) {
      threwExit = Number(e.message.split(':')[1])
    } else {
      throw e
    }
  } finally {
    process.chdir(prevCwd)
    process.env = prevEnv
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }

  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCalls, threwExit }
}

describe('install-gen/security-scan-check.mjs', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'security-scan-check-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('prints PASS and does not exit non-zero for a clean mission', async () => {
    const file = join(workdir, 'clean.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'demo-mission',
        mission: {
          title: 'Demo Mission',
          steps: [{ title: 'Step 1', description: 'Do something' }],
        },
      }),
    )

    const result = await runScript('security-scan-check.mjs', { env: { FILE: file } })

    expect(result.stdout).toContain('PASS')
    expect(result.exitCalls).toEqual([])
  })

  it('prints FAIL:<counts> and exits 1 when sensitive/malicious findings are present', async () => {
    const file = join(workdir, 'unsafe.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'demo-mission',
        mission: {
          title: 'Demo Mission',
          steps: [{ title: 'Step 1', description: '<script>alert(1)</script>' }],
        },
      }),
    )

    const result = await runScript('security-scan-check.mjs', { env: { FILE: file } })

    expect(result.stdout).toMatch(/^FAIL:\d+ sensitive, \d+ malicious/)
    expect(result.threwExit).toBe(1)
    expect(result.exitCalls).toEqual([1])
  })

  it('exits 2 with an error when FILE is not set', async () => {
    const result = await runScript('security-scan-check.mjs', { env: { FILE: '' } })

    expect(result.stderr).toContain('FILE env var is required')
    expect(result.threwExit).toBe(2)
  })
})

describe('install-gen/average-quality-score.mjs', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'average-quality-score-'))
    mkdirSync(join(workdir, 'fixes', 'cncf-install'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('prints the average score across missions with a recorded score, excluding zero-score ones', async () => {
    const dir = join(workdir, 'fixes', 'cncf-install')
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ metadata: { qualityScore: 80 } }))
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ metadata: { qualityScore: 60 } }))
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ metadata: { qualityScore: 0 } }))
    writeFileSync(join(dir, '.gitkeep'), '')

    const result = await runScript('average-quality-score.mjs', { cwd: workdir })

    expect(result.stdout.trim()).toBe('70')
  })

  it('tolerates an unparseable mission file (JSON.parse catch branch) and still averages the rest', async () => {
    const dir = join(workdir, 'fixes', 'cncf-install')
    writeFileSync(join(dir, 'broken.json'), '{ not valid json')
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ metadata: { qualityScore: 90 } }))

    const result = await runScript('average-quality-score.mjs', { cwd: workdir })

    expect(result.stdout.trim()).toBe('90')
  })

  it('prints 0 when no mission has a recorded score', async () => {
    const dir = join(workdir, 'fixes', 'cncf-install')
    writeFileSync(join(dir, 'a.json'), JSON.stringify({}))

    const result = await runScript('average-quality-score.mjs', { cwd: workdir })

    expect(result.stdout.trim()).toBe('0')
  })
})

describe('install-gen/extract-commands.mjs', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'extract-commands-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('prints one matching CLI command per line from step descriptions', async () => {
    const file = join(workdir, 'mission.json')
    writeFileSync(
      file,
      JSON.stringify({
        mission: {
          steps: [
            { description: 'Run `helm install foo bar/foo --namespace test`' },
            { description: 'Then `kubectl get pods -n test`' },
            { description: 'No command here' },
          ],
        },
      }),
    )

    const result = await runScript('extract-commands.mjs', { env: { FILE: file } })

    expect(result.stdout).toContain('helm install foo bar/foo --namespace test')
    expect(result.stdout).toContain('kubectl get pods -n test')
  })

  it('exits 2 with an error when FILE is not set', async () => {
    const result = await runScript('extract-commands.mjs', { env: { FILE: '' } })

    expect(result.stderr).toContain('FILE env var is required')
    expect(result.threwExit).toBe(2)
  })
})

describe('install-gen/extract-freshness-info.mjs', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'extract-freshness-info-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('prints "<repo> <version>" parsed from metadata', async () => {
    const file = join(workdir, 'mission.json')
    writeFileSync(
      file,
      JSON.stringify({
        metadata: {
          sourceUrls: { repo: 'https://github.com/foo/bar' },
          projectVersion: '1.2.3',
        },
      }),
    )

    const result = await runScript('extract-freshness-info.mjs', { env: { FILE: file } })

    expect(result.stdout.trim()).toBe('foo/bar 1.2.3')
  })

  it('defaults to empty repo and "latest" version when metadata is absent', async () => {
    const file = join(workdir, 'mission.json')
    writeFileSync(file, JSON.stringify({}))

    const result = await runScript('extract-freshness-info.mjs', { env: { FILE: file } })

    expect(result.stdout).toBe(' latest')
  })
})

describe('install-gen/section-completeness.mjs', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'section-completeness-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('lists all populated sections and the count out of 4', async () => {
    const file = join(workdir, 'mission.json')
    writeFileSync(
      file,
      JSON.stringify({
        mission: {
          steps: [{ title: 'Install' }],
          uninstall: [{ title: 'Uninstall' }],
        },
      }),
    )

    const result = await runScript('section-completeness.mjs', { env: { FILE: file } })

    expect(result.stdout.trim()).toBe('install,uninstall|2/4')
  })

  it('reports no sections and 0/4 for an empty mission', async () => {
    const file = join(workdir, 'mission.json')
    writeFileSync(file, JSON.stringify({}))

    const result = await runScript('section-completeness.mjs', { env: { FILE: file } })

    expect(result.stdout.trim()).toBe('|0/4')
  })
})

describe('install-gen/render-mission-table.mjs', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'render-mission-table-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('renders a markdown table row per mission result, using the mission or file field', async () => {
    const file = join(workdir, 'mission-execution-report.json')
    writeFileSync(
      file,
      JSON.stringify({
        results: [
          { mission: 'demo-mission', verdict: 'pass', duration_ms: 1500 },
          { file: 'fallback.json', verdict: 'fail' },
          { mission: 'unknown-verdict', verdict: 'something-else' },
        ],
      }),
    )

    const result = await runScript('render-mission-table.mjs', { cwd: workdir })

    expect(result.stdout).toContain('| demo-mission | ✅ pass | 1.5s |')
    expect(result.stdout).toContain('| fallback.json | ❌ fail | -')
    expect(result.stdout).toContain('| unknown-verdict | ❓ something-else | -')
  })

  it('truncates mission labels to LABEL_LEN when set', async () => {
    const file = join(workdir, 'mission-execution-report.json')
    writeFileSync(
      file,
      JSON.stringify({
        results: [{ mission: 'a-very-long-mission-name-that-should-be-truncated', verdict: 'pass' }],
      }),
    )

    const result = await runScript('render-mission-table.mjs', { cwd: workdir, env: { LABEL_LEN: '10' } })

    expect(result.stdout).toContain('| a-very-lon | ✅ pass | -')
  })
})
