// Additional branch coverage for scripts/sources/github-discussions.mjs.
// Existing branch tests cover the search() outer guards and the primary
// per-discussion filters, but three fallback arms remain uncov per the
// v8 branchMap:
//
//   - line 20 : `item.repository?.nameWithOwner || 'unknown'`  (right arm)
//   - line 138: `item.title || 'GitHub Discussion'`             (right arm)
//   - line 139: `item.body  || ''`                              (right arm)
//
// All three are pure — reachable directly through the public
// canonicalId() / extractMission() surface without any fetch mocking.
// canonicalId is used to keyed dedupe; a discussion with no
// nameWithOwner in its GraphQL response (partial payloads that GitHub's
// Discussions API returns when the `repository { nameWithOwner }`
// subselection is stripped, e.g. through a proxy or during scoped-token
// downgrade) must still produce a stable-shape key rather than throw
// or emit `ghd:undefined/N`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubDiscussionsSource } from '../../sources/github-discussions.mjs'

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN
const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

const TEST_PROJECT = {
  name: 'KubeStellar',
  repo: 'kubestellar/console-kb',
  maturity: 'sandbox',
  category: 'orchestration',
}

function restoreEnv() {
  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
}

describe('GitHubDiscussionsSource.canonicalId — repository-missing fallback (line 20)', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token'
    for (const k of ENV_KEYS) delete process.env[k]
  })
  afterEach(restoreEnv)

  it("returns 'ghd:unknown/N' when the discussion payload has no repository object", () => {
    const source = new GitHubDiscussionsSource({ minUpvotes: 1 })
    const id = source.canonicalId({ number: 42 })
    expect(id).toBe('ghd:unknown/42')
  })

  it("still returns 'ghd:unknown/N' when repository exists but nameWithOwner is missing", () => {
    // Optional-chain resolves to `undefined`, then `|| 'unknown'` fires.
    const source = new GitHubDiscussionsSource({ minUpvotes: 1 })
    const id = source.canonicalId({ repository: {}, number: 7 })
    expect(id).toBe('ghd:unknown/7')
  })

  it("uses the real nameWithOwner when present (baseline for the arm)", () => {
    const source = new GitHubDiscussionsSource({ minUpvotes: 1 })
    const id = source.canonicalId({
      repository: { nameWithOwner: 'kubestellar/console-kb' },
      number: 99,
    })
    expect(id).toBe('ghd:kubestellar/console-kb/99')
  })
})

describe('GitHubDiscussionsSource.extractMission — title/body fallbacks (lines 138, 139)', () => {
  beforeEach(() => {
    // Deleting GITHUB_TOKEN also disables the LLM synthesis import inside
    // buildMission (llm-synthesizer.mjs's synthesizeMission short-circuits
    // when no LLM token is configured), so extractMission stays inside the
    // fast regex-fallback branch. Without this the test hangs on the
    // outbound LLM call.
    delete process.env.GITHUB_TOKEN
    for (const k of ENV_KEYS) delete process.env[k]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv()
  })

  it("uses 'GitHub Discussion' as the raw title when item.title is missing (line 138 right arm)", async () => {
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0, minUpvotes: 1 })
    // Answer must be >= 50 chars — otherwise extractMission returns null
    // before the title/body fallbacks execute.
    const longAnswer =
      'Add a resource limit block to the container spec and re-roll the deployment for the change to take effect. This works because the kubelet enforces limits at scheduling time.'
    const mission = await source.extractMission(
      {
        // NB: `title` omitted; body IS provided so we only exercise the
        // title fallback in isolation.
        body: 'Body text describing the situation with kubectl output attached.',
        answer: { body: longAnswer },
        url: 'https://github.com/kubestellar/console-kb/discussions/42',
        upvoteCount: 3,
        labels: { nodes: [] },
        category: { slug: 'q-a' },
      },
      TEST_PROJECT,
    )
    expect(mission).not.toBeNull()
    // In the regex-fallback path, mission.mission.title is the raw title
    // string passed into buildMission unchanged.
    expect(mission.mission.title).toBe('KubeStellar: GitHub Discussion')
    // Sanity: the regex-fallback path is the one we're in.
    expect(mission.metadata.synthesizedBy).toBe('regex')
  })

  it("uses '' as the body when item.body is missing (line 139 right arm)", async () => {
    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0, minUpvotes: 1 })
    const longAnswer =
      'Add a resource limit block to the container spec and re-roll the deployment for the change to take effect. This works because the kubelet enforces limits at scheduling time.'
    const mission = await source.extractMission(
      {
        title: 'How to bound container memory',
        // NB: `body` omitted; title IS provided.
        answer: { body: longAnswer },
        url: 'https://github.com/kubestellar/console-kb/discussions/43',
        upvoteCount: 25, // > 20 so difficulty = 'advanced'
        labels: { nodes: [] },
        category: { slug: 'q-a' },
      },
      TEST_PROJECT,
    )
    expect(mission).not.toBeNull()
    // With no body, buildMission's `description || problem || title`
    // falls through to `title` (problem is empty string).
    expect(mission.mission.description).toBe('KubeStellar: How to bound container memory')
    // upvoteCount > 20 → difficulty=advanced (via the ternary in extractMission).
    expect(mission.metadata.difficulty).toBe('advanced')
    expect(mission.metadata.synthesizedBy).toBe('regex')
  })
})
