import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubDiscussionsSource } from '../../sources/github-discussions.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const ORIGINAL_FETCH = globalThis.fetch

const TEST_PROJECT = {
  name: 'KubeStellar',
  repo: 'kubestellar/console-kb',
  maturity: 'sandbox',
  category: 'orchestration',
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

describe('GitHubDiscussionsSource', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.COPILOT_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    delete process.env.USE_COPILOT
    process.env.GITHUB_TOKEN = 'test-token'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('searches discussions and filters out skipped items', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { repository: { hasDiscussionsEnabled: true } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
                nodes: [
                  {
                    number: 7,
                    title: 'Useful answer',
                    body: 'Problem description',
                    url: 'https://github.com/kubestellar/console-kb/discussions/7',
                    updatedAt: '2024-05-03T00:00:00.000Z',
                    upvoteCount: 12,
                    answer: { body: 'A'.repeat(80) },
                    labels: { nodes: [] },
                    category: { slug: 'q-a' },
                    repository: { nameWithOwner: 'kubestellar/console-kb' },
                  },
                  {
                    number: 8,
                    title: 'Low votes',
                    body: 'Ignored',
                    url: 'https://github.com/kubestellar/console-kb/discussions/8',
                    updatedAt: '2024-05-03T00:00:00.000Z',
                    upvoteCount: 1,
                    answer: { body: 'A'.repeat(80) },
                    labels: { nodes: [] },
                    category: { slug: 'q-a' },
                    repository: { nameWithOwner: 'kubestellar/console-kb' },
                  },
                  {
                    number: 9,
                    title: 'Already processed',
                    body: 'Ignored',
                    url: 'https://github.com/kubestellar/console-kb/discussions/9',
                    updatedAt: '2024-05-03T00:00:00.000Z',
                    upvoteCount: 12,
                    answer: { body: 'A'.repeat(80) },
                    labels: { nodes: [] },
                    category: { slug: 'q-a' },
                    repository: { nameWithOwner: 'kubestellar/console-kb' },
                  },
                  {
                    number: 10,
                    title: 'Too old',
                    body: 'Ignored',
                    url: 'https://github.com/kubestellar/console-kb/discussions/10',
                    updatedAt: '2024-03-01T00:00:00.000Z',
                    upvoteCount: 12,
                    answer: { body: 'A'.repeat(80) },
                    labels: { nodes: [] },
                    category: { slug: 'q-a' },
                    repository: { nameWithOwner: 'kubestellar/console-kb' },
                  },
                ],
              },
            },
          },
        }),
      })
    globalThis.fetch = fetchMock

    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0, maxPerProject: 3, minUpvotes: 5 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: ['ghd:kubestellar/console-kb/9'],
      cursor: null,
    })

    expect(result.cursor).toBe('cursor-2')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].number).toBe(7)

    const [, searchOptions] = fetchMock.mock.calls[1]
    const searchBody = JSON.parse(searchOptions.body)
    expect(searchBody.variables).toEqual({
      owner: 'kubestellar',
      repo: 'console-kb',
      cursor: null,
    })
  })

  it('extracts a mission from an answered discussion', async () => {
    delete process.env.GITHUB_TOKEN

    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const mission = await source.extractMission({
      number: 11,
      title: 'How to fix the Deployment rollout failure?',
      body: 'The Deployment stays unavailable after the update.\n\n```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: console\n```',
      url: 'https://github.com/kubestellar/console-kb/discussions/11',
      upvoteCount: 25,
      answer: {
        body: '1. Check rollout status\n2. Apply the updated manifest\n\n```bash\nkubectl rollout status deploy/console -n default\nkubectl apply -f deploy.yaml\n```\n\nThe fix works after the Deployment is updated and the new pods become ready.',
      },
      labels: { nodes: [{ name: 'deployment' }, { name: 'help-wanted' }] },
      category: { slug: 'q-a' },
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.metadata.sourceUrls['github-discussions']).toBe('https://github.com/kubestellar/console-kb/discussions/11')
    expect(mission.metadata.targetResourceKinds).toContain('Deployment')
    expect(mission.metadata.tags).toContain('deployment')
    expect(mission.mission.steps.map(step => step.title)).toEqual([
      'Check rollout status',
      'Apply the updated manifest',
    ])
  })
})
