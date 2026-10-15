// Behavioural tests for scripts/lib/platform-llm-config.mjs — the single
// owner of the platform generator's env-derived config (kubestellar/console-kb#3544).
// LLM endpoint/key/model now come from lib/llm-proxy-config.mjs (#3702),
// which this module re-exports. Uses vi.resetModules() + dynamic import so
// each case observes a fresh module-load with its own process.env.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const MODULE = '../lib/platform-llm-config.mjs'
const ENV_KEYS = ['GITHUB_TOKEN', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_TIMEOUT_MS']
const saved = {}

beforeEach(() => {
  vi.resetModules()
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('platform-llm-config — module-load constants', () => {
  it('falls back to the documented timeout default when env is unset', async () => {
    const cfg = await import(MODULE)
    expect(cfg.LLM_TIMEOUT_MS).toBe(90000)
  })

  it('reads LLM_TIMEOUT_MS from env at load', async () => {
    process.env.LLM_TIMEOUT_MS = '1234'
    const cfg = await import(MODULE)
    expect(cfg.LLM_TIMEOUT_MS).toBe(1234)
  })

  it('importing does not throw when the LLM proxy env is unset (config is read per call)', async () => {
    await expect(import(MODULE)).resolves.toBeDefined()
  })

  it('no longer exports the retired GitHub Models endpoint / token getters', async () => {
    const cfg = await import(MODULE)
    expect(cfg.LLM_ENDPOINT).toBeUndefined()
    expect(cfg.TRUSTED_LLM_ENDPOINT).toBeUndefined()
    expect(cfg.getLlmToken).toBeUndefined()
  })

  it('re-exports the shared proxy config so consumers need only one import', async () => {
    const cfg = await import(MODULE)
    const proxy = await import('../lib/llm-proxy-config.mjs')
    expect(cfg.getLlmProxyConfig).toBe(proxy.getLlmProxyConfig)
    expect(cfg.requireLlmProxyConfig).toBe(proxy.requireLlmProxyConfig)
    expect(cfg.assertJsonResponse).toBe(proxy.assertJsonResponse)
  })
})

describe('platform-llm-config — per-call getters', () => {
  it('getGithubToken() reflects process.env mutations made after import', async () => {
    const cfg = await import(MODULE)
    expect(cfg.getGithubToken()).toBeUndefined()
    process.env.GITHUB_TOKEN = 'ghp_after_import'
    expect(cfg.getGithubToken()).toBe('ghp_after_import')
  })

  it('getLlmProxyConfig() throws when unset and reflects env set after import', async () => {
    const cfg = await import(MODULE)
    expect(() => cfg.getLlmProxyConfig()).toThrow(cfg.LlmConfigError)
    process.env.LLM_BASE_URL = 'https://proxy.test/v1'
    process.env.LLM_API_KEY = 'k'
    expect(cfg.getLlmProxyConfig().endpoint).toBe('https://proxy.test/v1/chat/completions')
  })
})

describe('platform-llm-config — no reverse import from the orchestrator', () => {
  it('platform/synthesize.mjs and platform/github-context.mjs load without generate-platform-missions.mjs', async () => {
    // Regression for console-kb#3544: importing the extracted libs must not
    // pull in the 400-line orchestrator. Spy on the module graph by making
    // the orchestrator throw if it is ever evaluated.
    vi.doMock('../generate-platform-missions.mjs', () => {
      throw new Error('reverse import: generate-platform-missions.mjs was loaded')
    })
    await expect(import('../platform/synthesize.mjs')).resolves.toBeDefined()
    await expect(import('../platform/github-context.mjs')).resolves.toBeDefined()
    vi.doUnmock('../generate-platform-missions.mjs')
  })

  it('platform modules read the LLM proxy key per-call', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      }
    }))
    try {
      const { synthesizePlatformMission } = await import('../platform/synthesize.mjs')
      process.env.LLM_BASE_URL = 'https://proxy.test/v1'
      process.env.LLM_API_KEY = 'llm_late'
      await synthesizePlatformMission({ name: 'Demo' }, {})
      expect(calls.at(-1).url).toBe('https://proxy.test/v1/chat/completions')
      expect(calls.at(-1).options.headers.Authorization).toBe('Bearer llm_late')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
