import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMission } from '../../sources/base-source.mjs'

// Targets base-source.mjs:126 — the ``[sourceType || 'source']`` default
// branch on the LLM-successful path's ``metadata.sourceUrls`` key. Every
// existing base-source-llm-path.test.mjs case passes ``sourceType: 'github'``,
// so the ``|| 'source'`` right-hand side was uncovered on the LLM path
// (the fallback/regex path's identical short-circuit at :202 is exercised
// by base-source-helpers.test.mjs "defaults difficulty/type/sourceType/…").
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
  solution: 'Scale up the node pool.',
  steps: [{ title: 'Inspect events', description: 'Look at pod events.' }],
  yamlSnippets: ['apiVersion: v1\nkind: Pod'],
  difficulty: 'intermediate',
  type: 'troubleshoot',
  labels: ['scheduling'],
  resourceKinds: ['Pod'],
  sourceUrl: 'https://example.com/issues/42',
  // sourceType intentionally omitted — see file header.
  project: TEST_PROJECT,
}

describe('buildMission — LLM path sourceType default branch', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keys metadata.sourceUrls on the literal "source" when sourceType is omitted (LLM path)', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'LLM description',
      type: 'debug',
      resolution: 'Roll back the change.',
      steps: [{ title: 'Rollback', description: 'kubectl rollout undo' }],
    })

    const mission = await buildMission(BASE_ARGS)

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.metadata.sourceUrls).toEqual({
      source: 'https://example.com/issues/42',
      repo: `https://github.com/${TEST_PROJECT.repo}`,
    })
    // The caller-supplied sourceUrl must not leak into an unexpected key.
    expect(mission.metadata.sourceUrls.github).toBeUndefined()
  })

  it('keys metadata.sourceUrls on the literal "source" when sourceType is an empty string (LLM path)', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'LLM description',
      resolution: 'Fix',
      steps: [],
    })

    const mission = await buildMission({ ...BASE_ARGS, sourceType: '' })

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.metadata.sourceUrls.source).toBe(
      'https://example.com/issues/42',
    )
    expect(mission.metadata.sourceUrls['']).toBeUndefined()
  })
})
