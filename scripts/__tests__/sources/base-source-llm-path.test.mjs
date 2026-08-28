import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMission } from '../../sources/base-source.mjs'

// Mocks the dynamic ``await import('./llm-synthesizer.mjs')`` performed by
// buildMission() so we can exercise the LLM-successful branch. Without this
// mock the LLM call throws in the test environment (no API key, network
// isolation) and buildMission falls back to raw regex extraction — that
// path is already covered by the existing base-source.test.mjs suite. These
// tests target the previously-uncovered lines 102-124 (metadata assembly
// when synthesizeMission returns a mission).
vi.mock('../../sources/llm-synthesizer.mjs', () => ({
  synthesizeMission: vi.fn(),
}))

const { synthesizeMission } = await import('../../sources/llm-synthesizer.mjs')

const TEST_PROJECT = {
  name: 'kubernetes',
  repo: 'kubernetes/kubernetes',
  maturity: 'graduated',
  category: 'orchestration',
}

const BASE_ARGS = {
  title: 'Pod stuck in Pending',
  description: 'Node has insufficient CPU.',
  problem: 'Pods enter Pending after cluster scale-down.',
  solution: 'Scale up the node pool or reduce requests.',
  steps: [
    { title: 'Inspect events', description: 'Look at pod events.' },
  ],
  yamlSnippets: ['apiVersion: v1\nkind: Pod'],
  difficulty: 'intermediate',
  type: 'troubleshoot',
  labels: ['scheduling'],
  resourceKinds: ['Pod'],
  sourceUrl: 'https://example.com/issues/42',
  sourceType: 'github',
  project: TEST_PROJECT,
}

describe('buildMission — LLM-successful path', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('synthesizes a mission from the LLM result when synthesizeMission resolves', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'LLM-authored description of the CrashLoop root cause.',
      type: 'debug',
      difficulty: 'advanced',
      resolution: 'Roll back the ConfigMap change and restart the deployment.',
      steps: [
        {
          title: 'Roll back the ConfigMap',
          description: 'Run ```bash\nkubectl rollout undo deploy/api\n``` to revert.',
        },
        {
          title: 'Verify pod health',
          description: 'kubectl get pods to confirm Running status.',
        },
      ],
    })

    const mission = await buildMission(BASE_ARGS)

    expect(synthesizeMission).toHaveBeenCalledTimes(1)
    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.mission.description).toBe(
      'LLM-authored description of the CrashLoop root cause.',
    )
    // LLM-supplied type wins over the caller-supplied type.
    expect(mission.mission.type).toBe('debug')
    expect(mission.metadata.difficulty).toBe('advanced')
    expect(mission.metadata.issueTypes).toEqual(['debug'])
    expect(mission.mission.steps).toHaveLength(2)
    expect(mission.mission.steps[0].title).toBe('Roll back the ConfigMap')
    // Code snippet is pulled from the LLM step body via extractSnippetsFromSteps.
    expect(mission.mission.resolution.codeSnippets).toContain(
      'kubectl rollout undo deploy/api',
    )
    expect(mission.mission.resolution.summary).toBe(
      'Roll back the ConfigMap change and restart the deployment.',
    )
    expect(mission.version).toBe('kc-mission-v1')
    expect(mission.mission.status).toBe('completed')
    expect(mission.security.sanitized).toBe(true)
  })

  it('truncates LLM-supplied step titles (>120 chars) and descriptions (>3000 chars)', async () => {
    const longTitle = 'T'.repeat(200)
    const longDesc = 'D'.repeat(4000)
    synthesizeMission.mockResolvedValueOnce({
      description: 'ok',
      type: 'troubleshoot',
      resolution: 'ok',
      steps: [{ title: longTitle, description: longDesc }],
    })

    const mission = await buildMission(BASE_ARGS)

    expect(mission.mission.steps[0].title).toHaveLength(120)
    expect(mission.mission.steps[0].description).toHaveLength(3000)
  })

  it('tolerates missing LLM.steps by producing an empty steps array', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary only',
      type: 'troubleshoot',
      resolution: 'apply fix',
      // no steps
    })

    const mission = await buildMission(BASE_ARGS)

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.mission.steps).toEqual([])
    // codeSnippets falls back to yamlSnippets since steps produced none.
    expect(mission.mission.resolution.codeSnippets).toContain(
      'apiVersion: v1\nkind: Pod',
    )
  })

  it('defaults LLM.type / LLM.difficulty to caller values when omitted', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      resolution: 'fix',
      steps: [],
      // no type, no difficulty
    })

    const mission = await buildMission({
      ...BASE_ARGS,
      type: 'howto',
      difficulty: 'beginner',
    })

    expect(mission.mission.type).toBe('howto')
    expect(mission.metadata.difficulty).toBe('beginner')
    expect(mission.metadata.issueTypes).toEqual(['howto'])
  })

  it('defaults LLM.type / difficulty to hard-coded defaults when caller also omits them', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      resolution: 'fix',
      steps: [],
    })

    const mission = await buildMission({
      ...BASE_ARGS,
      type: undefined,
      difficulty: undefined,
    })

    expect(mission.mission.type).toBe('troubleshoot')
    expect(mission.metadata.difficulty).toBe('intermediate')
  })

  it('deduplicates metadata.tags on the LLM path', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      resolution: 'fix',
      steps: [],
    })

    const mission = await buildMission({
      ...BASE_ARGS,
      labels: ['scheduling', 'scheduling', 'kubernetes', 'graduated'],
    })

    // No duplicates: project name + maturity + unique labels only.
    const seen = new Set()
    for (const t of mission.metadata.tags) {
      expect(seen.has(t)).toBe(false)
      seen.add(t)
    }
    expect(mission.metadata.tags).toContain('scheduling')
  })

  it('falls back to raw extraction when synthesizeMission rejects', async () => {
    synthesizeMission.mockRejectedValueOnce(new Error('llm unavailable'))

    const mission = await buildMission(BASE_ARGS)

    expect(mission.metadata.synthesizedBy).toBe('regex')
    // description falls back to caller-supplied description.
    expect(mission.mission.description).toBe(BASE_ARGS.description)
  })
})
