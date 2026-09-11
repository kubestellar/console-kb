import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Extends coverage of scripts/mission-executor.mjs main() beyond the
 * single "no argv → usage → exit(1)" case in mission-executor-composition.
 *
 * Targets uncovered arms of main() at lines 632-687:
 *   - kubectl cluster-info failure  → console.error + process.exit(1) branch
 *   - kubectl+helm success path     → per-mission loop, summary tally, REPORT_PATH write
 *   - executeMission thrown error   → verdict='error' catch branch (L649)
 *
 * We do NOT mock node:child_process. Instead we place a fake `kubectl` and
 * `helm` shell script in a per-test tmpdir prepended to PATH; runBinary()
 * calls spawnSync which resolves them via PATH exactly as in production.
 * DRY_RUN=true short-circuits every kubectl/helm call inside executeMission
 * itself, so no real cluster is touched for the mission body — only the
 * two pre-flight main() checks spawn the fake binaries.
 *
 * Filed against console-kb#3165 (scripts/ coverage 57.82%).
 */

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ENV = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  LLM_TOKEN: process.env.LLM_TOKEN,
  DRY_RUN: process.env.DRY_RUN,
  MAX_RETRIES: process.env.MAX_RETRIES,
  MISSION_TIMEOUT_MS: process.env.MISSION_TIMEOUT_MS,
  REPORT_PATH: process.env.REPORT_PATH,
  PATH: process.env.PATH,
}

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

async function loadModule() {
  vi.resetModules()
  return await import('../mission-executor.mjs')
}

function writeFakeBin(dir, name, body) {
  const p = join(dir, name)
  writeFileSync(p, body, { mode: 0o755 })
  chmodSync(p, 0o755)
  return p
}

// Success stubs: kubectl echoes fake cluster-info; helm echoes a short version.
function installPassingBinaries(binDir) {
  writeFakeBin(binDir, 'kubectl',
    '#!/bin/sh\n' +
    'if [ "$1" = "cluster-info" ]; then\n' +
    '  echo "Kubernetes control plane is running at https://kind.local"\n' +
    '  exit 0\n' +
    'fi\n' +
    'exit 0\n',
  )
  writeFakeBin(binDir, 'helm',
    '#!/bin/sh\necho "v3.14.0"\nexit 0\n',
  )
}

function installFailingKubectl(binDir) {
  writeFakeBin(binDir, 'kubectl',
    '#!/bin/sh\necho "The connection to the server localhost:8080 was refused" 1>&2\nexit 1\n',
  )
  writeFakeBin(binDir, 'helm',
    '#!/bin/sh\necho "v3.14.0"\nexit 0\n',
  )
}

