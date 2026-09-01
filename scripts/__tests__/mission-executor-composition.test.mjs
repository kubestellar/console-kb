import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Coverage for the composition layer of mission-executor.mjs that is not
 * exercised by the existing `mission-executor.test.mjs` (63 tests on the
 * exported primitives) or `mission-executor-exec-command.test.mjs`
 * (8 tests on execCommand error paths). Together those files sit at
 * ~26% statements / 41% branches. This file targets:
 *
 *   - llmChat: no-token throw, non-2xx wrap, empty content throw,
 *     happy-path JSON.parse of choices[0].message.content.
 *   - executeStep: dry-run success path, LLM-returned `commands: []`
 *     skipped path, LLM extraction throw error path, and a fully
 *     successful command path (fetch mocked, spawnSync short-circuited
 *     by DRY_RUN).
 *   - main: no-argv usage error → process.exit(1).
 *
 * All tests mock `globalThis.fetch` (llmChat's only I/O) and set
 * DRY_RUN=true so the executeStep loop never reaches spawnSync. No
 * mocks of `node:child_process` are required — the DRY_RUN branch of
 * executeStep short-circuits before the spawn call. That keeps this
 * suite fully hermetic.
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

// Reset the module registry between test groups so that the top-level
// `const DRY_RUN = process.env.DRY_RUN === 'true'` and `MAX_RETRIES`
// bindings pick up the per-suite env we set below. Vitest evaluates
// each dynamic import in isolation after resetModules().
async function loadModule() {
  vi.resetModules()
  return await import('../mission-executor.mjs')
}

// Small helper: canned fetch response.
function jsonResponse(status, bodyObj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  }
}

// Wrap a chat "content" string into the OpenAI/Copilot response shape
// that llmChat expects.
function chatResponse(contentObj) {
  return jsonResponse(200, {
    choices: [{ message: { content: JSON.stringify(contentObj) } }],
  })
}

describe('llmChat — no auth token', () => {
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN
    delete process.env.LLM_TOKEN
  })
  afterEach(restoreEnv)

  it('throws when neither LLM_TOKEN nor GITHUB_TOKEN is set', async () => {
    const mod = await loadModule()
    await expect(mod.llmChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /No GITHUB_TOKEN set for LLM API/,
    )
  })
})

describe('llmChat — HTTP paths', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token'
    delete process.env.LLM_TOKEN
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('throws with wrapped status + body on non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
      json: async () => ({}),
    }))
    const mod = await loadModule()
    await expect(mod.llmChat([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /LLM API error 503: service unavailable/,
    )
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('throws "Empty LLM response" when choices[0].message.content is missing', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: {} }] }),
    )
    const mod = await loadModule()
    await expect(mod.llmChat([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /Empty LLM response/,
    )
  })

  it('returns parsed JSON on the happy path', async () => {
    globalThis.fetch = vi.fn(async () =>
      chatResponse({ commands: ['kubectl get pods'], reasoning: 'ok' }),
    )
    const mod = await loadModule()
    const out = await mod.llmChat([{ role: 'user', content: 'x' }])
    expect(out).toEqual({ commands: ['kubectl get pods'], reasoning: 'ok' })
    // sanity-check the request shape without over-pinning
    const call = globalThis.fetch.mock.calls[0]
    expect(call[0]).toMatch(/^https:\/\//)
    expect(call[1].method).toBe('POST')
    const body = JSON.parse(call[1].body)
    expect(body.model).toBeDefined()
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })
})

describe('executeStep — dry-run path (spawn-free)', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token'
    process.env.DRY_RUN = 'true'
    process.env.MAX_RETRIES = '3'
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('marks the step passed when LLM returns commands and DRY_RUN=true short-circuits execution', async () => {
    globalThis.fetch = vi.fn(async () =>
      chatResponse({
        commands: ['kubectl get pods -n test'],
        reasoning: 'inspect',
        adaptations: 'none',
      }),
    )
    const mod = await loadModule()
    const conv = []
    const result = await mod.executeStep(
      { title: 'Inspect', description: 'Run kubectl get pods' },
      0,
      { namespace: 'test', cluster_type: 'kind' },
      conv,
    )
    expect(result.status).toBe('passed')
    expect(result.commands_run).toContain('kubectl get pods -n test')
    // conv gets user + assistant message appended
    expect(conv.length).toBeGreaterThanOrEqual(2)
  })

  it('marks the step skipped when LLM returns commands: []', async () => {
    globalThis.fetch = vi.fn(async () =>
      chatResponse({ commands: [], reasoning: 'nothing to do' }),
    )
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Description-only', description: 'Just read.' },
      2,
      { namespace: 'test', cluster_type: 'kind' },
      [],
    )
    expect(result.status).toBe('skipped')
    expect(result.output).toMatch(/No actionable commands/)
    expect(result.step).toBe(3)
  })

  it('marks the step error when the LLM extraction call throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    })
    const mod = await loadModule()
    const result = await mod.executeStep(
      { title: 'Boom', description: 'x' },
      0,
      { namespace: 'test' },
      [],
    )
    expect(result.status).toBe('error')
    expect(result.output).toMatch(/LLM extraction failed: network down/)
  })
})

describe('main — argv validation', () => {
  let origArgv
  let origExit
  let origErr
  beforeEach(() => {
    origArgv = process.argv
    origExit = process.exit
    origErr = console.error
    console.error = vi.fn()
  })
  afterEach(() => {
    process.argv = origArgv
    process.exit = origExit
    console.error = origErr
    restoreEnv()
  })

  it('prints usage and exits 1 when no mission files are provided', async () => {
    process.argv = ['node', 'mission-executor.mjs']
    const exitCalls = []
    process.exit = vi.fn((code) => {
      exitCalls.push(code)
      // Throw to short-circuit — main() continues past process.exit in
      // the test environment because our stub returns instead of
      // terminating. This keeps the rest of main() from running.
      throw new Error(`__exit__:${code}`)
    })
    const mod = await loadModule()
    await expect(mod.main()).rejects.toThrow(/__exit__:1/)
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Usage: node mission-executor\.mjs/),
    )
  })
})
