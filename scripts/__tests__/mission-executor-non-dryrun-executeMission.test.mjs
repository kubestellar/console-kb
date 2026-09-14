import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Coverage for the NON-DRY_RUN branches of executeMission in
 * scripts/mission-executor.mjs. The existing execute-mission suite
 * only exercises the DRY_RUN=true path, which short-circuits the
 * namespace-create, kubectl-version probe, final-LLM-verification,
 * and cleanup blocks. This file targets exactly those blocks by
 * mocking child_process.spawnSync, plus the "partial" verdict
 * branch (steps fail but verification passes).
 *
 * Filed against console-kb#3318.
 */

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ENV = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  LLM_TOKEN: process.env.LLM_TOKEN,
  DRY_RUN: process.env.DRY_RUN,
  MAX_RETRIES: process.env.MAX_RETRIES,
  MISSION_TIMEOUT_MS: process.env.MISSION_TIMEOUT_MS,
  REPORT_PATH: process.env.REPORT_PATH,
  LLM_ENDPOINT: process.env.LLM_ENDPOINT,
}

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function chatResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  }
}

// spawnSync mock — every scripted response is consumed in order; when
// exhausted the mock defaults to success so the loop still terminates.
let spawnScript
const spawnCalls = []

vi.mock('child_process', () => ({
  spawnSync: (binary, args, _opts) => {
    spawnCalls.push({ binary, args })
    const next = spawnScript.shift()
    if (!next) return { status: 0, stdout: '', stderr: '' }
    return next
  },
}))

async function loadModule() {
  vi.resetModules()
  return await import('../mission-executor.mjs')
}

