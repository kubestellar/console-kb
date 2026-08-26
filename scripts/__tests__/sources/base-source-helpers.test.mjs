import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMission, slugify } from '../../sources/base-source.mjs'

// Env keys that ``buildMission`` checks indirectly through the dynamic
// import of ./llm-synthesizer.mjs. We restore whatever the runner had so
// no test bleeds a fake token into others (the fallback path requires all
// of these to be absent).
const ENV_KEYS = ['USE_COPILOT', 'COPILOT_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'LLM_TOKEN']
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

function clearLlmEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
}

const TEST_PROJECT = {
  name: 'argo-cd',
  repo: 'argoproj/argo-cd',
  maturity: 'graduated',
  category: 'gitops',
}

describe('slugify', () => {
  it('lowercases and joins non-alphanumeric runs with a single dash', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
  })

  it('collapses long punctuation runs into a single dash', () => {
    expect(slugify('foo!!!___bar')).toBe('foo-bar')
  })

  it('strips leading and trailing dashes produced by the collapse', () => {
    expect(slugify('--- lead & trail ---')).toBe('lead-trail')
  })

  it('preserves interior digits unchanged', () => {
    expect(slugify('KubeVirt v1.2.3 CrashLoop')).toBe('kubevirt-v1-2-3-crashloop')
  })

  it('truncates the output at 80 chars', () => {
    // 100 lowercase letters -> should be cut to exactly 80
    const s = slugify('a'.repeat(100))
    expect(s).toHaveLength(80)
    expect(s).toBe('a'.repeat(80))
  })

  it('empty input maps to empty string', () => {
    expect(slugify('')).toBe('')
    expect(slugify('---')).toBe('')  // all-stripped
  })

  it('unicode letters are stripped as non-alphanumeric', () => {
    // The current regex keeps only [a-z0-9]; documented behavior is
    // that unicode letters (e.g. accents) become separators.
    expect(slugify('café brûlée')).toBe('caf-br-l-e')
  })
})


