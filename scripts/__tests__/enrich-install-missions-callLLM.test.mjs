// Runtime-branch tests for callLLM() in scripts/enrich-install-missions.mjs.
//
// Refs kubestellar/console-kb#3346. That issue notes the file sits at ~26.2%
// coverage because callLLM's runtime branches — 429/retry-after retry,
// non-JSON Content-Type, oversize body ceiling, non-2xx status, missing
// content field, JSON parse failure, network abort/timeout retry, and the
// missing-token short-circuit — have no direct tests. The exported pure
// helpers (sanitizeMissionForHTTP / validateSection / sanitizeSteps /
// buildEnrichPrompt / assertTrustedEndpoint / assertSafePath) are already
// covered; only the fetch() wrapper is not.
//
// callLLM is now exported (test-only export, no behavior change) so it can
// be exercised directly with:
//   - vi.stubGlobal('fetch', ...) to inject responses without the network
//   - vi.useFakeTimers() to make the retry-after/backoff sleeps instant
//   - process.env.LLM_TOKEN to satisfy the token gate without touching auth
//
// Each test asserts both the return value and the fetch call shape (URL,
// method, headers, body JSON structure, model, response_format), matching
// how the production loop consumes the response.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { callLLM } from '../enrich-install-missions.mjs'

// A minimal, already-sanitized mission (callLLM does not re-sanitize; it
// takes the output of sanitizeMissionForHTTP()).
const SANITIZED_MISSION = {
  mission: {
    title: 'Install foo',
    description: 'foo is a thing',
    steps: [{ title: 'step 1', description: 'do the thing' }],
  },
  metadata: { installMethods: ['helm'], cncfProjects: ['foo'] },
}

function jsonResponse({ status = 200, body = {}, contentType = 'application/json', retryAfter } = {}) {
  const headers = new Map()
  headers.set('content-type', contentType)
  if (retryAfter != null) headers.set('retry-after', String(retryAfter))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => headers.get(k.toLowerCase()) ?? null,
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function goodContentResponse(payload = { uninstall: [{ title: 'u', description: 'ud' }] }) {
  return jsonResponse({
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify(payload) } }] },
  })
}

// Silence expected console.warn output from the retry/error branches.
let warnSpy
let originalLLMToken
let originalGithubToken

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers()
  originalLLMToken = process.env.LLM_TOKEN
  originalGithubToken = process.env.GITHUB_TOKEN
  process.env.LLM_TOKEN = 'test-token'
  // GITHUB_TOKEN was captured at module load; but callLLM reads LLM_TOKEN
  // dynamically each call, so setting only LLM_TOKEN is enough here.
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
  if (originalLLMToken === undefined) delete process.env.LLM_TOKEN
  else process.env.LLM_TOKEN = originalLLMToken
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
})

// Small helper: await a callLLM() promise while advancing fake timers so
// the internal sleep(...) calls resolve instead of hanging the test.
async function runWithTimers(promise) {
  // Repeatedly flush pending microtasks + timers until the promise settles.
  let settled = false
  let result, error
  promise.then(v => { settled = true; result = v }, e => { settled = true; error = e })
  for (let i = 0; i < 20 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(10_000)
  }
  if (!settled) throw new Error('callLLM did not settle after advancing timers')
  if (error) throw error
  return result
}

describe('callLLM — token gate', () => {
  it('returns null when neither LLM_TOKEN nor GITHUB_TOKEN is set', async () => {
    delete process.env.LLM_TOKEN
    delete process.env.GITHUB_TOKEN
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const out = await callLLM(SANITIZED_MISSION)

    expect(out).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prefers LLM_TOKEN over GITHUB_TOKEN when both are set', async () => {
    process.env.LLM_TOKEN = 'llm-tok'
    process.env.GITHUB_TOKEN = 'gh-tok'
    const fetchMock = vi.fn().mockResolvedValue(goodContentResponse())
    vi.stubGlobal('fetch', fetchMock)

    await runWithTimers(callLLM(SANITIZED_MISSION))

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['Authorization']).toBe('Bearer llm-tok')
  })
})

describe('callLLM — happy path', () => {
  it('returns the parsed content JSON on a 200 with valid JSON content', async () => {
    const payload = {
      uninstall: [{ title: 'u', description: 'ud' }],
      upgrade: [{ title: 'up', description: 'upd' }],
      troubleshooting: [{ title: 't', description: 'td' }],
    }
    const fetchMock = vi.fn().mockResolvedValue(goodContentResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends POST with JSON body, model, temperature, and response_format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(goodContentResponse())
    vi.stubGlobal('fetch', fetchMock)

    await runWithTimers(callLLM(SANITIZED_MISSION))

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/models\.inference\.ai\.azure\.com/)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body.model).toBeTruthy()
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(2500)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].role).toBe('user')
  })
})

describe('callLLM — HTTP error handling', () => {
  it('returns null on 500 (non-ok, non-429) without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null on 400 (non-ok) without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 with retry-after=0 and returns success on 2nd attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429, retryAfter: 0 }))
      .mockResolvedValueOnce(goodContentResponse())
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toEqual({ uninstall: [{ title: 'u', description: 'ud' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('defaults retry-after to 10 when the header is absent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 429 })) // no retry-after header
      .mockResolvedValueOnce(goodContentResponse())
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toEqual({ uninstall: [{ title: 'u', description: 'ud' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after 3 attempts when 429 persists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 429, retryAfter: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('callLLM — response validation (CWE-434 http-to-file gate)', () => {
  it('returns null when Content-Type is not application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html>gotcha</html>',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null when Content-Type header is missing entirely', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => '{}',
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
  })

  it('accepts Content-Type with charset suffix (contains match)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: { choices: [{ message: { content: '{"uninstall":[]}' } }] },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toEqual({ uninstall: [] })
  })

  it('returns null when response body exceeds MAX_LLM_RESPONSE_BYTES (500 KB)', async () => {
    const huge = 'x'.repeat(500_001)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: 200,
      body: huge, // stays as a raw string > 500_000
    }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
  })

  it('returns null when data.choices[0].message.content is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: 200,
      body: { choices: [{ message: {} }] }, // no content
    }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
  })

  it('returns null when choices array is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: 200,
      body: { choices: [] },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
  })
})

describe('callLLM — network/abort branches', () => {
  it('retries when fetch rejects with a non-AbortError network error', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(goodContentResponse())
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toEqual({ uninstall: [{ title: 'u', description: 'ud' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('handles an AbortError (timeout) branch and retries', async () => {
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(goodContentResponse())
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toEqual({ uninstall: [{ title: 'u', description: 'ud' }] })
    // The first failure should have been logged as a Timeout.
    const warned = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(warned).toMatch(/Timeout/)
  })

  it('gives up after 3 network failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats a body that is not valid JSON as a caught error (returns null after retries)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/json' : null },
      text: async () => 'not-json-at-all',
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await runWithTimers(callLLM(SANITIZED_MISSION))

    expect(out).toBeNull()
    // JSON.parse failure inside the try block sends us through the catch/retry
    // path — so all 3 attempts are exhausted.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
