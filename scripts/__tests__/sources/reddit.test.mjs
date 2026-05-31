import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditSource } from '../../sources/reddit.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const ORIGINAL_FETCH = globalThis.fetch

const TEST_PROJECT = {
  name: 'Argo CD',
  repo: 'argoproj/argo-cd',
  maturity: 'incubating',
  category: 'gitops',
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

describe('RedditSource', () => {
  beforeEach(() => {
    restoreEnv()
    delete process.env.USE_COPILOT
    delete process.env.COPILOT_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreEnv()
  })

  it('filters Reddit search results by score, age, and processed IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                id: 'fresh',
                title: 'Fresh solution',
                ups: 45,
                removed_by_category: null,
                over_18: false,
                created_utc: Date.parse('2024-05-03T00:00:00.000Z') / 1000,
              },
            },
            {
              data: {
                id: 'seen',
                title: 'Already seen',
                ups: 45,
                removed_by_category: null,
                over_18: false,
                created_utc: Date.parse('2024-05-03T00:00:00.000Z') / 1000,
              },
            },
            {
              data: {
                id: 'old',
                title: 'Old solution',
                ups: 45,
                removed_by_category: null,
                over_18: false,
                created_utc: Date.parse('2024-03-01T00:00:00.000Z') / 1000,
              },
            },
            {
              data: {
                id: 'low',
                title: 'Low score',
                ups: 3,
                removed_by_category: null,
                over_18: false,
                created_utc: Date.parse('2024-05-03T00:00:00.000Z') / 1000,
              },
            },
          ],
        },
      }),
    })
    globalThis.fetch = fetchMock

    const source = new RedditSource({ rateLimitDelay: 0, subreddits: ['kubernetes'], minUpvotes: 10 })
    const result = await source.search(TEST_PROJECT, {
      lastSearched: '2024-05-01T00:00:00.000Z',
      processedIds: ['reddit:seen'],
      cursor: null,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].data.id).toBe('fresh')
    expect(fetchMock.mock.calls[0][0]).toContain('/r/kubernetes/search.json?q=Argo%20CD')
  })

  it('builds a mission from a Reddit post and top comments', async () => {
    const source = new RedditSource({ rateLimitDelay: 0 })
    vi.spyOn(source, 'fetchTopComments').mockResolvedValue(
      '1. Check pod logs\n2. Apply the manifest\n\n```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: argocd-server\n```\n\nUse kubectl apply -f deploy.yaml to restore the Deployment.'
    )

    const mission = await source.extractMission({
      data: {
        id: 'abc123',
        title: '[Solved] Argo CD deployment crash?',
        selftext: 'The Argo CD Pod fails after an upgrade and needs a manifest change. '.repeat(3) + '\n\n```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: argocd-server\n```',
        permalink: '/r/kubernetes/comments/abc123/argocd_deployment_crash/',
      },
    }, TEST_PROJECT)

    expect(mission).not.toBeNull()
    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.metadata.sourceUrls.reddit).toBe('https://www.reddit.com/r/kubernetes/comments/abc123/argocd_deployment_crash/')
    expect(mission.metadata.targetResourceKinds).toContain('Pod')
    expect(mission.metadata.targetResourceKinds).toContain('Deployment')
    expect(mission.metadata.tags).toContain('gitops')
    expect(mission.mission.steps.map(step => step.title)).toEqual([
      'Check pod logs',
      'Apply the manifest',
    ])
  })
})
