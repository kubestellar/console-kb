import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeMission } from '../../sources/llm-synthesizer.mjs'

/**
 * Third-wave branch coverage for llm-synthesizer.mjs targeting arms not
 * hit by llm-synthesizer.{test,branches,branches-2,anthropic-error-branches,
 * endpoint-and-fallback,fallback-final}.test.mjs.
 *
 * All tests exercise ONLY the exported synthesizeMission entry point —
 * no production changes required. Filed under #3124.
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

function goodPayload(overrides = {}) {
  return {
    description:
      'CrashLoopBackOff occurs because the deployment references an invalid image tag.',
    steps: [
      { title: 'Inspect deployment', description: 'Run ```bash\nkubectl get deploy app\n```' },
      { title: 'Patch deployment', description: 'Run ```bash\nkubectl set image ...\n```' },
      { title: 'Restart pods', description: 'Run ```bash\nkubectl rollout restart\n```' },
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

function llmResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

describe('synthesizeMission — third-wave branch coverage (#3124)', () => {
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

  it('validateAndClean: unknown difficulty and type fall back to defaults (line 452, 454 false arms)', async () => {
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodPayload({ difficulty: 'planetary', type: 'wormhole' })
    globalThis.fetch = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(payload)))

    const result = await synthesizeMission(BASE_PARAMS)

    expect(result).not.toBeNull()
    expect(result.difficulty).toBe('intermediate')
    expect(result.type).toBe('troubleshoot')
  })

  it('validateAndClean: steps missing title or description are filtered out (line 432 filter arm)', async () => {
    // 5 raw steps, 2 of which lack title/description. The remaining 3 must
    // still be actionable and satisfy MIN_STEPS = 3.
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodPayload({
      steps: [
        { title: '', description: 'no title so drop me' },
        { title: 'Only title, no description' },
        { title: 'Inspect deployment', description: 'Run ```bash\nkubectl get deploy app\n```' },
        { title: 'Patch deployment', description: 'Run ```bash\nkubectl set image ...\n```' },
        { title: 'Restart pods', description: 'Run ```bash\nkubectl rollout restart\n```' },
      ],
    })
    globalThis.fetch = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(payload)))

    const result = await synthesizeMission(BASE_PARAMS)

    expect(result).not.toBeNull()
    expect(result.steps).toHaveLength(3)
    expect(result.steps.every((s) => s.title && s.description)).toBe(true)
  })

  it('extractJSON: opening ``` fence with no closing fence falls through to brace-scan (line 415 false arm)', async () => {
    // Content starts with an opening ```json\n fence, contains valid JSON,
    // but has NO closing ``` fence AND no ``` sequence anywhere inside the
    // payload. That forces:
    //   openMatch matches (line 411 true)
    //   closingFence = lastIndexOf('```') === openMatch.index
    //   closingFence > contentStart is FALSE → fall through to the
    //   indexOf('{') / lastIndexOf('}') scan (line 418).
    // A stripped-down payload avoids the ``` embedded in the goodPayload
    // step descriptions (which would otherwise flip closingFence past
    // contentStart and hit the TRUE arm instead).
    process.env.LLM_TOKEN = 'test-token'
    const plainPayload = {
      description: 'CrashLoopBackOff from bad image tag pulls fail.',
      steps: [
        { title: 'Inspect', description: 'Run: kubectl get deploy app -o yaml' },
        { title: 'Patch',   description: 'Run: kubectl set image deploy/app app=example:v2' },
        { title: 'Restart', description: 'Run: kubectl rollout restart deploy/app' },
      ],
      resolution: 'Valid image → ReplicaSet Ready.',
      difficulty: 'intermediate',
      type: 'troubleshoot',
    }
    expect(JSON.stringify(plainPayload)).not.toContain('```')
    const content = '```json\n' + JSON.stringify(plainPayload) // no closing fence
    globalThis.fetch = vi.fn().mockResolvedValue(llmResponse(content))

    const result = await synthesizeMission(BASE_PARAMS)

    expect(result).not.toBeNull()
    expect(result.description).toContain('CrashLoopBackOff')
  })

  it('buildPrompt: all codeSnippets are garbage → "Relevant Code/Config" section is omitted (line 350 length-zero arm)', async () => {
    // Every snippet is filtered by isGarbageSnippet, so cleanSnippets.length === 0
    // and the section is NOT pushed. We can't assert on the prompt directly
    // (buildPrompt is internal), so we assert the LLM still produces a
    // valid mission and inspect the fetch body to confirm the section header
    // never made it into the prompt.
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodPayload()
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(payload)))
    globalThis.fetch = fetchMock

    const result = await synthesizeMission({
      ...BASE_PARAMS,
      codeSnippets: [
        'diff --git a/x b/y\n+++ b/y\n@@\n+hello',
        'This PR has been automatically marked as stale.',
        '## Codecov Report\nImpacted files include...',
      ],
    })

    expect(result).not.toBeNull()
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body)
    const promptText = JSON.stringify(body)
    expect(promptText).not.toContain('Relevant Code/Config')
  })

  it('cleanInput: empty solution text short-circuits and no "Solution / Resolution" section is emitted (line 370 falsy arm)', async () => {
    // solution === '' hits `if (!text) return ''` in cleanInput. The
    // section header must therefore be absent from the prompt.
    process.env.LLM_TOKEN = 'test-token'
    const payload = goodPayload()
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(payload)))
    globalThis.fetch = fetchMock

    const result = await synthesizeMission({ ...BASE_PARAMS, solution: '' })

    expect(result).not.toBeNull()
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body)
    const promptText = JSON.stringify(body)
    // buildPrompt only appends "## Solution / Resolution" when params.solution
    // is truthy at the outer guard; here it is '', so the section is absent.
    expect(promptText).not.toContain('Solution / Resolution')
  })
})
