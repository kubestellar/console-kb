import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeMission } from '../../sources/llm-synthesizer.mjs'

/**
 * Coverage for llm-synthesizer.mjs branches not exercised by the existing
 * llm-synthesizer.test.mjs happy-path suite:
 *   - getBackendConfig: no token → returns null (early warn/return in
 *     synthesizeMission)
 *   - Anthropic backend selection + content-block extraction
 *   - OpenAI-compatible non-2xx path returning { error } and retrying up to
 *     LLM_MAX_RETRIES then giving up (return null)
 *   - OpenAI-compatible 429 rate-limit path (retry-after header parse)
 *   - synthesizeMission: parsed.skip=true → return null
 *   - synthesizeMission: response.content empty → return null
 *   - validateAndClean rejection paths: too few valid steps; no
 *     command/actionable content
 *   - extractJSON fallback branches (no fence, brace-only slice)
 *   - synthesizeWithFallback: Copilot exhausts, falls back to Anthropic,
 *     then to GitHub Models
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

function goodMissionPayload(overrides = {}) {
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
    resolution:
      'The controller was pinned to a missing image; updating it to a published tag lets new pods start.',
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

describe('synthesizeMission — additional branch coverage', () => {
  beforeEach(() => {
    restoreEnv()
    // Ensure Copilot path is not selected by default; individual tests opt in.
    process.env.USE_COPILOT = 'false'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('returns null and does not fetch when no backend token is present', async () => {
    // Clear every possible token so getBackendConfig() → null.
    for (const k of ['COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']) {
      delete process.env[k]
    }
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the Anthropic backend when ANTHROPIC_API_KEY is set (no Copilot/LLM tokens)', async () => {
    for (const k of ['COPILOT_TOKEN', 'GITHUB_TOKEN', 'LLM_TOKEN']) delete process.env[k]
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'

    const payload = goodMissionPayload()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'text', text: JSON.stringify(payload) },
        ],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)

    expect(result).not.toBeNull()
    expect(result.difficulty).toBe('intermediate')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(options.headers['x-api-key']).toBe('anthropic-test-key')
    expect(options.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(options.body)
    expect(body.system).toContain('KubeStellar Console knowledge base')
    expect(body.messages[0].role).toBe('user')
  })

  it('OpenAI-compatible non-2xx returns { error } and retries LLM_MAX_RETRIES+1 times, then null', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal server error blob',
    })
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    // Advance timers past the retry sleeps (2s * (attempt+1)).
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).toBeNull()
    // 3 total attempts (attempt 0..LLM_MAX_RETRIES=2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('OpenAI-compatible 429 → rate-limited path sleeps then retries', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()
    const rateLimited = {
      ok: false,
      status: 429,
      headers: { get: (h) => (h === 'retry-after' ? '1' : null) },
      text: async () => 'rate limited',
    }
    const success = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(success)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when the LLM returns skip=true (non-actionable content)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { content: JSON.stringify({ skip: true }) } },
        ],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null when response.content is empty (LLM returned nothing)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('validateAndClean rejects payloads with fewer than 3 usable steps', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = {
      description: 'Only two real steps; one is a banned generic title.',
      steps: [
        { title: 'Understand the problem', description: 'generic filler' },
        {
          title: 'Inspect deployment',
          description: 'Run ```bash\nkubectl get deploy\n```',
        },
        {
          title: 'Patch deployment',
          description: 'Run ```bash\nkubectl set image deploy/x=y\n```',
        },
      ],
      resolution: 'root cause explanation',
      difficulty: 'intermediate',
      type: 'troubleshoot',
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)
    // 2 usable steps < MIN_STEPS=3 → validateAndClean returns null
    expect(result).toBeNull()
  })

  it('validateAndClean rejects payloads with no actionable step (no command/code block)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = {
      description: 'Steps have no commands or code blocks anywhere.',
      steps: [
        { title: 'Inspect deployment', description: 'Read the manifest carefully.' },
        { title: 'Patch deployment', description: 'Update the values in the manifest.' },
        { title: 'Restart pods', description: 'Restart them by hand or through the UI.' },
      ],
      resolution: 'root cause explanation',
      difficulty: 'intermediate',
      type: 'troubleshoot',
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).toBeNull()
  })

  it('extractJSON handles bare-object responses (no fences, no prose)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // The model returned the JSON object directly with no wrapping.
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).not.toBeNull()
    expect(result.steps.length).toBeGreaterThanOrEqual(3)
  })

  it('extractJSON falls back to brace-slice when JSON is embedded in prose without fences', async () => {
    process.env.LLM_TOKEN = 'test-token'
    // Use a payload whose step descriptions do NOT contain triple-backticks;
    // otherwise extractJSON's fence heuristic would kick in and truncate.
    const payload = goodMissionPayload({
      steps: [
        { title: 'Inspect deployment', description: '$ kubectl get deploy app -n default' },
        { title: 'Patch deployment', description: '$ kubectl set image deploy/app app=example:v2' },
        { title: 'Restart pods', description: '$ kubectl rollout restart deploy/app -n default' },
      ],
    })
    const wrapped = `Here you go: ${JSON.stringify(payload)}`
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: wrapped } }],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission(BASE_PARAMS)
    expect(result).not.toBeNull()
  })

  it('synthesizeWithFallback: Copilot exhausts retries, falls back to Anthropic', async () => {
    process.env.COPILOT_TOKEN = 'copilot-tok'
    // Ensure Copilot is preferred (default USE_COPILOT !== 'false')
    delete process.env.USE_COPILOT
    process.env.ANTHROPIC_API_KEY = 'anthropic-tok'

    const payload = goodMissionPayload()
    // First three calls (Copilot attempts 0..2): all return non-2xx.
    // Fourth call: Anthropic fallback returns success.
    const copilotFail = {
      ok: false,
      status: 502,
      text: async () => 'copilot temporarily unavailable',
    }
    const anthropicOk = {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(anthropicOk)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    // Fallback call is Anthropic
    const [fallbackUrl] = fetchMock.mock.calls[3]
    expect(fallbackUrl).toBe('https://api.anthropic.com/v1/messages')
  })
})
