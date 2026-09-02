import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Coverage for the retry / diagnose_failure branches of
 * `executeStep` (roughly lines 407-461 of mission-executor.mjs) that
 * are unreachable through DRY_RUN=true because DRY_RUN short-circuits
 * before `execCommand` is ever called.
 *
 * We mock `child_process.spawnSync` so `runBinary` — and therefore
 * `execCommand` — returns whatever we want without ever spawning a
 * real process. That lets us drive the interesting non-dry-run
 * branches inside executeStep:
 *
 *   - success on first attempt: `execResult.success === true` → break
 *   - failure → LLM says `skip: true` → mark step passed as "skipped"
 *   - failure → LLM returns `fix_commands: [...]` → executor runs
 *     each fix command, then continues the retry loop with the last
 *     fix command as the next candidate
 *   - failure → LLM diagnosis itself throws → `lastResult = execResult`
 *     path (fallback, without a fix or skip)
 *   - all attempts fail → `result.status = 'failed'` short-circuits
 *     the outer for-of loop
 *
 * All fetch calls (llmChat) are stubbed via globalThis.fetch. No real
 * network, no real process spawning.
 *
 * Filed against console-kb#3103.
 */

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ENV = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  LLM_TOKEN: process.env.LLM_TOKEN,
  DRY_RUN: process.env.DRY_RUN,
  MAX_RETRIES: process.env.MAX_RETRIES,
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

// spawnSync mock helpers
const spawnCalls = []
let spawnScript

vi.mock('child_process', () => ({
  spawnSync: (binary, args, opts) => {
    spawnCalls.push({ binary, args })
    const next = spawnScript.shift()
    if (!next) {
      // Default to success if the test ran out of scripted responses
      return { status: 0, stdout: 'ok', stderr: '' }
    }
    return next
  },
}))

async function loadModule() {
  vi.resetModules()
  return await import('../mission-executor.mjs')
}

beforeEach(() => {
  spawnCalls.length = 0
  spawnScript = []
  process.env.GITHUB_TOKEN = 'test-token'
  process.env.MAX_RETRIES = '3'
  // Explicitly disable DRY_RUN so executeStep goes through execCommand
  delete process.env.DRY_RUN
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  restoreEnv()
  vi.restoreAllMocks()
})

describe('executeStep — non-dry-run retry / diagnose branches', () => {
  it('succeeds on the first attempt when execCommand returns success', async () => {
    spawnScript = [{ status: 0, stdout: 'pods listed', stderr: '' }]
    globalThis.fetch = vi.fn(async () =>
      chatResponse({ commands: ['kubectl get pods -n test'], reasoning: 'ok' }),
    )
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Inspect', description: 'Run kubectl' },
      0,
      { namespace: 'test', cluster_type: 'kind' },
      [],
    )
    expect(result.status).toBe('passed')
    expect(result.attempts).toBe(1)
    expect(result.commands_run).toContain('kubectl get pods -n test')
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].binary).toBe('kubectl')
  })

  it('marks step passed when the LLM diagnosis says skip:true after a failed attempt', async () => {
    // First attempt fails, then LLM says skip:true
    spawnScript = [{ status: 1, stdout: '', stderr: 'not found' }]
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      // 1st call = extract_commands; 2nd call = diagnose_failure
      if (call === 1) return chatResponse({ commands: ['kubectl get pods -n test'] })
      return chatResponse({ skip: true, diagnosis: 'optional resource' })
    })
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Optional', description: 'x' },
      0,
      { namespace: 'test' },
      [],
    )
    expect(result.status).toBe('passed')
    // The step-level output is a static string; per-command 'Skipped' text
    // is stored on lastResult inside the loop but not surfaced. The
    // important assertion is that the skip:true branch marked the step
    // passed without ever running fix commands.
    expect(result.output).toBe('All commands succeeded')
    // Only 1 spawnSync call (the initial failing attempt); no fix commands ran
    expect(spawnCalls).toHaveLength(1)
  })

  it('runs LLM fix_commands and re-attempts when diagnosis returns fix_commands', async () => {
    // Attempt 1 fails, LLM proposes a fix, fix cmd runs, attempt 2 succeeds
    spawnScript = [
      { status: 1, stdout: '', stderr: 'missing crd' },  // attempt 1
      { status: 0, stdout: 'crd installed', stderr: '' }, // fix cmd
      { status: 0, stdout: 'applied', stderr: '' },       // attempt 2 (fix cmd re-run)
    ]
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl apply -f x.yaml'] })
      return chatResponse({
        diagnosis: 'need crd',
        fix_commands: ['kubectl apply -f crd.yaml'],
      })
    })
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Apply', description: 'x' },
      1,
      { namespace: 'test' },
      [],
    )
    expect(result.status).toBe('passed')
    // Original + fix + retry are all recorded in commands_run
    expect(result.commands_run.length).toBeGreaterThanOrEqual(2)
    expect(result.commands_run).toContain('kubectl apply -f crd.yaml')
  })

  it('falls back to the raw execResult when LLM diagnosis itself throws', async () => {
    // All MAX_RETRIES=3 attempts fail; diagnosis throws every time so
    // no fix is attempted → step ends in status 'failed'.
    spawnScript = [
      { status: 1, stdout: '', stderr: 'err1' },
      { status: 1, stdout: '', stderr: 'err2' },
      { status: 1, stdout: '', stderr: 'err3' },
    ]
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl get pods -n test'] })
      // Every subsequent (diagnosis) call throws
      throw new Error('llm down')
    })
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Fails', description: 'x' },
      0,
      { namespace: 'test' },
      [],
    )
    expect(result.status).toBe('failed')
    expect(result.attempts).toBe(3)
  })

  it('returns status=failed when all MAX_RETRIES attempts fail without a skip/fix', async () => {
    spawnScript = [
      { status: 2, stdout: '', stderr: 'a' },
      { status: 2, stdout: '', stderr: 'b' },
      { status: 2, stdout: '', stderr: 'c' },
    ]
    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call++
      if (call === 1) return chatResponse({ commands: ['kubectl get svc -n test'] })
      // Diagnosis returns neither skip nor fix_commands → lastResult = execResult
      return chatResponse({ diagnosis: 'no idea', fix_commands: [] })
    })
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Never works', description: 'x' },
      2,
      { namespace: 'test' },
      [],
    )
    expect(result.status).toBe('failed')
    expect(result.step).toBe(3)
    expect(result.output).toBeTruthy()
  })
})
