import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubDiscussionsSource } from '../../sources/github-discussions.mjs'

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN
const ORIGINAL_FETCH = globalThis.fetch

const TEST_PROJECT = {
  name: 'KubeStellar',
  repo: 'kubestellar/console-kb',
  maturity: 'sandbox',
  category: 'orchestration',
}

const EMPTY_STATE = { lastSearched: null, processedIds: [], cursor: null }

function restoreGithubToken() {
  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN
}

describe('GitHubDiscussionsSource — branch coverage', () => {
  beforeEach(() => {
    restoreGithubToken()
    process.env.GITHUB_TOKEN = 'test-token'
    delete process.env.USE_COPILOT
    delete process.env.COPILOT_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = ORIGINAL_FETCH
    restoreGithubToken()
  })

  // ─── search() token / discussions-disabled guards ─────────────────────

  it('search returns empty when GITHUB_TOKEN is unset', async () => {
    delete process.env.GITHUB_TOKEN
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result).toEqual({ items: [] })
  })

  it('search returns empty when repo has discussions disabled', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: { hasDiscussionsEnabled: false } } }),
    })
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result).toEqual({ items: [] })
  })

  it('search returns empty when hasDiscussionsEnabled probe returns !ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result).toEqual({ items: [] })
  })

  it('search returns empty when hasDiscussionsEnabled probe throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network'))
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result).toEqual({ items: [] })
  })

  // ─── search() page-loop failure branches ──────────────────────────────

  it('search breaks the page loop when the discussions fetch is not ok', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { repository: { hasDiscussionsEnabled: true } } }) })
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) })
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
  })

  it('search breaks the page loop when GraphQL returns errors', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { repository: { hasDiscussionsEnabled: true } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ errors: [{ message: 'rate limited' }] }) })
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
  })

  it('search breaks the page loop when the response has no discussions payload', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { repository: { hasDiscussionsEnabled: true } } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { repository: {} } }) })
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
  })

  it('search catches fetch errors thrown mid-loop and returns collected items', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { repository: { hasDiscussionsEnabled: true } } }) })
      .mockRejectedValueOnce(new Error('timeout'))
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
  })

  it('search skips nodes that are null or lack an answer', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { repository: { hasDiscussionsEnabled: true } } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              discussions: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  null,
                  {
                    number: 20,
                    title: 'Unanswered',
                    body: 'no answer',
                    url: 'https://example.com/20',
                    updatedAt: '2024-05-05T00:00:00.000Z',
                    upvoteCount: 30,
                    answer: null,
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
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const result = await source.search(TEST_PROJECT, EMPTY_STATE)
    expect(result.items).toEqual([])
  })

  // ─── extractMission() null / detectType / difficulty branches ─────────

  it('extractMission returns null when answer is missing or too short', async () => {
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const missing = await source.extractMission(
      { title: 't', body: 'b', url: 'u', upvoteCount: 10, answer: null, labels: { nodes: [] }, category: { slug: 'q-a' } },
      TEST_PROJECT,
    )
    expect(missing).toBeNull()

    const tooShort = await source.extractMission(
      { title: 't', body: 'b', url: 'u', upvoteCount: 10, answer: { body: 'short' }, labels: { nodes: [] }, category: { slug: 'q-a' } },
      TEST_PROJECT,
    )
    expect(tooShort).toBeNull()
  })

  it('extractMission uses bullet steps when there are no numbered steps', async () => {
    delete process.env.GITHUB_TOKEN
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const mission = await source.extractMission(
      {
        title: 'Best practice for pod scaling',
        body: 'How to scale pods reliably?',
        url: 'https://example.com/bp',
        upvoteCount: 8,
        answer: {
          body: '- Configure the HorizontalPodAutoscaler\n- Watch the metrics-server and iterate\n\nAdditional prose after the bullets to keep the answer over the minimum length threshold.',
        },
        labels: { nodes: [] },
        category: { slug: 'general' },
      },
      TEST_PROJECT,
    )
    expect(mission).not.toBeNull()
    expect(mission.mission.steps.map(s => s.title)).toEqual([
      'Configure the HorizontalPodAutoscaler',
      'Watch the metrics-server and iterate',
    ])
    expect(mission.metadata.difficulty).toBe('intermediate')
  })

  it('extractMission marks high-upvote answers as advanced difficulty', async () => {
    delete process.env.GITHUB_TOKEN
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const mission = await source.extractMission(
      {
        title: 'Deep dive on scheduler internals',
        body: 'Detailed question about scheduler pluggability.',
        url: 'https://example.com/deep',
        upvoteCount: 42,
        answer: { body: 'A'.repeat(120) },
        labels: { nodes: [] },
        category: { slug: 'q-a' },
      },
      TEST_PROJECT,
    )
    expect(mission).not.toBeNull()
    expect(mission.metadata.difficulty).toBe('advanced')
  })

  it('extractMission detects security type from non-q-a categories', async () => {
    delete process.env.GITHUB_TOKEN
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const mission = await source.extractMission(
      {
        title: 'RBAC hardening guide',
        body: 'How should we lock down RBAC for tenants?',
        url: 'https://example.com/sec',
        upvoteCount: 6,
        answer: { body: 'Apply strict RBAC roles and audit ServiceAccount bindings across every namespace regularly to prevent lateral movement.' },
        labels: { nodes: [{ name: 'security' }] },
        category: { slug: 'general' },
      },
      TEST_PROJECT,
    )
    expect(mission).not.toBeNull()
    expect(mission.metadata.issueTypes).toEqual(['security'])
    expect(mission.mission.type).toBe('security')
  })

  it('extractMission detects performance type from non-q-a categories', async () => {
    delete process.env.GITHUB_TOKEN
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const mission = await source.extractMission(
      {
        title: 'Cluster is slow under load',
        body: 'Performance issues at scale.',
        url: 'https://example.com/perf',
        upvoteCount: 7,
        answer: { body: 'Investigate slow API server latency, tune the scheduler, and profile the controller-manager to isolate the performance bottleneck.' },
        labels: { nodes: [] },
        category: { slug: 'general' },
      },
      TEST_PROJECT,
    )
    expect(mission).not.toBeNull()
    expect(mission.metadata.issueTypes).toEqual(['performance'])
    expect(mission.mission.type).toBe('performance')
  })
})
