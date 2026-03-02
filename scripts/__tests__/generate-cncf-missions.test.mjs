import { describe, it, expect } from 'vitest'
import {
  detectMissionType,
  extractLabels,
  extractResourceKinds,
  estimateDifficulty,
  slugify,
  generateMission,
  extractResolutionFromIssue,
  formatReport,
} from '../generate-cncf-missions.mjs'
import { CNCF_PROJECTS, CATEGORY_TO_DIR } from '../cncf-projects.mjs'

// Helper to create a mock issue
function mockIssue(overrides = {}) {
  return {
    title: overrides.title || 'Test issue',
    body: overrides.body || 'Some issue body text',
    labels: overrides.labels || [],
    comments: overrides.comments ?? 2,
    reactions: overrides.reactions || { total_count: 15 },
    html_url: 'https://github.com/test/repo/issues/1',
    number: 1,
    ...overrides,
  }
}

const sampleProject = {
  name: 'kubernetes',
  repo: 'kubernetes/kubernetes',
  maturity: 'graduated',
  category: 'orchestration',
}

describe('detectMissionType', () => {
  it('returns troubleshoot for issue with "bug" label', () => {
    const issue = mockIssue({ labels: [{ name: 'bug' }] })
    expect(detectMissionType(issue)).toBe('troubleshoot')
  })

  it('returns upgrade for issue with "upgrade" in title', () => {
    const issue = mockIssue({ title: 'Upgrade to v2.0 causes breakage' })
    expect(detectMissionType(issue)).toBe('upgrade')
  })

  it('returns deploy for issue with "deploy" keyword', () => {
    const issue = mockIssue({ title: 'Cannot deploy with helm chart' })
    expect(detectMissionType(issue)).toBe('deploy')
  })

  it('returns analyze for issue with "performance" keyword', () => {
    const issue = mockIssue({ labels: [{ name: 'performance' }] })
    expect(detectMissionType(issue)).toBe('analyze')
  })

  it('returns troubleshoot as default for generic issue', () => {
    const issue = mockIssue({ title: 'Something is not working' })
    expect(detectMissionType(issue)).toBe('troubleshoot')
  })
})

describe('slugify', () => {
  it('converts spaces and special chars to dashes', () => {
    expect(slugify('Hello World! @#$% Test')).toBe('hello-world-test')
  })

  it('truncates to max 80 characters', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBeLessThanOrEqual(80)
  })
})

describe('generateMission', () => {
  const resolution = {
    problem: 'Pod is crashing on startup due to misconfigured liveness probe timeout. The default 1s timeout is too short for the initialization.',
    solution: 'Fix the liveness probe configuration by increasing the initial delay and timeout. Set initialDelaySeconds to 30 and timeoutSeconds to 10 to allow sufficient startup time.',
    yamlSnippets: ['apiVersion: v1\nkind: Pod\nmetadata:\n  name: test\nspec:\n  containers:\n  - name: app\n    livenessProbe:\n      initialDelaySeconds: 30'],
    steps: ['Check liveness probe configuration', 'Update timeout value to 10 seconds'],
  }

  it('produces valid kc-mission-v1 format', async () => {
    const issue = mockIssue({ title: 'Pod crash loop' })
    const mission = await generateMission(sampleProject, issue, resolution)
    expect(mission.version).toBe('kc-mission-v1')
    expect(mission.name).toBeDefined()
    expect(mission.missionClass).toBe('solution')
    expect(mission.mission).toBeDefined()
    expect(mission.metadata).toBeDefined()
    expect(mission.prerequisites).toBeDefined()
    expect(mission.security).toBeDefined()
  })

  it('includes correct CNCF project tag', async () => {
    const issue = mockIssue({ title: 'Pod crash loop' })
    const mission = await generateMission(sampleProject, issue, resolution)
    expect(mission.metadata.tags).toContain('kubernetes')
    expect(mission.metadata.cncfProjects).toEqual(['kubernetes'])
  })

  it('mission type matches issue labels', async () => {
    const issue = mockIssue({
      title: 'Memory leak in controller',
      labels: [{ name: 'memory' }],
    })
    const mission = await generateMission(sampleProject, issue, resolution)
    // "memory" triggers 'analyze'
    expect(mission.mission.type).toBe('analyze')
  })
})

describe('extractResolutionFromIssue', () => {
  it('extracts steps from numbered list in comment', () => {
    const issue = mockIssue({ body: 'Problem description' })
    const comments = [
      {
        body: 'Fix:\n1. Stop the pod\n2. Update the config\n3. Restart',
        author_association: 'MEMBER',
      },
    ]
    const result = extractResolutionFromIssue(issue, comments, null)
    expect(result.steps.length).toBeGreaterThanOrEqual(2)
    expect(result.steps).toContain('Stop the pod')
  })

  it('extracts YAML from code blocks', () => {
    const issue = mockIssue({
      body: 'Apply this fix:\n```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n```\n',
    })
    const result = extractResolutionFromIssue(issue, [], null)
    expect(result.yamlSnippets.length).toBeGreaterThanOrEqual(1)
    expect(result.yamlSnippets[0]).toContain('apiVersion')
  })
})

describe('extractResourceKinds', () => {
  it('detects Pod and Deployment from issue text', () => {
    const issue = mockIssue({
      title: 'Pod not starting',
      body: 'The deployment keeps failing and pods are in CrashLoopBackOff',
    })
    const kinds = extractResourceKinds(issue)
    expect(kinds).toContain('Pod')
    expect(kinds).toContain('Deployment')
  })
})

describe('estimateDifficulty', () => {
  it('returns advanced for long issue with many comments', () => {
    const issue = mockIssue({
      title: 'Config flag not being picked up after upgrade',
      body: 'After upgrading the controller, the config flag is ignored.',
      comments: 20,
      labels: [{ name: 'kind/bug' }],
    })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })
})

describe('CNCF_PROJECTS', () => {
  it('has at least 25 entries', () => {
    expect(CNCF_PROJECTS.length).toBeGreaterThanOrEqual(25)
  })
})

describe('CATEGORY_TO_DIR', () => {
  it('maps all categories used by projects', () => {
    const categories = [...new Set(CNCF_PROJECTS.map(p => p.category))]
    for (const cat of categories) {
      expect(CATEGORY_TO_DIR[cat]).toBeDefined()
    }
  })
})
