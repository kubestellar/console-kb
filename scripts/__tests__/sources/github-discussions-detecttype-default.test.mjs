import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubDiscussionsSource } from '../../sources/github-discussions.mjs'

// Regression tests for the detectType() default arm in
// sources/github-discussions.mjs (line 227): when the combined
// title/body/answer text contains none of the keyword hooks
// (error/crash/fail, how to/best practice, performance/slow,
// security/rbac), detectType must fall through to the default
// 'troubleshooting' bucket.
//
// The existing github-discussions.branches.test.mjs suite exercises
// several detectType paths indirectly (q-a category short-circuits to
// 'troubleshooting' before detectType runs; 'general' + "best practice"
// keyword steers to 'best-practice'; etc.), but nothing routes a
// non-q-a discussion through detectType with keyword-free content, so
// the default arm at line 227 stayed uncovered.

const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN

const TEST_PROJECT = {
  name: 'KubeStellar',
  repo: 'kubestellar/console-kb',
  maturity: 'sandbox',
  category: 'orchestration',
}

function restoreGithubToken() {
  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN
}

describe('GitHubDiscussionsSource.detectType default fall-through', () => {
  beforeEach(() => {
    restoreGithubToken()
    delete process.env.USE_COPILOT
    delete process.env.COPILOT_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreGithubToken()
  })

  it('non-q-a discussion with no keyword hooks falls through to troubleshooting (line 227)', async () => {
    delete process.env.GITHUB_TOKEN

    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    // Content deliberately avoids every keyword detectType checks:
    //   - error / crash / fail       → troubleshooting
    //   - how to / best practice     → best-practice
    //   - performance / slow         → performance
    //   - security / rbac            → security
    // The 'general' category slug also avoids the q-a short-circuit
    // at line 157, so detectType() actually runs.
    const mission = await source.extractMission(
      {
        title: 'Deployment strategy for streaming workloads',
        body: 'We want to migrate our streaming pipeline to a new cluster and would like guidance on the recommended layout.',
        url: 'https://example.com/streaming',
        upvoteCount: 5,
        answer: {
          body: 'Adopt a topic-per-tenant layout with dedicated node pools per topic tier; keep the ingest side isolated from the analytics side and use a dedicated cluster autoscaler profile. Additional prose after the recommendation ensures the answer clears the minimum length threshold.',
        },
        labels: { nodes: [] },
        category: { slug: 'general' },
      },
      TEST_PROJECT,
    )

    expect(mission).not.toBeNull()
    // The q-a category short-circuit does NOT apply (slug is 'general'),
    // so this value came from detectType(). None of the keyword arms
    // match, so the default 'troubleshooting' must have fired.
    expect(mission.mission.type).toBe('troubleshooting')
  })

  it('detectType keyword arms remain reachable via generic-category slug', async () => {
    // Sanity companion: a non-q-a discussion whose text does trigger a
    // keyword arm must reach that arm, proving the default fall-through
    // above wasn't fired because detectType was skipped altogether.
    delete process.env.GITHUB_TOKEN

    const source = new GitHubDiscussionsSource({ rateLimitDelay: 0 })
    const mission = await source.extractMission(
      {
        title: 'RBAC scoping recommendation for multi-tenant workloads',
        body: 'What is the recommended pattern to scope security boundaries across tenants?',
        url: 'https://example.com/rbac',
        upvoteCount: 5,
        answer: {
          body: 'Use one Namespace per tenant and bind a project-scoped Role via a RoleBinding referencing a tenant-specific ServiceAccount, then layer a NetworkPolicy on top. This satisfies the RBAC isolation requirement without breaking shared platform components.',
        },
        labels: { nodes: [] },
        category: { slug: 'general' },
      },
      TEST_PROJECT,
    )

    expect(mission).not.toBeNull()
    expect(mission.mission.type).toBe('security')
  })
})
