import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StackOverflowSource } from '../../sources/stackoverflow.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const ORIGINAL_FETCH = globalThis.fetch

const TEST_PROJECT = {
  name: 'KubeVirt',
  repo: 'kubevirt/kubevirt',
  maturity: 'sandbox',
  category: 'virtualization',
  sources: {
    stackoverflow: {
      tags: ['kubernetes', 'kubevirt'],
    },
  },
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = ORIGINAL_ENV[key]
    }
  }
}

describe('StackOverflowSource', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.USE_COPILOT
    delete process.env.COPILOT_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('falls back to text search and deduplicates Stack Overflow questions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          quota_remaining: 50,
          items: [
            {
              question_id: 101,
              score: 15,
              is_answered: true,
              title: 'Tagged result',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              question_id: 101,
              score: 20,
              is_answered: true,
              title: 'Duplicate tagged result',
            },
            {
              question_id: 202,
              score: 18,
              is_answered: true,
              title: 'Text search result',
            },
            {
              question_id: 303,
              score: 18,
              is_answered: true,
              title: 'Processed result',
            },
          ],
        }),
      })
    globalThis.fetch = fetchMock

    const source = new StackOverflowSource({ rateLimitDelay: 0, maxPerProject: 5, minVotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: ['so:303'],
      cursor: null,
    })

    expect(result.items.map(item => item.question_id)).toEqual([101, 202])
    expect(fetchMock.mock.calls[0][0]).toContain('tagged=kubernetes%3Bkubevirt')
    expect(fetchMock.mock.calls[1][0]).toContain('q=KubeVirt%20kubernetes')
  })

  it('builds a mission from a Stack Overflow question and accepted answer', async () => {
    const source = new StackOverflowSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchAcceptedAnswer').mockResolvedValue({
      body: '<ol><li>Inspect the Deployment with kubectl describe deploy virt-api -n kubevirt</li><li>Apply the corrected manifest from /manifests/virt-api.yaml</li></ol><pre><code>apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: virt-api\n</code></pre>',
      is_accepted: true,
    })

    const mission = await source.extractMission({
      question_id: 77,
      title: 'KubeVirt &amp; RBAC error',
      body: '<p>The Deployment fails because of an RBAC denial.</p><pre><code>kubectl auth can-i get pods</code></pre>',
      link: 'https://stackoverflow.com/q/77',
      tags: ['kubernetes', 'rbac'],
      score: 55,
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.metadata.sourceUrls.stackoverflow).toBe('https://stackoverflow.com/q/77')
    expect(mission.metadata.issueTypes).toEqual(['security'])
    expect(mission.metadata.targetResourceKinds).toContain('Deployment')
    expect(mission.mission.title).toBe('KubeVirt: KubeVirt & RBAC error')
    expect(mission.mission.resolution.codeSnippets).toContain('apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: virt-api')
  })
})
