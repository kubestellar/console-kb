import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMission } from '../../sources/base-source.mjs'

// Covers the last four uncovered branches in sources/base-source.mjs
// (v8 report: `126,131,153,202`):
//   126 — LLM path, `resourceKinds || []` with falsy resourceKinds
//   131 — LLM path, `[sourceType || 'source']` with falsy sourceType
//   153 — fallback (raw-extraction) path with a plain-string step
//   202 — extractSnippetsFromSteps with `yamlSnippets` undefined
//
// The existing base-source-llm-path.test.mjs / base-source.test.mjs suites
// always supply resourceKinds, sourceType, object-shaped steps, and
// yamlSnippets, so these edge branches were never exercised.

vi.mock('../../sources/llm-synthesizer.mjs', () => ({
  synthesizeMission: vi.fn(),
}))

const { synthesizeMission } = await import('../../sources/llm-synthesizer.mjs')

const PROJECT = {
  name: 'kubernetes',
  repo: 'kubernetes/kubernetes',
  maturity: 'graduated',
  category: 'orchestration',
}

const BASE_ARGS = {
  title: 'Pod stuck in Pending',
  description: 'Node has insufficient CPU.',
  problem: 'Pods enter Pending after scale-down.',
  solution: 'Scale up the node pool.',
  steps: [{ title: 'Inspect events', description: 'Look at pod events.' }],
  yamlSnippets: ['apiVersion: v1\nkind: Pod'],
  difficulty: 'intermediate',
  type: 'troubleshoot',
  labels: ['scheduling'],
  resourceKinds: ['Pod'],
  sourceUrl: 'https://example.com/issues/42',
  sourceType: 'github',
  project: PROJECT,
}

describe('buildMission — missing edge-branch coverage', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('LLM path: resourceKinds undefined defaults metadata.targetResourceKinds to []', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      type: 'debug',
      resolution: 'fix',
      steps: [],
    })

    const mission = await buildMission({ ...BASE_ARGS, resourceKinds: undefined })

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.metadata.targetResourceKinds).toEqual([])
  })

  it("LLM path: sourceType undefined defaults sourceUrls key to 'source'", async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      type: 'debug',
      resolution: 'fix',
      steps: [],
    })

    const mission = await buildMission({
      ...BASE_ARGS,
      sourceType: undefined,
      sourceUrl: 'https://example.com/reference',
    })

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.metadata.sourceUrls).toMatchObject({
      source: 'https://example.com/reference',
      repo: 'https://github.com/kubernetes/kubernetes',
    })
    expect(mission.metadata.sourceUrls.github).toBeUndefined()
  })

  it('fallback path: a plain-string step is normalized to { title, description }', async () => {
    // Force the raw-extraction fallback by making the LLM import reject.
    synthesizeMission.mockRejectedValueOnce(new Error('llm unavailable'))

    const mission = await buildMission({
      ...BASE_ARGS,
      steps: ['Just a single string step describing what to do'],
    })

    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.mission.steps).toHaveLength(1)
    expect(mission.mission.steps[0]).toEqual({
      title: 'Just a single string step describing what to do',
      description: 'Just a single string step describing what to do',
    })
  })

  it('LLM path: labels undefined still produces a deduped tags array (project + maturity)', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      type: 'debug',
      resolution: 'fix',
      steps: [],
    })

    const mission = await buildMission({ ...BASE_ARGS, labels: undefined })

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.metadata.tags).toEqual(['kubernetes', 'graduated'])
  })

  it('LLM path: an LLM step with no description defaults the slice() input to empty string', async () => {
    synthesizeMission.mockResolvedValueOnce({
      description: 'summary',
      type: 'debug',
      resolution: 'fix',
      steps: [{ title: 'no-body step' /* description omitted */ }],
    })

    const mission = await buildMission(BASE_ARGS)

    expect(mission.metadata.synthesizedBy).toBe('llm')
    expect(mission.mission.steps).toHaveLength(1)
    expect(mission.mission.steps[0]).toEqual({
      title: 'no-body step',
      description: '',
    })
  })

  it('fallback path: an object step with missing description defaults to empty string', async () => {
    synthesizeMission.mockRejectedValueOnce(new Error('llm unavailable'))

    const mission = await buildMission({
      ...BASE_ARGS,
      steps: [{ title: 'title only' /* description omitted */ }],
    })

    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.mission.steps[0]).toEqual({
      title: 'title only',
      description: '',
    })
  })

  it('fallback path: undefined steps defaults rawSteps to empty (steps || [])', async () => {
    synthesizeMission.mockRejectedValueOnce(new Error('llm unavailable'))

    const mission = await buildMission({ ...BASE_ARGS, steps: undefined })

    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.mission.steps).toEqual([])
  })

  it('fallback path: undefined yamlSnippets skips the yaml-append branch in extractSnippetsFromSteps', async () => {
    synthesizeMission.mockRejectedValueOnce(new Error('llm unavailable'))

    const mission = await buildMission({
      ...BASE_ARGS,
      yamlSnippets: undefined,
      // Step description has no fenced code, so no snippets come from steps
      // either — the resulting codeSnippets must simply be [].
      steps: [{ title: 'plain', description: 'no code here at all' }],
    })

    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.mission.resolution.codeSnippets).toEqual([])
  })
})
