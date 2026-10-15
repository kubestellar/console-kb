// Unit tests for scripts/lib/llm-proxy-config.mjs — the single owner of the
// env-configured LLM proxy (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL) that
// replaced the retired GitHub Models endpoint (kubestellar/console-kb#3702).
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DEFAULT_LLM_MODEL,
  LlmConfigError,
  LlmResponseError,
  getLlmProxyConfig,
  getLlmModel,
  chatCompletionsEndpoint,
  requireLlmProxyConfig,
  llmRequestHeaders,
  isJsonResponse,
  assertJsonResponse,
} from '../lib/llm-proxy-config.mjs'

function fakeResponse({ contentType, body = '', status = 200 } = {}) {
  const headers = new Map()
  if (contentType != null) headers.set('content-type', contentType)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
  }
}

describe('getLlmProxyConfig — unset env throws', () => {
  it('throws LlmConfigError naming both vars when LLM_BASE_URL and LLM_API_KEY are unset', () => {
    expect(() => getLlmProxyConfig({})).toThrow(LlmConfigError)
    expect(() => getLlmProxyConfig({})).toThrow(/LLM_BASE_URL, LLM_API_KEY unset/)
  })

  it('throws when only LLM_API_KEY is unset', () => {
    expect(() => getLlmProxyConfig({ LLM_BASE_URL: 'https://proxy.test/v1' })).toThrow(/LLM_API_KEY unset/)
  })

  it('throws when only LLM_BASE_URL is unset (whitespace counts as unset)', () => {
    expect(() => getLlmProxyConfig({ LLM_BASE_URL: '   ', LLM_API_KEY: 'k' })).toThrow(/LLM_BASE_URL unset/)
  })

  it('never falls back to a hard-coded endpoint or to GITHUB_TOKEN / LLM_TOKEN', () => {
    expect(() =>
      getLlmProxyConfig({ GITHUB_TOKEN: 'ghp_x', LLM_TOKEN: 'pat', LLM_ENDPOINT: 'https://models.github.ai/inference/chat/completions' })
    ).toThrow(LlmConfigError)
  })
})

describe('getLlmProxyConfig — valid env', () => {
  it('builds the chat-completions endpoint and defaults the model', () => {
    const cfg = getLlmProxyConfig({ LLM_BASE_URL: 'https://proxy.test/v1/', LLM_API_KEY: 'sk-test' })
    expect(cfg).toEqual({
      baseUrl: 'https://proxy.test/v1/',
      endpoint: 'https://proxy.test/v1/chat/completions',
      apiKey: 'sk-test',
      model: DEFAULT_LLM_MODEL,
    })
  })

  it('honours LLM_MODEL', () => {
    const cfg = getLlmProxyConfig({ LLM_BASE_URL: 'https://proxy.test', LLM_API_KEY: 'k', LLM_MODEL: 'claude-sonnet' })
    expect(cfg.model).toBe('claude-sonnet')
    expect(cfg.endpoint).toBe('https://proxy.test/chat/completions')
  })

  it('reads process.env by default (per call, not at module load)', () => {
    const saved = { b: process.env.LLM_BASE_URL, k: process.env.LLM_API_KEY }
    try {
      process.env.LLM_BASE_URL = 'https://late.test/v1'
      process.env.LLM_API_KEY = 'late'
      expect(getLlmProxyConfig().endpoint).toBe('https://late.test/v1/chat/completions')
    } finally {
      if (saved.b === undefined) delete process.env.LLM_BASE_URL
      else process.env.LLM_BASE_URL = saved.b
      if (saved.k === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = saved.k
    }
  })

  it('getLlmModel() never throws and falls back to the default', () => {
    expect(getLlmModel({})).toBe(DEFAULT_LLM_MODEL)
    expect(getLlmModel({ LLM_MODEL: 'm' })).toBe('m')
  })
})

describe('chatCompletionsEndpoint — structural validation', () => {
  it('does not double-append /chat/completions', () => {
    expect(chatCompletionsEndpoint('https://p.test/v1/chat/completions')).toBe('https://p.test/v1/chat/completions')
  })

  it.each([
    ['not a url', /not a valid URL/],
    ['http://proxy.example.com/v1', /must use https/],
    ['ftp://proxy.example.com/v1', /must use https/],
    ['https://user:pass@proxy.example.com/v1', /must not embed credentials/],
    ['https://proxy.example.com/v1?x=1', /query string or fragment/],
  ])('rejects %s', (url, re) => {
    expect(() => chatCompletionsEndpoint(url)).toThrow(LlmConfigError)
    expect(() => chatCompletionsEndpoint(url)).toThrow(re)
  })

  it('allows plain http only for loopback', () => {
    expect(chatCompletionsEndpoint('http://localhost:4000')).toBe('http://localhost:4000/chat/completions')
  })
})

describe('requireLlmProxyConfig — fail loudly', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits a structured error log and exits 1 when the env is unset', () => {
    const log = { error: vi.fn() }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`__exit__:${code}`)
    })
    expect(() => requireLlmProxyConfig(log, {})).toThrow('__exit__:1')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(log.error).toHaveBeenCalledWith(
      'LLM proxy configuration invalid',
      expect.objectContaining({ error: expect.stringMatching(/LLM_BASE_URL/), llmBaseUrlSet: false, llmApiKeySet: false })
    )
  })

  it('returns the config when the env is set', () => {
    const log = { error: vi.fn() }
    const cfg = requireLlmProxyConfig(log, { LLM_BASE_URL: 'https://p.test/v1', LLM_API_KEY: 'k' })
    expect(cfg.endpoint).toBe('https://p.test/v1/chat/completions')
    expect(log.error).not.toHaveBeenCalled()
  })
})

describe('assertJsonResponse — non-JSON content-type throws', () => {
  it('throws LlmResponseError with the content-type and a body snippet (retired-endpoint "OK" case)', async () => {
    const err = await assertJsonResponse(fakeResponse({ contentType: 'text/plain', body: 'OK\r\n' })).catch((e) => e)
    expect(err).toBeInstanceOf(LlmResponseError)
    expect(err.message).toMatch(/unexpected Content-Type: text\/plain — body: OK/)
    expect(err.contentType).toBe('text/plain')
    expect(err.status).toBe(200)
  })

  it('throws when the content-type header is missing', async () => {
    await expect(assertJsonResponse(fakeResponse({ body: 'x' }))).rejects.toThrow(/Content-Type: \(none\)/)
  })

  it('bounds the body snippet to 200 chars', async () => {
    const err = await assertJsonResponse(fakeResponse({ contentType: 'text/html', body: 'y'.repeat(5000) })).catch((e) => e)
    expect(err.bodySnippet).toHaveLength(200)
  })

  it('resolves for application/json (with charset)', async () => {
    await expect(assertJsonResponse(fakeResponse({ contentType: 'application/json; charset=utf-8' }))).resolves.toBeUndefined()
    expect(isJsonResponse(fakeResponse({ contentType: 'Application/JSON' }))).toBe(true)
  })
})

describe('llmRequestHeaders', () => {
  it('sends the API key as a bearer token', () => {
    expect(llmRequestHeaders('sk-1')).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-1' })
  })
})
