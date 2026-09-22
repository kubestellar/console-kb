/**
 * cncf-mission-builder.test.mjs
 *
 * Direct unit tests for scripts/lib/cncf-mission-builder.mjs. The module's
 * exported functions (buildDescription, buildMissionJson, generateMission,
 * buildResolutionSummary, buildPRBody) are pure and deterministic — a good
 * fit for import-and-call testing.
 *
 * Before this file, cncf-mission-builder.mjs was only reachable through
 * generate-cncf-missions.mjs's subprocess-driven CLI test, and v8 does not
 * instrument coverage across `spawnSync` boundaries (see the comment in
 * vitest.config.mjs). That left ~36% of the module — a 423-line pure helper
 * that shapes every generated kc-mission-v1 document and every PR body — with
 * no direct regression signal. A refactor that inverted a mission-type
 * branch, dropped the ``` fence in a step description, or stopped truncating
 * the resolution summary would have shipped past CI unnoticed.
 *
 * These tests exercise each public export against the branches that actually
 * differ in output: k8s-native vs library projects, feature vs troubleshoot
 * mission types, present vs missing linkedPR / yamlSnippets / cleanSolution,
 * and reaction-count thresholds.
 */
import { describe, it, expect } from 'vitest'
import {
  buildDescription,
  buildMissionJson,
  generateMission,
  buildResolutionSummary,
  buildPRBody,
} from '../lib/cncf-mission-builder.mjs'

// ── Fixtures ─────────────────────────────────────────────────────────

// A K8s-native project with an explicit CLI entry in PROJECT_CLI_MAP is
// deliberately avoided so isKubernetesNative() returns true via the default
// path. category='orchestration' hits K8S_NATIVE_CATEGORIES.
const k8sProject = {
  name: 'argo',
  repo: 'argoproj/argo-cd',
  maturity: 'graduated',
  category: 'orchestration',
}

// A non-K8s project with a CLI mapping (helm is in PROJECT_CLI_MAP).
const nonK8sProject = {
  name: 'helm',
  repo: 'helm/helm',
  maturity: 'graduated',
  category: 'application-definition',
}

// A library project with no CLI at all (grpc: versionCmd is null).
const libraryProject = {
  name: 'grpc',
  repo: 'grpc/grpc',
  maturity: 'graduated',
  category: 'remote-procedure-call',
}

function troubleshootIssue(overrides = {}) {
  return {
    title: 'Deployment fails with connection error',
    body: 'When I deploy, I see:\nerror: connection refused to upstream server on port 5432',
    labels: [{ name: 'bug' }],
    html_url: 'https://github.com/example/repo/issues/42',
    number: 42,
    reactions: { total_count: 12 },
    comments: 5,
    ...overrides,
  }
}

function featureIssue(overrides = {}) {
  return {
    title: 'Add support for OpenTelemetry tracing',
    body: 'Please add OTEL instrumentation to the reconciliation loop.',
    labels: [{ name: 'enhancement' }],
    html_url: 'https://github.com/example/repo/issues/99',
    number: 99,
    reactions: { total_count: 25 },
    comments: 3,
    ...overrides,
  }
}

const resolutionWithSolution = {
  problem: 'Connection refused when the upstream is not reachable.',
  solution:
    'Set the connectionTimeout to a higher value in the deployment manifest and confirm the upstream Service selector matches the pod labels. This is enough text to comfortably exceed the fifty character minimum required by the summary path in buildResolutionSummary.',
  yamlSnippets: ['apiVersion: v1\nkind: Service\nmetadata:\n  name: upstream'],
  prUrl: 'https://github.com/example/repo/pull/50',
}

// ── buildDescription ─────────────────────────────────────────────────

