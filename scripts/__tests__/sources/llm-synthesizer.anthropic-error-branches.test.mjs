// Additional branch coverage for scripts/sources/llm-synthesizer.mjs.
//
// The existing llm-synthesizer.branches.test.mjs and .branches-2.test.mjs
// suites cover the OpenAI-compatible 429/non-2xx paths, the Copilot →
// Anthropic fallback, extractJSON fences/braces, and validateAndClean's
// too-few-steps / no-actionable rejections. This module targets the
// branches still uncovered on the Anthropic caller and the
// validateAndClean default arms:
//
//   - callAnthropic 429 → { rateLimited, retryAfterSec } via retry-after
//     header parse; synthesizeMission then retries the 3 attempts.
//   - callAnthropic !ok → { error: '<status>: <body>' } and the same
//     retry-then-return-null flow. Also covers response.text() catch fallback.
//   - callAnthropic content-block fallback (no 'text' block → content=null → warn+null).
//   - validateAndClean: invalid `difficulty` falls back to 'intermediate'.
//   - validateAndClean: invalid `type` falls back to 'troubleshoot'.
//   - validateAndClean: valid `difficulty` and `type` pass through unchanged.
//   - truncate: empty input returns '' (via null/undefined issueBody path).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeMission } from '../../sources/llm-synthesizer.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const ORIGINAL_FETCH = globalThis.fetch

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
}

function goodMissionPayload(overrides = {}) {
  return {
    description: 'CrashLoopBackOff caused by a missing image tag on the deployment.',
    steps: [
      { title: 'Inspect deployment', description: 'Run ```bash\nkubectl get deploy app -o yaml\n```.' },
      { title: 'Patch deployment', description: 'Run ```bash\nkubectl set image deploy/app app=example:v2\n```.' },
      { title: 'Restart pods', description: 'Run ```bash\nkubectl rollout restart deploy/app\n```.' },
    ],
    resolution: 'The controller was pinned to a missing image tag; updating fixes it.',
    difficulty: 'intermediate',
    type: 'troubleshoot',
    ...overrides,
  }
}

const BASE_PARAMS = {
  projectName: 'Example',
  issueTitle: 'A problem',
  issueBody: 'Something is broken.',
  labels: ['bug'],
  solution: 'Fix it.',
  codeSnippets: [],
  prUrl: null,
  prDiff: null,
  sourceUrl: 'https://example.com/issues/1',
}

describe('llm-synthesizer — Anthropic error branches', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.USE_COPILOT = 'false'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('Anthropic 429 → { rateLimited, retryAfterSec } via retry-after header (retries then null)', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    const rateLimited = {
      ok: false,
      status: 429,
      headers: { get: (h) => (h === 'retry-after' ? '2' : null) },
    }
    const fetchMock = vi.fn().mockResolvedValue(rateLimited)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p

    expect(result).toBeNull()
    // 3 total attempts (LLM_MAX_RETRIES=2 + initial)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Every call must be to the Anthropic endpoint (validates backend selection).
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.anthropic.com/v1/messages')
    }
  })

  it('Anthropic 429 with MISSING retry-after header falls back to parseInt("10") = 10', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    const rateLimited = {
      ok: false,
      status: 429,
      headers: { get: () => null },
    }
    const fetchMock = vi.fn().mockResolvedValue(rateLimited)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await p

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('Anthropic non-2xx → { error } wrapping status + trimmed body (retries then null)', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => 'internal anthropic server error blob '.repeat(20),
    })
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // The synthesizer must have warned with the wrapped 500 status.
    const warnCall = console.warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(warnCall).toMatch(/500:/)
  })

  it('Anthropic non-2xx whose response.text() rejects → falls back to empty body via .catch', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: { get: () => null },
      // Reject to exercise the `.catch(() => '')` arm at callAnthropic.
      text: async () => { throw new Error('body read failure') },
    })
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const warnCall = console.warn.mock.calls.map((c) => c.join(' ')).join('\n')
    // Wrapped as "502: " with empty body (from .catch).
    expect(warnCall).toMatch(/502:/)
  })

  it('Anthropic success without any text content block → content=null → empty-response warn + null', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    // Response is 2xx but the content array has no {type: "text"} block.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ content: [{ type: 'tool_use', input: {} }] }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const warnCall = console.warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(warnCall).toMatch(/Empty response/)
  })
})

describe('llm-synthesizer — validateAndClean default arms', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.USE_COPILOT = 'false'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('invalid difficulty falls back to "intermediate"; invalid type falls back to "troubleshoot"', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload({ difficulty: 'wizard', type: 'zzz-unknown' })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    })

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).not.toBeNull()
    expect(result.difficulty).toBe('intermediate')
    expect(result.type).toBe('troubleshoot')
  })

  it('valid non-default difficulty and type pass through unchanged (expert + configure)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload({ difficulty: 'expert', type: 'configure' })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    })

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).not.toBeNull()
    expect(result.difficulty).toBe('expert')
    expect(result.type).toBe('configure')
  })

  it('missing resolution falls back to "" via `|| ""` slice arm', async () => {
    process.env.LLM_TOKEN = 'test-token'
    // parsed.description is required by an outer guard in synthesizeMission
    // (!parsed.description → early return), so only resolution can be
    // omitted here to hit the `(parsed.resolution || '')` right-arm.
    const payload = goodMissionPayload()
    delete payload.resolution
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    })

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).not.toBeNull()
    expect(result.resolution).toBe('')
  })
})

describe('llm-synthesizer — buildPrompt/cleanInput no-body arms', () => {
  beforeEach(() => {
    restoreEnv()
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.USE_COPILOT = 'false'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('omits Labels/PR/Snippets sections when the corresponding params are falsy', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    })
    globalThis.fetch = fetchMock

    // Empty labels, no PR url, no snippets → false arms of the buildPrompt
    // conditionals for those sections.
    const minimalParams = {
      projectName: 'Minimal',
      issueTitle: 'Minimal problem',
      issueBody: 'Only a body.',
      labels: [],
      solution: '',
      codeSnippets: [],
      prUrl: null,
      prDiff: null,
      sourceUrl: 'https://example.com/i/1',
    }
    const result = await synthesizeMission(minimalParams)
    expect(result).not.toBeNull()

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    const userMsg = body.messages.find((m) => m.role === 'user').content
    expect(userMsg).toContain('# Project: Minimal')
    expect(userMsg).toContain('# Issue: Minimal problem')
    // The omitted sections must NOT appear.
    expect(userMsg).not.toContain('## Labels')
    expect(userMsg).not.toContain('## Linked PR')
    expect(userMsg).not.toContain('## Relevant Code/Config')
    expect(userMsg).not.toContain('## Solution')
  })
})