describe('main — cluster preflight + execution loop (mission-executor.mjs)', () => {
  let tmpDir
  let origArgv
  let origExit
  let origLog
  let origErr

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mission-main-cov-'))
    origArgv = process.argv
    origExit = process.exit
    origLog = console.log
    origErr = console.error
    console.log = vi.fn()
    console.error = vi.fn()
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.DRY_RUN = 'true'
    process.env.REPORT_PATH = join(tmpDir, 'report.json')
  })

  afterEach(() => {
    process.argv = origArgv
    process.exit = origExit
    console.log = origLog
    console.error = origErr
    globalThis.fetch = ORIGINAL_FETCH
    rmSync(tmpDir, { recursive: true, force: true })
    restoreEnv()
  })

  it('exits 1 when kubectl cluster-info fails at preflight', async () => {
    const binDir = join(tmpDir, 'binfail')
    mkdirSync(binDir, { recursive: true })
    installFailingKubectl(binDir)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH || ''}`

    // Point at a dummy mission file — main() never reaches it because
    // the cluster check exits first.
    process.argv = ['node', 'mission-executor.mjs', join(tmpDir, 'unused.json')]

    const exitCalls = []
    process.exit = vi.fn((code) => {
      exitCalls.push(code)
      throw new Error(`__exit__:${code}`)
    })

    const mod = await loadModule()
    await expect(mod.main()).rejects.toThrow(/__exit__:1/)
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Cannot connect to cluster/),
      expect.any(String),
    )
  })

  it('success: writes REPORT_PATH and does not exit 1 when a dry-run mission passes', async () => {
    const binDir = join(tmpDir, 'binok')
    mkdirSync(binDir, { recursive: true })
    installPassingBinaries(binDir)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH || ''}`

    // Minimal mission: two DRY_RUN kubectl commands + one verify step so
    // executeMission returns verdict='pass' (verification heuristic matches
    // the word "verify" in the last step's title).
    const missionPath = join(tmpDir, 'mission.json')
    writeFileSync(missionPath, JSON.stringify({
      mission: 'test-mission',
      platform: 'test',
      steps: [
        { step: 1, title: 'install cli', description: 'run: kubectl apply -f manifest.yaml' },
        { step: 2, title: 'verify pods', description: 'run: kubectl get pods -n default' },
      ],
      resolution: { summary: 'test resolution' },
    }))
    process.argv = ['node', 'mission-executor.mjs', missionPath]

    // fetch stub: LLM returns extractable commands for each step and a
    // healthy final_verification. executeMission calls llmChat many times
    // (extract, diagnose on failure, final verify). We route by prompt
    // content and always return well-formed JSON.
    globalThis.fetch = vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      const lastUser = body.messages[body.messages.length - 1].content
      let content = '{}'
      if (lastUser.includes('extract_commands')) {
        content = JSON.stringify({ commands: ['kubectl get pods'] })
      } else if (lastUser.includes('final_verification')) {
        content = JSON.stringify({ installed: true, healthy: true, summary: 'ok' })
      } else {
        content = JSON.stringify({ commands: [] })
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => '',
      }
    })

    const exitCalls = []
    process.exit = vi.fn((code) => {
      exitCalls.push(code)
      throw new Error(`__exit__:${code}`)
    })

    const mod = await loadModule()
    // main() should complete normally — no process.exit call at all when
    // no missions fail. If exit was called we would see it in exitCalls.
    let thrown = null
    try {
      await mod.main()
    } catch (e) { thrown = e }
    expect(thrown).toBeNull()
    expect(exitCalls).toEqual([])

    // REPORT_PATH must have been written with the summary shape.
    const report = JSON.parse(readFileSync(process.env.REPORT_PATH, 'utf-8'))
    expect(report).toMatchObject({
      summary: {
        total: 1,
      },
    })
    expect(Array.isArray(report.results)).toBe(true)
    expect(report.results.length).toBe(1)
    expect(typeof report.timestamp).toBe('string')

    // Summary line printed with the icon/status table.
    const logCalls = console.log.mock.calls.map(a => a.join(' '))
    expect(logCalls.some(l => /Execution Summary/.test(l))).toBe(true)
    expect(logCalls.some(l => /Report: /.test(l))).toBe(true)
  })

  it('mission-level catch: bad path → results entry with verdict=error, then majority-failed exit(1)', async () => {
    const binDir = join(tmpDir, 'binok2')
    mkdirSync(binDir, { recursive: true })
    installPassingBinaries(binDir)
    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH || ''}`

    // Missing path → readFileSync in executeMission throws → main's
    // per-mission try/catch appends verdict='error'. Single mission →
    // failed (1) > total (1) / 2 → exit(1).
    process.argv = ['node', 'mission-executor.mjs', join(tmpDir, 'does-not-exist.json')]

    const exitCalls = []
    process.exit = vi.fn((code) => {
      exitCalls.push(code)
      throw new Error(`__exit__:${code}`)
    })

    const mod = await loadModule()
    await expect(mod.main()).rejects.toThrow(/__exit__:1/)
    expect(exitCalls).toEqual([1])

    const report = JSON.parse(readFileSync(process.env.REPORT_PATH, 'utf-8'))
    expect(report.results[0].verdict).toBe('error')
    expect(report.summary.failed).toBe(1)
  })
})