describe('buildDescription', () => {
  it('renders a feature description with a "requested by N+ users" suffix when reactions >= 5', () => {
    const desc = buildDescription(featureIssue({ reactions: { total_count: 10 } }), {})
    expect(desc).toContain('Add support for OpenTelemetry tracing')
    expect(desc).toContain('Requested by 10+ users')
  })

  it('renders a feature description with the generic community suffix when reactions < 5', () => {
    const desc = buildDescription(featureIssue({ reactions: { total_count: 2 } }), {})
    expect(desc).toContain('Community-requested feature')
    expect(desc).not.toContain('2+ users')
  })

  it('extracts the error phrase from a troubleshoot issue body', () => {
    const desc = buildDescription(troubleshootIssue(), {})
    expect(desc).toContain('Users encounter:')
    expect(desc).toContain('connection refused to upstream')
  })

  it('falls back to reaction/community suffix for troubleshoot issues with no error phrase in the body', () => {
    const desc = buildDescription(
      troubleshootIssue({
        body: 'General complaint with no error keyword.',
        reactions: { total_count: 20 },
      }),
      {},
    )
    expect(desc).toContain('This issue affects 20+ users')
    expect(desc).not.toContain('Users encounter:')
  })

  it('uses the community suffix (no user count) when reactions < 5 on a troubleshoot issue', () => {
    const desc = buildDescription(
      troubleshootIssue({
        body: 'General complaint with no error keyword.',
        reactions: { total_count: 1 },
      }),
      {},
    )
    expect(desc).toContain('Community-reported issue')
  })

  it('does not throw when reactions and body are missing', () => {
    const desc = buildDescription(
      { title: 'x', labels: [{ name: 'bug' }], html_url: 'u', number: 1 },
      {},
    )
    expect(typeof desc).toBe('string')
    expect(desc.length).toBeGreaterThan(0)
  })
})

// ── buildResolutionSummary ───────────────────────────────────────────

describe('buildResolutionSummary', () => {
  it('returns the cleaned solution text when it is longer than 50 chars', () => {
    const summary = buildResolutionSummary(
      resolutionWithSolution,
      resolutionWithSolution.solution,
      'troubleshoot',
      { issue: 'https://example/i', pr: 'https://example/p' },
    )
    expect(summary).toContain('connectionTimeout')
    // Truncation runs at sentence boundary and returns a string, but the
    // caller may still cap it — length must be positive and bounded.
    expect(summary.length).toBeGreaterThan(0)
    expect(summary.length).toBeLessThanOrEqual(500)
  })

  it('falls back to the PR link when no cleaned solution is available', () => {
    const summary = buildResolutionSummary(
      { problem: 'x', solution: '', yamlSnippets: [] },
      '',
      'troubleshoot',
      { issue: 'https://example/i', pr: 'https://example/p' },
    )
    expect(summary).toContain('community-verified')
    expect(summary).toContain('https://example/p')
  })

  it('falls back to the issue link when no solution and no PR are available', () => {
    const summary = buildResolutionSummary(
      { problem: 'x', solution: '', yamlSnippets: [] },
      '',
      'troubleshoot',
      { issue: 'https://example/i' },
    )
    expect(summary).toContain('https://example/i')
  })

  it('falls back to the generic sentence when sourceUrls is empty', () => {
    const summary = buildResolutionSummary(
      { problem: 'x', solution: '', yamlSnippets: [] },
      '',
      'troubleshoot',
      {},
    )
    expect(summary).toContain('community-verified solution')
  })

  it('falls back when cleanSolution is short-but-nonzero', () => {
    // <=50 chars triggers the fallback branch.
    const short = 'too short'
    const summary = buildResolutionSummary(
      { problem: 'x', solution: short, yamlSnippets: [] },
      short,
      'troubleshoot',
      { issue: 'https://example/i' },
    )
    expect(summary).toContain('community-verified')
  })
})

// ── buildPRBody ──────────────────────────────────────────────────────

