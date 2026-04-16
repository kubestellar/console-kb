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
  truncateAtWordBoundary,
  buildDescription,
  buildResolutionSummary,
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
    // "Cannot deploy" triggers troubleshoot (broken deployment), not deploy (new install)
    const issue = mockIssue({ title: 'Cannot deploy with helm chart' })
    expect(detectMissionType(issue)).toBe('troubleshoot')
  })

  it('returns deploy for issue with "install" keyword', () => {
    const issue = mockIssue({ title: 'How to install via helm chart' })
    expect(detectMissionType(issue)).toBe('deploy')
  })

  it('returns feature for RFC issues', () => {
    const issue = mockIssue({ title: '[RFC] Automatic Prefix Caching' })
    expect(detectMissionType(issue)).toBe('feature')
  })

  it('returns feature when label says enhancement', () => {
    const issue = mockIssue({ title: 'Add support for X', labels: [{ name: 'enhancement' }] })
    expect(detectMissionType(issue)).toBe('feature')
  })

  it('returns troubleshoot when label says bug', () => {
    const issue = mockIssue({ title: 'Add support for feature X', labels: [{ name: 'kind/bug' }] })
    expect(detectMissionType(issue)).toBe('troubleshoot')
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
    const issue = mockIssue({ title: 'Pod crash loop', number: 1, html_url: 'https://github.com/test/repo/issues/1' })
    const mission = await generateMission(sampleProject, issue, resolution)
    expect(mission.version).toBe('kc-mission-v1')
    expect(mission.name).toBeDefined()
    expect(typeof mission.name).toBe('string')
    expect(mission.missionClass).toBe('fixer')
    expect(mission.mission).toBeDefined()
    expect(mission.mission.type).toBeDefined()
    expect(mission.mission.steps).toBeInstanceOf(Array)
    expect(mission.metadata).toBeDefined()
    expect(mission.prerequisites).toBeDefined()
    expect(mission.security).toBeDefined()
  })

  it('includes correct CNCF project tag', async () => {
    const issue = mockIssue({ title: 'Pod crash loop', number: 1, html_url: 'https://github.com/test/repo/issues/1' })
    const mission = await generateMission(sampleProject, issue, resolution)
    expect(mission.metadata.tags).toContain('kubernetes')
    expect(mission.metadata.cncfProjects).toEqual(['kubernetes'])
  })

  it('mission type matches issue labels', async () => {
    const issue = mockIssue({
      title: 'Memory leak in controller',
      number: 2,
      html_url: 'https://github.com/test/repo/issues/2',
      labels: [{ name: 'memory' }],
    })
    const mission = await generateMission(sampleProject, issue, resolution)
    // "memory" label triggers 'analyze' via detectMissionType
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

describe('truncateAtWordBoundary', () => {
  it('returns text unchanged when under maxLen', () => {
    expect(truncateAtWordBoundary('short text', 100)).toBe('short text')
  })

  it('truncates at word boundary when space is past MIN_TRUNCATION_POINT', () => {
    // "this is a much longer sentence that..." at maxLen 30 → "this is a much longer"
    // (last space at index 21 in the 30-char slice, which is >= MIN_TRUNCATION_POINT of 20)
    const result = truncateAtWordBoundary('this is a much longer sentence that should be cut', 30)
    expect(result).toBe('this is a much longer')
  })

  it('adds ellipsis when option is set', () => {
    const result = truncateAtWordBoundary('this is a much longer sentence that should be cut', 30, { ellipsis: true })
    expect(result).toBe('this is a much longer…')
  })

  it('does not add ellipsis when text is under maxLen', () => {
    const result = truncateAtWordBoundary('short', 100, { ellipsis: true })
    expect(result).toBe('short')
  })
})

describe('buildDescription', () => {
  it('hides reaction count when under 5', () => {
    const issue = mockIssue({ title: 'Some issue', reactions: { total_count: 2 } })
    const desc = buildDescription(issue, {})
    expect(desc).not.toContain('2+ users')
    expect(desc).toContain('Community-')
  })

  it('shows reaction count when 5 or more', () => {
    const issue = mockIssue({ title: 'Some issue', reactions: { total_count: 42 } })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('42+ users')
  })

  it('does not show 0+ users', () => {
    const issue = mockIssue({ title: 'Some issue', reactions: { total_count: 0 } })
    const desc = buildDescription(issue, {})
    expect(desc).not.toContain('0+ users')
  })
})

describe('buildResolutionSummary', () => {
  it('includes PR URL when no clean solution available', () => {
    const result = buildResolutionSummary({}, '', 'troubleshoot', { pr: 'https://github.com/org/repo/pull/123' })
    expect(result).toContain('https://github.com/org/repo/pull/123')
  })

  it('includes issue URL when no PR available', () => {
    const result = buildResolutionSummary({}, '', 'troubleshoot', { issue: 'https://github.com/org/repo/issues/456' })
    expect(result).toContain('https://github.com/org/repo/issues/456')
  })

  it('uses clean solution when long enough', () => {
    const longSolution = 'This is a detailed solution that explains how to fix the problem by changing the configuration. The root cause was a missing env var.'
    const result = buildResolutionSummary({}, longSolution, 'troubleshoot', {})
    expect(result).toContain('missing env var')
  })
})
