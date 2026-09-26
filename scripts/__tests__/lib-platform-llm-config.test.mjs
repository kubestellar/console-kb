// Behavioural tests for scripts/lib/platform-llm-config.mjs — the single
// owner of the platform generator's env-derived LLM/GitHub config
// (kubestellar/console-kb#3544). Uses vi.resetModules() + dynamic import so
// each case observes a fresh module-load with its own process.env.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const MODULE = '../lib/platform-llm-config.mjs'
const ENV_KEYS = ['GITHUB_TOKEN', 'LLM_TOKEN', 'LLM_ENDPOINT', 'LLM_MODEL', 'LLM_TIMEOUT_MS']
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
  it('falls back to the documented defaults when env is unset', async () => {
    const cfg = await import(MODULE)
    expect(cfg.LLM_ENDPOINT).toBe(cfg.DEFAULT_LLM_ENDPOINT)
    expect(cfg.LLM_ENDPOINT).toBe('https://models.inference.ai.azure.com/chat/completions')
    expect(cfg.LLM_MODEL).toBe('gpt-4o-mini')
    expect(cfg.LLM_TIMEOUT_MS).toBe(90000)
    expect(cfg.TRUSTED_LLM_ENDPOINT).toBe(cfg.LLM_ENDPOINT)
  })

  it('reads LLM_ENDPOINT / LLM_MODEL / LLM_TIMEOUT_MS from env at load', async () => {
    process.env.LLM_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
    process.env.LLM_MODEL = 'gpt-4.1'
    process.env.LLM_TIMEOUT_MS = '1234'
    const cfg = await import(MODULE)
    expect(cfg.LLM_ENDPOINT).toBe('https://api.openai.com/v1/chat/completions')
    expect(cfg.TRUSTED_LLM_ENDPOINT).toBe('https://api.openai.com/v1/chat/completions')
    expect(cfg.LLM_MODEL).toBe('gpt-4.1')
    expect(cfg.LLM_TIMEOUT_MS).toBe(1234)
  })

  it('runs the SSRF gate at module load and rejects an untrusted LLM_ENDPOINT', async () => {
    process.env.LLM_ENDPOINT = 'https://evil.example.com/chat/completions'
    await expect(import(MODULE)).rejects.toThrow('Untrusted LLM_ENDPOINT')
  })

  it('re-exports the shared guard so consumers need only one import', async () => {
    const cfg = await import(MODULE)
    const guard = await import('../lib/llm-endpoint-guard.mjs')
    expect(cfg.assertTrustedEndpoint).toBe(guard.assertTrustedEndpoint)
    expect(cfg.ALLOWED_ENDPOINT_PREFIXES).toBe(guard.ALLOWED_ENDPOINT_PREFIXES)
  })
})

describe('platform-llm-config — per-call token getters', () => {
  it('getGithubToken() reflects process.env mutations made after import', async () => {
    const cfg = await import(MODULE)
    expect(cfg.getGithubToken()).toBeUndefined()
    process.env.GITHUB_TOKEN = 'ghp_after_import'
    expect(cfg.getGithubToken()).toBe('ghp_after_import')
  })

  it('getLlmToken() prefers LLM_TOKEN and falls back to GITHUB_TOKEN', async () => {
    const cfg = await import(MODULE)
    expect(cfg.getLlmToken()).toBeUndefined()
    process.env.GITHUB_TOKEN = 'ghp_fallback'
    expect(cfg.getLlmToken()).toBe('ghp_fallback')
    process.env.LLM_TOKEN = 'llm_preferred'
    expect(cfg.getLlmToken()).toBe('llm_preferred')
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

  it('platform modules read tokens per-call via the shared getters', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
        text: async () => '',
      }
    }))
    try {
      const { githubFetch } = await import('../platform/github-context.mjs')
      process.env.GITHUB_TOKEN = 'ghp_late'
      await githubFetch('https://api.github.com/repos/x/y')
      expect(calls.at(-1).options.headers.Authorization).toBe('Bearer ghp_late')

      const { synthesizePlatformMission } = await import('../platform/synthesize.mjs')
      process.env.LLM_TOKEN = 'llm_late'
      await synthesizePlatformMission({ name: 'Demo' }, {})
      expect(calls.at(-1).options.headers.Authorization).toBe('Bearer llm_late')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
