import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeMission } from '../../sources/llm-synthesizer.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const ORIGINAL_FETCH = globalThis.fetch
const LONG_TITLE = 'Check '.repeat(30)
const LONG_DESCRIPTION = 'kubectl describe pod example\n'.repeat(180)

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = ORIGINAL_ENV[key]
    }
  }
}

describe('synthesizeMission', () => {
  beforeEach(() => {
    restoreEnv()
    process.env.USE_COPILOT = 'false'
    process.env.LLM_TOKEN = 'test-token'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('builds a cleaned prompt for the OpenAI-compatible backend request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              description: 'Pods fail with CrashLoopBackOff after a broken ConfigMap update.',
              steps: [
                { title: 'Check pod status', description: 'Run ```bash\nkubectl get pods -n kube-system\n``` to find the failing pod.' },
                { title: 'Inspect pod logs', description: 'Run ```bash\nkubectl logs deploy/coredns -n kube-system\n``` to confirm the ConfigMap error.' },
                { title: 'Apply the fix', description: 'Apply ```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: coredns\n``` and restart the deployment.' },
              ],
              resolution: 'The ConfigMap contained an invalid option, so restarting after correcting the manifest restores a valid CoreDNS configuration.',
              difficulty: 'advanced',
              type: 'configure',
            }),
          },
        }],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission({
      projectName: 'CoreDNS',
      issueTitle: 'Codecov noise should be removed from prompts',
      issueBody: 'Pods fail after rollout.\n\n## Codecov\ncoverage delta here\n\n## Root cause\nConfigMap contains an invalid option.',
      labels: ['bug', 'dns'],
      solution: 'Update the ConfigMap and restart the deployment.',
      codeSnippets: [
        'diff --git a/coredns.yaml b/coredns.yaml',
        'kubectl get configmap coredns -n kube-system',
      ],
      prUrl: 'https://github.com/kubernetes/kubernetes/pull/123',
      prDiff: '## What this PR does\nBoilerplate\n\n## Actual fix\nUpdates the CoreDNS ConfigMap.',
      sourceUrl: 'https://github.com/kubernetes/kubernetes/issues/1',
    })

    expect(result).toMatchObject({
      difficulty: 'advanced',
      type: 'configure',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://models.github.ai/inference/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer test-token')

    const body = JSON.parse(options.body)
    expect(body.model).toBe('openai/gpt-4o')

    const prompt = body.messages[1].content
    expect(prompt).toContain('# Project: CoreDNS')
    expect(prompt).toContain('## Labels\nbug, dns')
    expect(prompt).toContain('## Linked PR: https://github.com/kubernetes/kubernetes/pull/123')
    expect(prompt).toContain('kubectl get configmap coredns -n kube-system')
    expect(prompt).not.toContain('Codecov')
    expect(prompt).not.toContain('diff --git')
    expect(prompt).not.toContain('## What this PR does')
    expect(prompt).toContain('## Actual fix\nUpdates the CoreDNS ConfigMap.')
  })

  it('parses fenced JSON responses and normalizes invalid fields', async () => {
    const llmPayload = {
      description: 'CrashLoopBackOff occurs because the deployment references an invalid image tag.'.repeat(20),
      steps: [
        { title: 'Review the fix', description: 'This generic step should be removed.' },
        { title: LONG_TITLE, description: LONG_DESCRIPTION },
        { title: 'Inspect deployment', description: 'Run ```bash\nkubectl get deploy app -n default -o yaml\n``` to inspect the current image tag.' },
        { title: 'Patch deployment', description: 'Run ```bash\nkubectl set image deploy/app app=example:v2 -n default\n``` to update the deployment.' },
      ],
      resolution: 'The controller was pinned to an image tag that no longer existed, so updating the Deployment to a published image allows new pods to start normally.',
      difficulty: 'legendary',
      type: 'mystery',
    }

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: `Here is the mission:\n\n\`\`\`json\n${JSON.stringify(llmPayload, null, 2)}\n\`\`\``,
          },
        }],
      }),
    })
    globalThis.fetch = fetchMock

    const result = await synthesizeMission({
      projectName: 'Example Project',
      issueTitle: 'Deployment uses a missing image tag',
      issueBody: 'Pods fail immediately after rollout.',
      labels: ['bug'],
      solution: 'Update the deployment image tag.',
      codeSnippets: [],
      prUrl: null,
      prDiff: null,
      sourceUrl: 'https://example.com/issues/2',
    })

    expect(result).not.toBeNull()
    expect(result.description.length).toBeLessThanOrEqual(500)
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].title.length).toBeLessThanOrEqual(120)
    expect(result.steps[0].description.length).toBeLessThanOrEqual(3000)
    expect(result.difficulty).toBe('intermediate')
    expect(result.type).toBe('troubleshoot')
    expect(result.steps.some(step => step.title === 'Review the fix')).toBe(false)
  })
})
