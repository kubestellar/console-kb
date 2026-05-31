import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseSource, buildMission } from '../../sources/base-source.mjs'

const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

const TEST_PROJECT = {
  name: 'kubernetes',
  repo: 'kubernetes/kubernetes',
  maturity: 'graduated',
  category: 'orchestration',
}

class TestSource extends BaseSource {
  constructor(config = {}) {
    super('test-source', config)
  }
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

describe('BaseSource', () => {
  beforeEach(() => {
    restoreEnv()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    restoreEnv()
  })

  it('applies defaults and allows config overrides', () => {
    const withDefaults = new TestSource({})
    expect(withDefaults.enabled).toBe(true)
    expect(withDefaults.maxPerProject).toBe(20)
    expect(withDefaults.searchWindow).toBe('90d')
    expect(withDefaults.rateLimitDelay).toBe(200)

    const configured = new TestSource({
      enabled: false,
      maxPerProject: 5,
      searchWindow: '30d',
      rateLimitDelay: 15,
    })

    expect(configured.enabled).toBe(false)
    expect(configured.maxPerProject).toBe(5)
    expect(configured.searchWindow).toBe('30d')
    expect(configured.rateLimitDelay).toBe(15)
  })

  it('throws clear errors for unimplemented abstract methods', async () => {
    const source = new TestSource({})

    expect(() => source.canonicalId({})).toThrow('test-source: canonicalId() not implemented')
    await expect(source.search({}, {})).rejects.toThrow('test-source: search() not implemented')
    await expect(source.extractMission({}, {})).rejects.toThrow('test-source: extractMission() not implemented')
  })

  it('uses a longer throttle delay every tenth request', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const source = new TestSource({ rateLimitDelay: 25 })

    const firstDelay = source.throttle()
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 25)
    await vi.runOnlyPendingTimersAsync()
    await firstDelay

    source.requestCount = 9
    const tenthDelay = source.throttle()
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 125)
    await vi.runOnlyPendingTimersAsync()
    await tenthDelay
  })

  it('falls back to raw mission extraction and deduplicates metadata tags', async () => {
    delete process.env.USE_COPILOT
    delete process.env.COPILOT_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const mission = await buildMission({
      title: 'Pod fails to start',
      description: 'Pods enter CrashLoopBackOff after a config change.',
      problem: 'Pods enter CrashLoopBackOff after a config change.',
      solution: 'Apply the corrected ConfigMap and restart the deployment.',
      steps: [
        {
          title: 'Check pod status',
          description: 'Run ```bash\nkubectl get pods -n kube-system\n``` to confirm the failure.',
        },
        'Apply the updated manifest',
      ],
      yamlSnippets: ['apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test-config'],
      difficulty: 'advanced',
      type: 'troubleshoot',
      labels: ['networking', 'networking', 'kubernetes'],
      resourceKinds: ['Pod'],
      sourceUrl: 'https://example.com/issues/1',
      sourceType: 'github',
      project: TEST_PROJECT,
    })

    expect(mission.metadata.synthesizedBy).toBe('regex')
    expect(mission.metadata.tags).toEqual(['kubernetes', 'graduated', 'networking'])
    expect(mission.mission.resolution.codeSnippets).toEqual([
      'kubectl get pods -n kube-system',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test-config',
    ])
  })
})
