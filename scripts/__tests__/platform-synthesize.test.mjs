// Behavioural tests for synthesizePlatformMission() in
// scripts/platform/synthesize.mjs — extracted from
// generate-platform-missions.mjs (console-kb#3163). This function was
// previously module-internal and entirely untested (0% coverage,
// console-kb#3182): it drives the LLM call, validates response
// Content-Type, enforces an oversize-response ceiling, and parses the
// nested JSON payload. buildPlatformPrompt is already covered via
// scripts/__tests__/generate-platform-missions.export-helpers.test.mjs
// (re-exported from generate-platform-missions.mjs), so this suite
// focuses on the fetch-wrapping synthesis logic only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthesizePlatformMission } from '../platform/synthesize.mjs'

const PLATFORM = { name: 'Demo Platform', repo: 'demo/platform' }
const CONTEXT = { releases: [], repoMeta: null, readme: null, helmChart: null, helmValues: null, kustomize: null }

function jsonResponse({ status = 200, body = {}, contentType = 'application/json' } = {}) {
  const headers = new Map([['content-type', contentType]])
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function llmResponse(payload) {
  return jsonResponse({ body: { choices: [{ message: { content: JSON.stringify(payload) } }] } })
}

let errorSpy

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  errorSpy.mockRestore()
})

describe('synthesizePlatformMission — happy path', () => {
  it('posts to the trusted LLM endpoint with the built prompt and returns the parsed mission', async () => {
    const payload = { mission: { title: 'Install Demo Platform' } }
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    const result = await synthesizePlatformMission(PLATFORM, CONTEXT)
    expect(result).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\//)
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toMatch(/^Bearer /)
    const body = JSON.parse(options.body)
    expect(body.messages[1].content).toContain('Demo Platform')
    expect(body.response_format).toEqual({ type: 'json_object' })
  })
})

describe('synthesizePlatformMission — failure branches', () => {
  it('returns null on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 500, body: 'server error' })))
    expect(await synthesizePlatformMission(PLATFORM, CONTEXT)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/LLM API error 500/))
  })

  it('returns null when the Content-Type is not application/json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ contentType: 'text/html' })))
    expect(await synthesizePlatformMission(PLATFORM, CONTEXT)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/unexpected Content-Type/))
  })

  it('returns null when the response body exceeds the 1MB ceiling', async () => {
    const huge = 'x'.repeat(1_000_001)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ body: huge })))
    expect(await synthesizePlatformMission(PLATFORM, CONTEXT)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/too large/))
  })

  it('returns null when the LLM response has no message content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ body: { choices: [{ message: {} }] } })))
    expect(await synthesizePlatformMission(PLATFORM, CONTEXT)).toBeNull()
  })

  it('returns null and logs when fetch throws (network error / abort)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    expect(await synthesizePlatformMission(PLATFORM, CONTEXT)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/LLM error: boom/))
  })

  it('returns null when the message content is not valid JSON', async () => {
    const headers = new Map([['content-type', 'application/json']])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      text: async () => JSON.stringify({ choices: [{ message: { content: '{not valid json' } }] }),
    }))
    expect(await synthesizePlatformMission(PLATFORM, CONTEXT)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/LLM error/))
  })
})
