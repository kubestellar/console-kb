import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeMission } from '../../sources/llm-synthesizer.mjs'

/**
 * Final branch coverage for scripts/sources/llm-synthesizer.mjs
 * synthesizeWithFallback and the two API-caller helpers.
 *
 * The existing suites cover the happy path (primary Copilot succeeds),
 * the retry path, and one fallback shape (Copilot exhausts + Anthropic
 * fetch throws + GitHub Models succeeds). That leaves these arms open:
 *
 *   - line 185 truthy — Anthropic response.content is non-empty AND the
 *     parsed payload is a valid mission (synthesizeWithFallback returns
 *     validateAndClean(parsed))
 *   - line 187 falsy — Anthropic response.content is non-empty but
 *     parsed.skip is true → fall through to GitHub Models
 *   - line 200 falsy — GitHub Models response.content is empty → fall
 *     through to bottom `return null`
 *   - line 202 falsy — GitHub Models parsed payload lacks required
 *     fields → fall through to bottom `return null`
 *   - line 111 falsy — response.rateLimited=true but retryAfterSec is
 *     absent → wait defaults to 5 (`retryAfterSec || 5`)
 *   - line 240 falsy — callAnthropic response body has no `content`
 *     array → `(data.content || []).find(...)` returns undefined and
 *     `textBlock?.text || null` yields null
 *   - line 264 falsy — callOpenAICompatible 429 response missing the
 *     `retry-after` header → `parseInt(header || '5')`
 *
 * Every test drives only the exported synthesizeMission entry point —
 * production code is not modified. All I/O is mocked through
 * globalThis.fetch.
 */

const ENV_KEYS = [
  'USE_COPILOT',
  'COPILOT_TOKEN',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'LLM_TOKEN',
  'LLM_MAX_TOKENS',
]
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const ORIGINAL_FETCH = globalThis.fetch

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
}

function goodMissionPayload() {
  return {
    description:
      'CrashLoopBackOff occurs because the deployment references an invalid image tag that pull fails.',
    steps: [
      {
        title: 'Inspect deployment',
        description:
          'Run ```bash\nkubectl get deploy app -n default -o yaml\n``` to inspect the image tag.',
      },
      {
        title: 'Patch deployment',
        description:
          'Run ```bash\nkubectl set image deploy/app app=example:v2 -n default\n``` to fix.',
      },
      {
        title: 'Restart pods',
        description:
          'Run ```bash\nkubectl rollout restart deploy/app -n default\n``` to relaunch pods.',
      },
    ],
    resolution: 'Repointing the pod spec at a valid image lets the ReplicaSet reach Ready.',
    difficulty: 'intermediate',
    type: 'troubleshoot',
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

function copilotFail() {
  return { ok: false, status: 502, text: async () => 'copilot down' }
}

describe('synthesizeMission — final synthesizeWithFallback branches', () => {
  beforeEach(() => {
    restoreEnv()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('returns Anthropic-synthesized mission when Copilot exhausts and Anthropic succeeds', async () => {
    // Covers 185 truthy (content non-empty) AND 187 truthy (parsed valid),
    // returning validateAndClean(parsed). GitHub Models must NOT be called
    // in this path because the Anthropic branch already returned.
    process.env.COPILOT_TOKEN = 'copilot-tok'
    delete process.env.USE_COPILOT
    process.env.ANTHROPIC_API_KEY = 'anthropic-tok'
    // LLM_TOKEN intentionally unset — proves anthropic branch returned.
    delete process.env.LLM_TOKEN

    const payload = goodMissionPayload()
    const anthropicOk = {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    }

    const fetchMock = vi
      .fn()
      // Three Copilot attempts, all 5xx.
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      // Anthropic fallback succeeds — synthesizeWithFallback returns here.
      .mockResolvedValueOnce(anthropicOk)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(result.type).toBe('troubleshoot')
    // 3 copilot + 1 anthropic = 4 total; no GitHub Models call.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const [anthropicUrl] = fetchMock.mock.calls[3]
    expect(anthropicUrl).toContain('api.anthropic.com')
  })

  it('falls through Anthropic parsed.skip and returns null when nothing else set', async () => {
    // Covers 187 falsy (parsed.skip=true so no return) plus the bottom
    // `return null` when neither GitHub Models nor further fallbacks are
    // configured. This ALSO covers the `data.content || []` fallback in
    // callAnthropic (line 240 falsy) — the Anthropic body has NO
    // content array at all.
    process.env.COPILOT_TOKEN = 'copilot-tok'
    delete process.env.USE_COPILOT
    process.env.ANTHROPIC_API_KEY = 'anthropic-tok'
    delete process.env.LLM_TOKEN

    // No content array — callAnthropic returns { content: null }, so
    // synthesizeWithFallback's `if (response.content)` is falsy (line 185
    // falsy branch).
    const anthropicNoContent = {
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg_1', role: 'assistant' }),
    }

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(anthropicNoContent)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await p
    vi.useRealTimers()

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('falls through GitHub Models empty content and returns null', async () => {
    // Covers 200 falsy (response.content is empty for github-models
    // fallback) via a body with no `choices` — callOpenAICompatible
    // returns { content: null }. Anthropic path must not be entered.
    process.env.COPILOT_TOKEN = 'copilot-tok'
    delete process.env.USE_COPILOT
    delete process.env.ANTHROPIC_API_KEY
    process.env.LLM_TOKEN = 'gh-tok'

    const ghNoContent = {
      ok: true,
      status: 200,
      json: async () => ({ id: 'chatcmpl_1' }),
    }

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(ghNoContent)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await p
    vi.useRealTimers()

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('falls through GitHub Models parsed.skip and returns null', async () => {
    // Covers 202 falsy — parsed.skip=true means the inner `if` guard is
    // false, so synthesizeWithFallback drops to the bottom return null.
    process.env.COPILOT_TOKEN = 'copilot-tok'
    delete process.env.USE_COPILOT
    delete process.env.ANTHROPIC_API_KEY
    process.env.LLM_TOKEN = 'gh-tok'

    const ghSkip = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ skip: true, reason: 'not a real bug' }) } }],
      }),
    }

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(copilotFail())
      .mockResolvedValueOnce(ghSkip)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await p
    vi.useRealTimers()

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('handles 429 rate-limit with missing retry-after header (defaults to 5s)', async () => {
    // Covers line 111 falsy branch (`response.retryAfterSec || 5`) AND
    // line 264 falsy branch (`response.headers.get('retry-after') || '5'`)
    // in callOpenAICompatible. First attempt = 429 with no retry-after
    // header; second attempt succeeds.
    delete process.env.COPILOT_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    process.env.LLM_TOKEN = 'gh-tok'

    const rateLimit = {
      ok: false,
      status: 429,
      headers: { get: () => null }, // no retry-after → parseInt defaults to '5'
      text: async () => 'rate limit',
    }
    const good = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(goodMissionPayload()) } }],
      }),
    }

    const fetchMock = vi.fn().mockResolvedValueOnce(rateLimit).mockResolvedValueOnce(good)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    // Rate-limit sleep = 5s (default) then success.
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