describe('buildPRBody', () => {
  it('includes the project name, issue title, type, source URL, and file path', () => {
    const body = buildPRBody({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: null,
      filePath: 'fixes/cncf/argo/42.json',
      missionType: 'troubleshoot',
    })
    expect(body).toContain('argo')
    expect(body).toContain('Deployment fails with connection error')
    expect(body).toContain('**Type:** troubleshoot')
    expect(body).toContain('https://github.com/example/repo/issues/42')
    expect(body).toContain('`fixes/cncf/argo/42.json`')
    expect(body).toContain('Auto-generated by CNCF Mission Generator')
  })

  it('adds a "Fix PR" line when linkedPR is provided', () => {
    const body = buildPRBody({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: { html_url: 'https://github.com/example/repo/pull/50' },
      filePath: 'fixes/cncf/argo/42.json',
      missionType: 'troubleshoot',
    })
    expect(body).toContain('**Fix PR:** https://github.com/example/repo/pull/50')
  })

  it('omits the "Fix PR" line when linkedPR is falsy', () => {
    const body = buildPRBody({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: null,
      filePath: 'fixes/cncf/argo/42.json',
      missionType: 'troubleshoot',
    })
    expect(body).not.toContain('**Fix PR:**')
  })

  it('reports a reaction count of 0 when the issue has no reactions field', () => {
    const issue = troubleshootIssue()
    delete issue.reactions
    const body = buildPRBody({
      project: k8sProject,
      issue,
      resolution: resolutionWithSolution,
      linkedPR: null,
      filePath: 'x.json',
      missionType: 'troubleshoot',
    })
    expect(body).toContain('(0 reactions)')
  })
})

// ── buildMissionJson / generateMission ───────────────────────────────

