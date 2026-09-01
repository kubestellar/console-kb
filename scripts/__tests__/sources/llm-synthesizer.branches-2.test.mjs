import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeMission } from '../../sources/llm-synthesizer.mjs'

/**
 * Second wave of branch coverage for llm-synthesizer.mjs, targeting arms
 * not covered by llm-synthesizer.test.mjs or llm-synthesizer.branches.test.mjs.
 *
 *   - JSON parse failure inside the retry loop (line 113-116 + catch fall-through)
 *   - AbortError / TimeoutError name-based warning branch
 *   - Generic Error branch in the catch block
 *   - extractJSON final `return trimmed` fallback when content has no braces
 *     (still hit via synthesizeMission → JSON.parse throws → retry → null)
 *   - truncate long-text branch (issueBody > 3000 chars) — exercised via
 *     the prompt-building path
 *   - cleanInput empty-text branch (line 341)
 *   - isGarbageSnippet branches: diff --git prefix, "Invalid PR title" line,
 *     high quoted-line ratio, and multi-image markdown
 *   - synthesizeWithFallback: Copilot exhausts, Anthropic fetch throws
 *     inside the try/catch, GitHub Models fallback path is reached
 *
 * All tests exercise ONLY the exported synthesizeMission entry point —
 * no production changes required.
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
    resolution: 'Repointing the pod spec at a valid image lets the ReplicaSet reach Ready.',
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

describe('synthesizeMission — remaining branch coverage', () => {
  beforeEach(() => {
    restoreEnv()
    process.env.USE_COPILOT = 'false'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('retries when the LLM returns malformed JSON on the first attempt, then succeeds', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()

    const bad = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'this is definitely not json' } }],
      }),
    }
    const good = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    // Two fetches: attempt 0 (invalid JSON → throw) + attempt 1 (success).
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('handles AbortError (timeout) name during fetch and retries', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()

    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const good = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    }
    const fetchMock = vi.fn().mockRejectedValueOnce(abortErr).mockResolvedValueOnce(good)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('handles a generic Error thrown by fetch and retries', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()

    const genericErr = new Error('ECONNRESET')
    const good = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    }
    const fetchMock = vi.fn().mockRejectedValueOnce(genericErr).mockResolvedValueOnce(good)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('extractJSON returns the trimmed text unchanged when there are no braces at all', async () => {
    // This exercises extractJSON's final `return trimmed` fallback.
    // Downstream JSON.parse then throws, retries exhaust, result is null.
    process.env.LLM_TOKEN = 'test-token'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'no json here at all just text' } }],
      }),
    })
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('truncates very long issueBody in the prompt (text.length > max branch)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()

    let capturedBody
    const fetchMock = vi.fn().mockImplementation((_url, options) => {
      capturedBody = JSON.parse(options.body)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
      })
    })
    globalThis.fetch = fetchMock

    // 5000 chars of body → truncated to 3000 with '\n... [truncated]' marker.
    const longBody = 'x'.repeat(5000)
    const result = await synthesizeMission({ ...BASE_PARAMS, issueBody: longBody })

    expect(result).not.toBeNull()
    const promptText = capturedBody.messages.find((m) => m.role === 'user').content
    expect(promptText).toContain('... [truncated]')
    // Original 5000-char body must NOT appear in full.
    expect(promptText).not.toContain('x'.repeat(3500))
  })

  it('handles empty issueBody / solution / prDiff (cleanInput early-return branch)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    })
    globalThis.fetch = fetchMock

    // Empty strings drive cleanInput's `if (!text) return ''` branch.
    const result = await synthesizeMission({
      ...BASE_PARAMS,
      issueBody: '',
      solution: '',
      prDiff: '',
    })
    expect(result).not.toBeNull()
  })

  it('filters garbage snippets: diff --git, Invalid PR title, heavy-quoted, and multi-image', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodMissionPayload()

    let capturedBody
    const fetchMock = vi.fn().mockImplementation((_url, options) => {
      capturedBody = JSON.parse(options.body)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
      })
    })
    globalThis.fetch = fetchMock

    // One good snippet plus four different garbage variants — each should
    // be filtered out by isGarbageSnippet's respective branch.
    const goodSnippet = 'kubectl get pods -n default'
    const diffSnippet = 'diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go'
    const invalidPrSnippet = 'Invalid PR title — please follow the template'
    const quotedSnippet =
      '> line one\n> line two\n> line three\n> line four\nplain line'
    const multiImageSnippet =
      '![img1](https://example.com/1.png)\n![img2](https://example.com/2.png)\n![img3](https://example.com/3.png)'

    const result = await synthesizeMission({
      ...BASE_PARAMS,
      codeSnippets: [goodSnippet, diffSnippet, invalidPrSnippet, quotedSnippet, multiImageSnippet],
    })
    expect(result).not.toBeNull()

    const promptText = capturedBody.messages.find((m) => m.role === 'user').content
    expect(promptText).toContain('kubectl get pods -n default')
    // Each garbage marker must have been filtered out of the prompt.
    expect(promptText).not.toContain('diff --git')
    expect(promptText).not.toContain('Invalid PR title')
    expect(promptText).not.toContain('example.com/2.png')
  })

  it('falls through to GitHub Models when Copilot exhausts and Anthropic fetch throws', async () => {
    process.env.COPILOT_TOKEN = 'copilot-tok'
    delete process.env.USE_COPILOT
    process.env.ANTHROPIC_API_KEY = 'anthropic-tok'
    process.env.LLM_TOKEN = 'gh-models-tok'

    const payload = goodMissionPayload()

    const copilotFail = {
      ok: false,
      status: 502,
      text: async () => 'copilot down',
    }
    const anthropicThrow = new Error('anthropic network error')
    const ghModelsOk = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    }

    const fetchMock = vi
      .fn()
      // 3 Copilot attempts fail
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(copilotFail)
      .mockResolvedValueOnce(copilotFail)
      // Anthropic fallback throws → caught, moves to GitHub Models
      .mockRejectedValueOnce(anthropicThrow)
      // GitHub Models fallback succeeds
      .mockResolvedValueOnce(ghModelsOk)
    globalThis.fetch = fetchMock

    vi.useFakeTimers()
    const p = synthesizeMission(BASE_PARAMS)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await p
    vi.useRealTimers()

    expect(result).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(5)
    // Last call = GitHub Models endpoint.
    const [ghUrl] = fetchMock.mock.calls[4]
    expect(ghUrl).toContain('models.github.ai')
  })
})