describe('buildMission (fallback path — LLM unavailable)', () => {
  beforeEach(() => {
    clearLlmEnv()
    // Silence any dynamic-import warnings from the llm-synthesizer probe.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreEnv()
  })

  it('accepts a bare-string step and converts it to a step object', async () => {
    const m = await buildMission({
      title: 'Foo',
      description: 'Foo desc',
      problem: 'Foo problem',
      solution: 'Foo solution',
      steps: ['Do the thing'],
      sourceUrl: 'https://example.com/1',
      sourceType: 'github',
      project: TEST_PROJECT,
    })
    expect(m.mission.steps).toEqual([
      { title: 'Do the thing', description: 'Do the thing' },
    ])
  })

  it('truncates step title at 120 chars and description at 3000 chars', async () => {
    const longTitle = 't'.repeat(300)
    const longDesc = 'd'.repeat(5000)
    const m = await buildMission({
      title: 'x',
      steps: [{ title: longTitle, description: longDesc }],
      sourceUrl: 'https://example.com/2',
      sourceType: 'github',
      project: TEST_PROJECT,
    })
    expect(m.mission.steps[0].title).toHaveLength(120)
    expect(m.mission.steps[0].description).toHaveLength(3000)
  })

  it('extractSnippetsFromSteps skips snippets whose trimmed body is <= 10 chars', async () => {
    const m = await buildMission({
      title: 'x',
      steps: [
        // Short snippet — must be dropped.
        { title: 's', description: 'Run ```bash\nls\n``` first.' },
        // Long enough — must be kept.
        { title: 's2', description: 'Then ```bash\nkubectl get pods -A\n``` to verify.' },
      ],
      sourceUrl: 'https://example.com/3',
      sourceType: 'github',
      project: TEST_PROJECT,
    })
    expect(m.mission.resolution.codeSnippets).toEqual([
      'kubectl get pods -A',
    ])
  })

  it('extractSnippetsFromSteps caps output at 5 code snippets total', async () => {
    // Emit 8 fenced snippets across steps; only the first 5 should survive.
    const stepBody = Array.from({ length: 8 }, (_, i) =>
      '```bash\nkubectl get pods -n namespace-' + i + '-verylong\n```',
    ).join('\n')
    const m = await buildMission({
      title: 'x',
      steps: [{ title: 's', description: stepBody }],
      sourceUrl: 'https://example.com/4',
      sourceType: 'github',
      project: TEST_PROJECT,
    })
    expect(m.mission.resolution.codeSnippets).toHaveLength(5)
    expect(m.mission.resolution.codeSnippets[0]).toContain('namespace-0-verylong')
    expect(m.mission.resolution.codeSnippets[4]).toContain('namespace-4-verylong')
  })

  it('extractSnippetsFromSteps stops consuming yamlSnippets once the 5-cap is reached', async () => {
    // 3 step snippets + 4 yaml snippets should yield exactly 5 (3 + 2).
    const stepBody = Array.from({ length: 3 }, (_, i) =>
      '```yaml\nkind: ConfigMap\nname: step-' + i + '-longish\n```',
    ).join('\n')
    const yamlSnippets = Array.from({ length: 4 }, (_, i) =>
      'apiVersion: v1\nkind: Secret\nmetadata:\n  name: yaml-' + i + '-longish',
    )
    const m = await buildMission({
      title: 'x',
      steps: [{ title: 's', description: stepBody }],
      yamlSnippets,
      sourceUrl: 'https://example.com/5',
      sourceType: 'github',
      project: TEST_PROJECT,
    })
    expect(m.mission.resolution.codeSnippets).toHaveLength(5)
    expect(m.mission.resolution.codeSnippets.slice(0, 3).every(s => s.includes('step-'))).toBe(true)
    expect(m.mission.resolution.codeSnippets.slice(3).every(s => s.includes('yaml-'))).toBe(true)
  })

  it('extractSnippetsFromSteps skips yamlSnippet entries whose trimmed body is <= 10 chars', async () => {
    const m = await buildMission({
      title: 'x',
      steps: [],
      yamlSnippets: ['short', 'apiVersion: v1\nkind: Namespace'],
      sourceUrl: 'https://example.com/6',
      sourceType: 'github',
      project: TEST_PROJECT,
    })
    expect(m.mission.resolution.codeSnippets).toEqual([
      'apiVersion: v1\nkind: Namespace',
    ])
  })

  it('defaults difficulty/type/sourceType/description when omitted', async () => {
    const m = await buildMission({
      title: 'Bare mission',
      sourceUrl: 'https://example.com/7',
      project: TEST_PROJECT,
    })
    expect(m.metadata.difficulty).toBe('intermediate')
    expect(m.metadata.issueTypes).toEqual(['troubleshoot'])
    expect(m.mission.type).toBe('troubleshoot')
    // sourceType falls back to the literal key "source" (see base-source.mjs).
    expect(m.metadata.sourceUrls.source).toBe('https://example.com/7')
    // description falls through to problem || title when both are missing.
    expect(m.mission.description).toBe('Bare mission')
  })

  it('uses problem text as description when description is missing', async () => {
    const m = await buildMission({
      title: 'Bare',
      problem: 'The pod cannot resolve DNS.',
      sourceUrl: 'https://example.com/8',
      project: TEST_PROJECT,
    })
    expect(m.mission.description).toBe('The pod cannot resolve DNS.')
  })

  it('emits a metadata.security block with the current scanner version', async () => {
    const m = await buildMission({
      title: 'Sec',
      sourceUrl: 'https://example.com/9',
      project: TEST_PROJECT,
    })
    expect(m.security.scannerVersion).toBe('cncf-gen-2.0.0')
    expect(m.security.sanitized).toBe(true)
    expect(m.security.findings).toEqual([])
    // scannedAt is an ISO timestamp
    expect(() => new Date(m.security.scannedAt).toISOString())
      .not.toThrow()
  })

  it('emits missionClass=fixer and authorGithub=kubestellar', async () => {
    const m = await buildMission({
      title: 'Attribution check',
      sourceUrl: 'https://example.com/10',
      project: TEST_PROJECT,
    })
    expect(m.missionClass).toBe('fixer')
    expect(m.author).toBe('KubeStellar Bot')
    expect(m.authorGithub).toBe('kubestellar')
    expect(m.version).toBe('kc-mission-v1')
  })

  it('slug embeds project.name and sourceType', async () => {
    const m = await buildMission({
      title: 'Nginx pod CrashLoopBackOff',
      sourceUrl: 'https://example.com/11',
      sourceType: 'stackoverflow',
      project: TEST_PROJECT,
    })
    // slugify lowercases + collapses non-alphanumeric runs, so the slug
    // must contain both the project name and the sourceType tokens.
    expect(m.name).toContain('argo-cd')
    expect(m.name).toContain('stackoverflow')
    expect(m.name).toContain('crashloopbackoff')
  })
})