describe('buildMissionJson', () => {
  it('produces a well-formed kc-mission-v1 document for a k8s-native troubleshoot issue', () => {
    const issue = troubleshootIssue()
    const doc = buildMissionJson({
      project: k8sProject,
      issue,
      resolution: resolutionWithSolution,
      linkedPR: { html_url: 'https://github.com/example/repo/pull/50' },
      slug: 'argo-42-connection-error',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    expect(doc.version).toBe('kc-mission-v1')
    expect(doc.name).toBe('argo-42-connection-error')
    expect(doc.missionClass).toBe('fixer')
    expect(doc.mission.title).toBe(`${k8sProject.name}: ${issue.title}`)
    expect(doc.mission.type).toBe('troubleshoot')
    expect(doc.mission.status).toBe('completed')
    expect(Array.isArray(doc.mission.steps)).toBe(true)
    expect(doc.mission.steps.length).toBeGreaterThanOrEqual(3)
    expect(doc.metadata.tags).toContain(k8sProject.name)
    expect(doc.metadata.tags).toContain(k8sProject.maturity)
    expect(doc.metadata.tags).toContain('troubleshoot')
    expect(doc.metadata.sourceUrls.issue).toBe(issue.html_url)
    expect(doc.metadata.sourceUrls.pr).toBe('https://github.com/example/repo/pull/50')
    expect(doc.metadata.reactions).toBe(12)
    expect(doc.metadata.comments).toBe(5)
    // generatePrerequisites returns an object shape (tools, description,
    // and for k8s-native projects a kubernetes version); not an array.
    expect(doc.prerequisites).toBeTypeOf('object')
    expect(Array.isArray(doc.prerequisites.tools)).toBe(true)
    expect(doc.security.sanitized).toBe(true)
    expect(doc.security.scannerVersion).toMatch(/^cncf-gen-/)
    // The security scan timestamp is ISO-8601 and Date-parseable.
    expect(new Date(doc.security.scannedAt).toString()).not.toBe('Invalid Date')
  })

  it('omits the PR sourceUrl entirely when linkedPR is null', () => {
    const doc = buildMissionJson({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: null,
      slug: 'argo-42-x',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    expect(doc.metadata.sourceUrls.pr).toBeUndefined()
    expect(doc.mission.resolution.summary).toBeTypeOf('string')
  })

  it('caps codeSnippets at three entries even when many yamlSnippets are provided', () => {
    const many = { ...resolutionWithSolution, yamlSnippets: ['a', 'b', 'c', 'd', 'e'] }
    const doc = buildMissionJson({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: many,
      linkedPR: null,
      slug: 'argo-42-x',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    expect(doc.mission.resolution.codeSnippets.length).toBe(3)
  })

  it('produces steps that use kubectl for a k8s-native project', () => {
    const doc = buildMissionJson({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: null,
      slug: 'argo-42-x',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    const allText = JSON.stringify(doc.mission.steps)
    expect(allText).toContain('kubectl')
  })

  it('produces steps that use the project-specific version command for a non-k8s project', () => {
    const doc = buildMissionJson({
      project: nonK8sProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: null,
      slug: 'helm-42-x',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    const allText = JSON.stringify(doc.mission.steps)
    // helm's versionCmd is 'helm version --short' per PROJECT_CLI_MAP.
    expect(allText).toContain('helm version --short')
  })

  it('produces steps for a library project (no CLI) that describe checking the dependency', () => {
    const doc = buildMissionJson({
      project: libraryProject,
      issue: troubleshootIssue(),
      resolution: resolutionWithSolution,
      linkedPR: null,
      slug: 'grpc-42-x',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    const firstStep = doc.mission.steps[0]
    expect(firstStep.description).toContain('grpc')
    // Library-with-no-CLI branch never emits kubectl or a bare `xxx version` line.
    expect(firstStep.description).not.toContain('kubectl')
  })

  it('produces feature-flavoured steps (no error-symptom framing) when the mission type is "feature"', () => {
    const doc = buildMissionJson({
      project: k8sProject,
      issue: featureIssue(),
      resolution: { problem: '', solution: '', yamlSnippets: [] },
      linkedPR: null,
      slug: 'argo-99-otel',
      missionType: 'feature',
      difficulty: 'intermediate',
    })
    const firstStep = doc.mission.steps[0]
    expect(firstStep.title).toMatch(/current .* deployment|current .* setup/i)
    // Feature steps do NOT contain an "Identify … symptoms" step.
    const anySymptomStep = doc.mission.steps.find(s => /symptoms/i.test(s.title))
    expect(anySymptomStep).toBeUndefined()
  })

  it('emits a helm-upgrade step for k8s-native projects whose resolution mentions "upgrade"', () => {
    const res = { problem: 'x', solution: 'please upgrade to the latest release', yamlSnippets: [] }
    const doc = buildMissionJson({
      project: k8sProject,
      issue: troubleshootIssue(),
      resolution: res,
      linkedPR: null,
      slug: 'argo-42-x',
      missionType: 'troubleshoot',
      difficulty: 'intermediate',
    })
    const stepText = JSON.stringify(doc.mission.steps)
    expect(stepText).toContain('helm upgrade')
  })
})

describe('generateMission (async wrapper)', () => {
  it('returns a kc-mission-v1 document whose slug uses the project + number + title', async () => {
    const issue = troubleshootIssue()
    const doc = await generateMission(k8sProject, issue, resolutionWithSolution)
    expect(doc.version).toBe('kc-mission-v1')
    expect(doc.name).toContain('argo')
    expect(doc.name).toContain('42')
    // The mission type is derived from the "bug" label -> troubleshoot.
    expect(doc.mission.type).toBe('troubleshoot')
  })

  it('honours the _linkedPR shortcut on resolution', async () => {
    const res = {
      ...resolutionWithSolution,
      _linkedPR: { html_url: 'https://github.com/example/repo/pull/77' },
    }
    const doc = await generateMission(k8sProject, troubleshootIssue(), res)
    expect(doc.metadata.sourceUrls.pr).toBe('https://github.com/example/repo/pull/77')
  })
})
