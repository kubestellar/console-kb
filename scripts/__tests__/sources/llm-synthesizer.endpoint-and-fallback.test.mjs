import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Final branch coverage for scripts/sources/llm-synthesizer.mjs. The
// existing suites leave two lines uncovered:
//
//   - line 35  — assertTrustedEndpoint() throw arm: ANTHROPIC_ENDPOINT or
//     GITHUB_MODELS_ENDPOINT set to a URL outside the allowlist causes the
//     module import to fail fast. Neither of the three existing test files
//     re-imports the module with a poisoned env, so this defensive throw is
//     never exercised.
//
//   - line 209 — synthesizeWithFallback() bottom `return null`: reached only
//     when Copilot exhausts AND no ANTHROPIC_API_KEY AND no LLM_TOKEN are set.
//     The .branches-2 fallback test always sets both keys so the anthropic
//     branch is entered; here we set neither so both `if (anthropicKey)` and
//     `if (ghToken)` are skipped and control falls straight through.
//
// After this file, sources/llm-synthesizer.mjs reaches 100% lines and its
// remaining uncovered branches are only the defensive fallbacks that the
// public API cannot reach.

const ENV_KEYS = [
  'USE_COPILOT',
  'COPILOT_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_ENDPOINT',
  'LLM_TOKEN',
  'LLM_ENDPOINT',
]
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const ORIGINAL_FETCH = globalThis.fetch

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('console', { ...console, warn: vi.fn(), log: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  globalThis.fetch = ORIGINAL_FETCH
  restoreEnv()
})

describe('llm-synthesizer — module-load endpoint trust check', () => {
  it('throws Untrusted ANTHROPIC_ENDPOINT when set to a URL outside the allowlist', async () => {
    process.env.ANTHROPIC_ENDPOINT = 'https://evil.example.com/v1/messages'
    // Keep LLM_ENDPOINT default so only ANTHROPIC trips.
    delete process.env.LLM_ENDPOINT

    await expect(import('../../sources/llm-synthesizer.mjs?anthropic-bad')).rejects.toThrow(
      /Untrusted ANTHROPIC_ENDPOINT: https:\/\/evil\.example\.com\/v1\/messages\. Must start with one of: https:\/\/api\.anthropic\.com\//,
    )
  })

  it('throws Untrusted LLM_ENDPOINT (models) when set to a URL outside the allowlist', async () => {
    delete process.env.ANTHROPIC_ENDPOINT
    process.env.LLM_ENDPOINT = 'https://evil.example.com/chat/completions'

    await expect(import('../../sources/llm-synthesizer.mjs?models-bad')).rejects.toThrow(
      /Untrusted .*: https:\/\/evil\.example\.com\/chat\/completions\. Must start with one of:/,
    )
  })

  it('accepts a trusted ANTHROPIC_ENDPOINT prefix and loads the module', async () => {
    process.env.ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'
    delete process.env.LLM_ENDPOINT

    const mod = await import('../../sources/llm-synthesizer.mjs?anthropic-ok')
    expect(typeof mod.synthesizeMission).toBe('function')
  })
})

describe('llm-synthesizer — synthesizeWithFallback with no fallback keys', () => {
  it('returns null after Copilot exhausts when neither ANTHROPIC_API_KEY nor LLM_TOKEN is set', async () => {
    delete process.env.ANTHROPIC_ENDPOINT
    delete process.env.LLM_ENDPOINT
    process.env.COPILOT_TOKEN = 'copilot-tok'
    delete process.env.USE_COPILOT
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    delete process.env.GITHUB_TOKEN

    // All 3 Copilot attempts return 502 -> synthesizeWithFallback runs
    // with no keys set -> `if (anthropicKey)` false, `if (ghToken)` false
    // -> falls through to bottom `return null`.
    const copilotFail = {
      ok: false,
      status: 502,
      text: async () => 'copilot down',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(copilotFail)
    globalThis.fetch = fetchMock

    const { synthesizeMission } = await import('../../sources/llm-synthesizer.mjs?no-keys')

    vi.useFakeTimers()
    const p = synthesizeMission({
      issueTitle: 'Test',
      issueBody: 'A short body',
      labels: [],
      codeSnippets: [],
    })
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p

    expect(result).toBeNull()
    // Only Copilot attempts happened — no Anthropic or GH Models fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const call of fetchMock.mock.calls) {
      const url = call[0]
      expect(url).not.toContain('api.anthropic.com')
      expect(url).not.toContain('models.github.ai')
    }
  })
})
