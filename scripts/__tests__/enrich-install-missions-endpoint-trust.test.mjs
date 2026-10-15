import { describe, it, expect, afterEach, vi } from 'vitest'
import { chatCompletionsEndpoint, LlmConfigError } from '../lib/llm-proxy-config.mjs'
import { callLLM } from '../enrich-install-missions.mjs'

/**
 * Endpoint-trust coverage for enrich-install-missions.mjs.
 *
 * The script used to gate a hard-coded/overridable `LLM_ENDPOINT` (default:
 * the now-retired models.github.ai) against a fixed host allowlist. It now
 * talks only to the env-configured LLM proxy (`LLM_BASE_URL`), whose URL is
 * structurally validated by lib/llm-proxy-config.mjs (console-kb#3702).
 * These tests pin that validation (CWE-441/918) and that callLLM really goes
 * through it.
 */

describe('LLM_BASE_URL structural validation', () => {
  it('accepts an https proxy base URL and appends /chat/completions', () => {
    expect(chatCompletionsEndpoint('https://llm-proxy.example.com/v1')).toBe(
      'https://llm-proxy.example.com/v1/chat/completions'
    )
  })

  it('rejects http:// (scheme downgrade) to a non-loopback host', () => {
    expect(() => chatCompletionsEndpoint('http://llm-proxy.example.com/v1')).toThrow(LlmConfigError)
  })

  it('rejects file:// and other non-HTTP schemes', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,ignored']) {
      expect(() => chatCompletionsEndpoint(bad)).toThrow(LlmConfigError)
    }
  })

  it('rejects an empty string', () => {
    expect(() => chatCompletionsEndpoint('')).toThrow(/not a valid URL/)
  })

  it('rejects credentials embedded in the URL (keys must go in LLM_API_KEY)', () => {
    expect(() => chatCompletionsEndpoint('https://user:secret@llm-proxy.example.com/v1')).toThrow(/credentials/)
  })
})

describe('callLLM uses the validated proxy endpoint', () => {
  const saved = {}
  afterEach(() => {
    for (const k of ['LLM_BASE_URL', 'LLM_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.unstubAllGlobals()
  })

  it('refuses to send mission content to an invalid LLM_BASE_URL', async () => {
    saved.LLM_BASE_URL = process.env.LLM_BASE_URL
    saved.LLM_API_KEY = process.env.LLM_API_KEY
    process.env.LLM_BASE_URL = 'http://evil.example.com/v1'
    process.env.LLM_API_KEY = 'k'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(callLLM({ mission: { title: 't', steps: [] }, metadata: {} })).rejects.toThrow(LlmConfigError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