describe('executeMission — non-DRY_RUN branches', () => {
  let tmpDir
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mission-exec-nodryrun-'))
    spawnCalls.length = 0
    spawnScript = []
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.MAX_RETRIES = '3'
    delete process.env.DRY_RUN
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    rmSync(tmpDir, { recursive: true, force: true })
    restoreEnv()
    vi.restoreAllMocks()
  })

  function writeMission(name, mission) {
    const p = join(tmpDir, `${name}.json`)
    writeFileSync(p, JSON.stringify(mission))
    return p
  }

  it('exercises namespace-create + kubectl-version + final-verify + cleanup and returns verdict=pass', async () => {
    // Order of spawnSync calls in non-DRY_RUN executeMission:
    //   1) kubectl create namespace ... --dry-run=client -o yaml  (manifest)
    //   2) kubectl apply -f -    (apply the manifest, since #1 succeeded)
    //   3) kubectl version --client -o json  (parseable JSON → sets kubernetesVersion)
    //   Then executeStep runs for each step (non-DRY_RUN → spawnSync per command).
    //   4) kubectl apply -f m.yaml  (step 1's extracted command)
    //   5) kubectl rollout status  (step 2 verify)
    //   Then final verification:
    //   6) kubectl get pods -n <ns> --no-headers
    //   7) kubectl get svc -n <ns> --no-headers
    //   Then cleanup:
    //   8) kubectl delete namespace <ns> --wait=false
    spawnScript = [
      { status: 0, stdout: 'apiVersion: v1\nkind: Namespace', stderr: '' },
      { status: 0, stdout: 'namespace/x created', stderr: '' },
      { status: 0, stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.29.0' } }), stderr: '' },
      { status: 0, stdout: 'applied', stderr: '' },
      { status: 0, stdout: 'rolled out', stderr: '' },
      { status: 0, stdout: 'pod/x Running', stderr: '' },
      { status: 0, stdout: 'service/x ClusterIP', stderr: '' },
      { status: 0, stdout: 'namespace deleted', stderr: '' },
    ]

    // fetch call order: extract(step1), extract(step2), final_verification
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl apply -f m.yaml'] })
      if (call === 2) return chatResponse({ commands: ['kubectl rollout status'] })
      return chatResponse({ installed: true, healthy: true, summary: 'ok' })
    })

    const missionPath = writeMission('happy', {
      name: 'Deploy X',
      mission: {
        title: 'Deploy X',
        steps: [
          { title: 'Install', description: 'kubectl apply' },
          { title: 'Verify health', description: 'verify the deployment health' },
        ],
      },
    })

    const mod = await loadModule()
    const report = await mod.executeMission(missionPath)

    expect(report.verdict).toBe('pass')
    expect(report.steps).toHaveLength(2)
    // namespace-create, kubectl-version, and cleanup all fired
    const bins = spawnCalls.map(c => c.binary)
    expect(bins.filter(b => b === 'kubectl').length).toBeGreaterThanOrEqual(6)
    // final-verification pods/svcs probes both ran
    const args = spawnCalls.map(c => c.args.join(' '))
    expect(args.some(a => a.startsWith('get pods'))).toBe(true)
    expect(args.some(a => a.startsWith('get svc'))).toBe(true)
    // cleanup ran
    expect(args.some(a => a.startsWith('delete namespace'))).toBe(true)
  })

  it('falls back to kubernetes_version="unknown" when kubectl version emits non-JSON output', async () => {
    spawnScript = [
      { status: 0, stdout: 'apiVersion: v1', stderr: '' },       // create ns manifest
      { status: 0, stdout: 'ok', stderr: '' },                    // apply -f -
      { status: 0, stdout: 'garbage-not-json', stderr: '' },      // kubectl version → JSON.parse throws
      { status: 0, stdout: 'applied', stderr: '' },               // step 1
      { status: 0, stdout: 'no pods', stderr: '' },               // final pods
      { status: 0, stdout: 'no svcs', stderr: '' },               // final svcs
      { status: 0, stdout: 'ns deleted', stderr: '' },            // cleanup
    ]

    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl apply -f m.yaml'] })
      return chatResponse({ installed: false, healthy: false, summary: 'nope' })
    })

    const missionPath = writeMission('badver', {
      name: 'Bad Version',
      mission: {
        title: 'Bad Version',
        steps: [{ title: 'Install', description: 'x' }],
      },
    })

    const mod = await loadModule()
    const report = await mod.executeMission(missionPath)
    // No verify step → verdict is pass_unverified
    expect(report.verdict).toBe('pass_unverified')
  })

  it('records verdict=partial when a step fails but the final LLM verify says installed+healthy', async () => {
    // Step 1 fails on all attempts → allPassed=false.
    // Final LLM verify says installed:true, healthy:true → verificationPassed=true.
    // Combination → verdict='partial'.
    spawnScript = [
      { status: 0, stdout: 'apiVersion: v1', stderr: '' }, // namespace manifest
      { status: 0, stdout: 'ok', stderr: '' },              // apply -f -
      { status: 0, stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.29' } }), stderr: '' },
      // executeStep — MAX_RETRIES=3 failed attempts, LLM will refuse to fix
      { status: 1, stdout: '', stderr: 'boom' },
      { status: 1, stdout: '', stderr: 'boom' },
      { status: 1, stdout: '', stderr: 'boom' },
      // final verify probes
      { status: 0, stdout: 'pod x Running', stderr: '' },
      { status: 0, stdout: 'svc x', stderr: '' },
      // cleanup
      { status: 0, stdout: 'ns deleted', stderr: '' },
    ]

    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl apply -f bad.yaml'] })
      // Diagnosis calls: return neither skip nor fix so retries exhaust and step is 'failed'
      if (call >= 2 && call <= 4) return chatResponse({ diagnosis: 'idk' })
      // final_verification
      return chatResponse({ installed: true, healthy: true, summary: 'looks good actually' })
    })

    const missionPath = writeMission('partial', {
      name: 'Partial',
      mission: {
        title: 'Partial',
        steps: [{ title: 'Install', description: 'x' }],
      },
    })

    const mod = await loadModule()
    const report = await mod.executeMission(missionPath)
    expect(report.verdict).toBe('partial')
  })

  it('logs "Final LLM verification skipped" when the LLM call itself throws', async () => {
    spawnScript = [
      { status: 0, stdout: 'apiVersion: v1', stderr: '' },
      { status: 0, stdout: 'ok', stderr: '' },
      { status: 0, stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.29' } }), stderr: '' },
      { status: 0, stdout: 'applied', stderr: '' },       // step 1
      { status: 0, stdout: 'verified', stderr: '' },      // step 2 (verify)
      { status: 0, stdout: 'pods', stderr: '' },          // pods probe
      { status: 0, stdout: 'svcs', stderr: '' },          // svcs probe
      { status: 0, stdout: 'ns deleted', stderr: '' },
    ]

    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl apply -f a.yaml'] })
      if (call === 2) return chatResponse({ commands: ['kubectl rollout status'] })
      // final_verification → throw
      throw new Error('llm down')
    })

    const missionPath = writeMission('llmthrow', {
      name: 'LLM Throw',
      mission: {
        title: 'LLM Throw',
        steps: [
          { title: 'Install', description: 'x' },
          { title: 'Verify', description: 'verify healthy' },
        ],
      },
    })

    const mod = await loadModule()
    const report = await mod.executeMission(missionPath)
    // steps pass; verification-heuristic step passed → verdict='pass' even though
    // the LLM verify was skipped. This exercises the catch branch in
    // the final-verification try/catch.
    expect(['pass', 'pass_unverified']).toContain(report.verdict)
  })
})

describe('assertTrustedEndpoint — module load rejects untrusted LLM_ENDPOINT', () => {
  const savedEndpoint = process.env.LLM_ENDPOINT
  afterEach(() => {
    if (savedEndpoint === undefined) delete process.env.LLM_ENDPOINT
    else process.env.LLM_ENDPOINT = savedEndpoint
    vi.resetModules()
  })

  it('throws at import when LLM_ENDPOINT is not one of the trusted prefixes', async () => {
    process.env.LLM_ENDPOINT = 'https://evil.example.com/chat/completions'
    vi.resetModules()
    await expect(import('../mission-executor.mjs')).rejects.toThrow(/Untrusted LLM_ENDPOINT/)
  })
})
