/**
 * merge-search-state-cli.test.mjs
 *
 * The pure merge algorithm in lib/search-state-merge.mjs is already unit-tested
 * via search-state-merge.test.mjs, but the CLI wrapper — scripts/merge-search-state.mjs,
 * which is what .github/workflows/cncf-mission-gen.yml actually invokes (see the
 * "Merge search state files" step, kubestellar/console-kb#3197) — was at 0% coverage.
 *
 * A regression in the wrapper (wrong glob for search-state-<N>.json, wrong output
 * path, swallowed JSON error, wrong stdout summary) would silently corrupt the
 * merged search-state.json in production while the pure-algorithm tests all
 * still pass. These tests spawn the CLI the same way CI does — in a tempdir
 * with real fixture files on disk — and assert the on-disk result.
 *
 * Mirrors the spawnSync + tempdir pattern already used by
 * render-ci-step-summary-cli.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, closeSync, openSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'merge-search-state.mjs')
const SCRIPT_URL = pathToFileURL(SCRIPT).href

// Import the CLI script in-process with cwd set to `cwd`, using a
// cache-busting query so `main()` re-runs against fresh fixtures on each call
// and its executed lines are attributed to this file by v8 coverage
// (spawn-based tests would run in a subprocess and be invisible to the
// coverage collector).
async function runIn(cwd) {
  const prevCwd = process.cwd()
  const logs = []
  const stderrWrites = []
  const exit = { called: false, code: 0 }
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m) => logs.push(String(m)))
  // merge-search-state.mjs logs warnings/errors via the shared structured
  // logger (scripts/lib/logger.mjs), which writes JSON lines directly to
  // process.stderr instead of calling console.warn/console.error — see #3599.
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
    stderrWrites.push(String(m))
    return true
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    exit.called = true
    exit.code = Number(code)
    throw new Error('__PROCESS_EXIT__')
  })
  process.chdir(cwd)
  try {
    try {
      await import(`${SCRIPT_URL}?t=${Date.now()}-${Math.random()}`)
    } catch (e) {
      if (e.message !== '__PROCESS_EXIT__') throw e
    }
    const status = exit.called ? exit.code : 0
    return { status, stdout: logs.join('\n'), stderr: stderrWrites.join('\n') }
  } finally {
    process.chdir(prevCwd)
    logSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  }
}

describe('merge-search-state.mjs CLI', () => {
  let workdir

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'merge-search-state-cli-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('merges a base search-state.json with two batch files and writes back to search-state.json', async () => {
    writeFileSync(
      join(workdir, 'search-state.json'),
      JSON.stringify({
        version: 1,
        lastUpdated: '2020-01-01T00:00:00.000Z',
        projects: {
          'foo/bar': {
            github: { processedIds: ['a'], lastSearched: '2020-01-01', cursor: 'c0' },
          },
        },
      }),
    )
    writeFileSync(
      join(workdir, 'search-state-1.json'),
      JSON.stringify({
        projects: {
          'foo/bar': {
            github: { processedIds: ['b'], lastSearched: '2021-01-01', cursor: 'c1' },
          },
        },
      }),
    )
    writeFileSync(
      join(workdir, 'search-state-2.json'),
      JSON.stringify({
        projects: {
          'baz/qux': {
            reddit: { processedIds: ['x'], lastSearched: '2022-06-15' },
          },
        },
      }),
    )

    const result = await runIn(workdir)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Merged search state: 2 projects')

    const merged = JSON.parse(readFileSync(join(workdir, 'search-state.json'), 'utf8'))
    expect(Object.keys(merged.projects).sort()).toEqual(['baz/qux', 'foo/bar'])

    const fooGithub = merged.projects['foo/bar'].github
    expect([...fooGithub.processedIds].sort()).toEqual(['a', 'b'])
    expect(fooGithub.lastSearched).toBe('2021-01-01')
    expect(fooGithub.cursor).toBe('c1')

    expect(merged.projects['baz/qux'].reddit.processedIds).toEqual(['x'])
  })

  it('runs with no base search-state.json — only per-batch files present — and still produces a merged file', async () => {
    writeFileSync(
      join(workdir, 'search-state-10.json'),
      JSON.stringify({
        projects: {
          'only/batch': {
            stackoverflow: { processedIds: ['s1', 's2'], lastSearched: '2023-03-03' },
          },
        },
      }),
    )

    const result = await runIn(workdir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Merged search state: 1 projects')

    const merged = JSON.parse(readFileSync(join(workdir, 'search-state.json'), 'utf8'))
    expect(merged.projects['only/batch'].stackoverflow.processedIds).toEqual(['s1', 's2'])
  })

  it('runs with no inputs at all and writes an empty projects map — 0 projects reported', async () => {
    const result = await runIn(workdir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Merged search state: 0 projects')

    const merged = JSON.parse(readFileSync(join(workdir, 'search-state.json'), 'utf8'))
    expect(merged.projects).toEqual({})
  })

  it('self-heals from an invalid base search-state.json: preserves it as .corrupt-<ts>, warns, and still merges incoming batches', async () => {
    writeFileSync(join(workdir, 'search-state.json'), '{ this is not valid json')
    writeFileSync(
      join(workdir, 'search-state-3.json'),
      JSON.stringify({
        projects: {
          'from/batch': {
            github: { processedIds: ['g'] },
          },
        },
      }),
    )

    const result = await runIn(workdir)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Error parsing search-state.json')
    expect(result.stderr).toContain('treating base as empty and continuing')
    expect(result.stdout).toContain('Merged search state: 1 projects')

    // The clean merged output overwrites search-state.json.
    const merged = JSON.parse(readFileSync(join(workdir, 'search-state.json'), 'utf8'))
    expect(merged.projects['from/batch'].github.processedIds).toEqual(['g'])

    // And the original corrupt bytes are preserved under a timestamped name
    // (the "Commit search state" step in cncf-mission-gen.yml only stages
    // `search-state.json`, so this preserved file stays out of git history
    // while remaining available on the runner for triage).
    const preserved = readdirSync(workdir).filter((f) =>
      /^search-state\.json\.corrupt-/.test(f),
    )
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(workdir, preserved[0]), 'utf8')).toBe('{ this is not valid json')
  })

  it('appends a job-summary warning when GITHUB_STEP_SUMMARY is set and the base is corrupt', async () => {
    writeFileSync(join(workdir, 'search-state.json'), 'not json at all')
    const summaryPath = join(workdir, 'step-summary.md')
    closeSync(openSync(summaryPath, 'w'))
    const prevSummary = process.env.GITHUB_STEP_SUMMARY
    process.env.GITHUB_STEP_SUMMARY = summaryPath
    try {
      const result = await runIn(workdir)
      expect(result.status).toBe(0)

      const summary = readFileSync(summaryPath, 'utf8')
      expect(summary).toContain('search-state.json self-healed from corrupt base')
      expect(summary).toContain('incident-response-search-state-corruption.md')
    } finally {
      if (prevSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
      else process.env.GITHUB_STEP_SUMMARY = prevSummary
    }
  })

  it('does not write a job summary when the base search-state.json is valid', async () => {
    writeFileSync(
      join(workdir, 'search-state.json'),
      JSON.stringify({ projects: { 'ok/repo': { github: { processedIds: ['a'] } } } }),
    )
    const summaryPath = join(workdir, 'step-summary.md')
    closeSync(openSync(summaryPath, 'w'))
    const prevSummary = process.env.GITHUB_STEP_SUMMARY
    process.env.GITHUB_STEP_SUMMARY = summaryPath
    try {
      const result = await runIn(workdir)
      expect(result.status).toBe(0)
      expect(readFileSync(summaryPath, 'utf8')).toBe('')
    } finally {
      if (prevSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY
      else process.env.GITHUB_STEP_SUMMARY = prevSummary
    }
  })

  it('warns to stderr about an unparseable batch file and continues with the remaining batches', async () => {
    writeFileSync(join(workdir, 'search-state-4.json'), '{ broken')
    writeFileSync(
      join(workdir, 'search-state-5.json'),
      JSON.stringify({
        projects: {
          'good/one': {
            github: { processedIds: ['ok'] },
          },
        },
      }),
    )

    const result = await runIn(workdir)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Error merging search-state-4.json')
    expect(result.stdout).toContain('Merged search state: 1 projects')

    const merged = JSON.parse(readFileSync(join(workdir, 'search-state.json'), 'utf8'))
    expect(merged.projects['good/one'].github.processedIds).toEqual(['ok'])
  })

  it('ignores files that do not match the search-state-<N>.json pattern', async () => {
    writeFileSync(
      join(workdir, 'search-state-notanumber.json'),
      JSON.stringify({
        projects: { 'should/be/ignored': { github: { processedIds: ['nope'] } } },
      }),
    )
    writeFileSync(
      join(workdir, 'search-state-backup.json'),
      JSON.stringify({
        projects: { 'also/ignored': { github: { processedIds: ['nope'] } } },
      }),
    )
    writeFileSync(join(workdir, 'unrelated.json'), '{"projects":{"x/y":{"github":{"processedIds":["z"]}}}}')

    const result = await runIn(workdir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Merged search state: 0 projects')

    const merged = JSON.parse(readFileSync(join(workdir, 'search-state.json'), 'utf8'))
    expect(merged.projects).toEqual({})
    // Base file was overwritten
    expect(existsSync(join(workdir, 'search-state.json'))).toBe(true)
  })
})
