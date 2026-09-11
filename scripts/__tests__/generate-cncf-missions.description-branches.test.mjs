// Coverage extension for generate-cncf-missions.mjs.
//
// Targets branches in buildDescription (bug-arm error-pattern extraction) and
// buildResolutionSummary (all three source-URL fallback arms) that are not
// exercised by generate-cncf-missions.format-branches.test.mjs. Also covers
// the generateMission end-to-end orchestrator so that regressions in the
// buildMissionJson wiring — including the linkedPR presence/absence branch
// and the non-K8s-native prerequisites arm — are caught.
//
// All pure formatting; no fs, no network, no LLM.

import { describe, it, expect } from 'vitest'
import {
  buildDescription,
  buildResolutionSummary,
  generateMission,
} from '../generate-cncf-missions.mjs'

function mockIssue(overrides = {}) {
  return {
    title: overrides.title || 'Test issue',
    body: overrides.body || 'Some issue body text',
    labels: overrides.labels || [],
    comments: overrides.comments ?? 0,
    reactions: overrides.reactions || { total_count: 0 },
    html_url: overrides.html_url || 'https://github.com/test/repo/issues/1',
    number: overrides.number ?? 1,
    ...overrides,
  }
}

// ─── buildDescription — bug-arm errorMatch branch ─────────────────────

describe('buildDescription — bug arm error extraction', () => {
  it('extracts "error: <message>" from the body and surfaces it as "Users encounter"', () => {
    // No feature-request signals → bug arm. The error pattern must be
    // 10-100 chars after the colon to match.
    const issue = mockIssue({
      title: 'Pod fails on startup',
      body: 'On boot we see error: failed to bind socket on port 8080 already in use',
    })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Users encounter:')
    expect(desc).toContain('failed to bind socket')
    // The community-reported / N+ users suffix is skipped when the error
    // match is used.
    expect(desc).not.toContain('Community-reported issue')
    expect(desc).not.toContain('+ users')
  })

  it('extracts "panic: <message>" from the body', () => {
    const issue = mockIssue({
      title: 'Crash on shutdown',
      body: 'stacktrace shows panic: runtime error: index out of range on shutdown',
    })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Users encounter:')
    expect(desc).toContain('runtime error: index out of range')
  })

  it('extracts "fatal: <message>" case-insensitively', () => {
    const issue = mockIssue({
      title: 'Startup fails to complete',
      body: 'log tail: FATAL: unable to load config file from /etc/app/config.yaml missing',
    })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Users encounter:')
    expect(desc).toContain('unable to load config')
  })

  it('extracts "failed to <message>" pattern', () => {
    const issue = mockIssue({
      title: 'Rollout broken on push',
      body: 'reports: failed to: connect to registry within 30s and rollout stalls',
    })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Users encounter:')
    expect(desc).toContain('connect to registry')
  })

  it('falls back to community-reported when no error/panic/failed-to pattern matches', () => {
    // Reactions < 5, no error pattern → "Community-reported issue." suffix.
    const issue = mockIssue({
      title: 'Widget cannot render on Safari',
      body: 'The widget renders on Chrome and Firefox but not on Safari.',
      reactions: { total_count: 2 },
    })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Community-reported issue')
    expect(desc).not.toContain('Users encounter:')
  })

  it('uses "affects N+ users" suffix when reactions >= 5 and no error pattern', () => {
    const issue = mockIssue({
      title: 'Queries broken under heavy load',
      body: 'Queries stop returning results when many clients connect at once.',
      reactions: { total_count: 42 },
    })
    const desc = buildDescription(issue, {})
    expect(desc).toContain('affects 42+ users')
  })
})

// ─── buildResolutionSummary — source-URL fallback arms ─────────────────

describe('buildResolutionSummary — buildResolutionFallback branches', () => {
  it('prefers the PR link when both pr and issue URLs are present', () => {
    // Short cleanSolution triggers the fallback path.
    const summary = buildResolutionSummary({}, '', 'bug', {
      pr: 'https://github.com/o/r/pull/42',
      issue: 'https://github.com/o/r/issues/41',
    })
    expect(summary).toContain('fix PR')
    expect(summary).toContain('https://github.com/o/r/pull/42')
    // The issue URL is NOT included when the PR arm fires.
    expect(summary).not.toContain('issues/41')
  })

  it('falls back to the issue link when no PR URL is provided', () => {
    const summary = buildResolutionSummary({}, '', 'bug', {
      issue: 'https://github.com/o/r/issues/41',
    })
    expect(summary).toContain('source issue')
    expect(summary).toContain('https://github.com/o/r/issues/41')
  })

  it('uses a generic fallback when neither pr nor issue URL is provided', () => {
    const summary = buildResolutionSummary({}, '', 'bug', {})
    expect(summary).toContain('See the linked issue and PR')
  })

  it('uses the generic fallback when sourceUrls is undefined', () => {
    const summary = buildResolutionSummary({}, '', 'bug', undefined)
    expect(summary).toContain('See the linked issue and PR')
  })

  it('takes the sentence-truncation happy path when cleanSolution is long enough', () => {
    // >50 chars, and the truncation will exceed the 30-char minimum → the
    // truncated summary is returned instead of the fallback.
    const long =
      'Set the timeout to at least 30 seconds and increase the retry backoff. ' +
      'This gives the upstream time to warm up before the health probe fires. ' +
      'A shorter value causes flapping in busy clusters.'
    const summary = buildResolutionSummary({}, long, 'bug', {
      pr: 'https://github.com/o/r/pull/42',
    })
    expect(summary).toContain('Set the timeout')
    // The PR-fallback text must NOT be emitted on the happy path.
    expect(summary).not.toContain('fix PR')
  })
})

// ─── generateMission — end-to-end wiring ──────────────────────────────

describe('generateMission — full document assembly', () => {
  const k8sProject = {
    name: 'kubernetes',
    repo: 'kubernetes/kubernetes',
    maturity: 'graduated',
    category: 'orchestration',
  }

  it('produces a kc-mission-v1 document with the expected top-level shape', async () => {
    const issue = mockIssue({
      title: 'kubelet crashloop on node',
      body: 'error: connection refused when contacting apiserver',
      number: 1234,
      reactions: { total_count: 10 },
      comments: 4,
    })
    const doc = await generateMission(k8sProject, issue, {
      problem: 'kubelet keeps restarting',
      solution: 'Restart the kubelet service and check /var/log/messages for details on the failure to reach the apiserver.',
      yamlSnippets: [],
      steps: ['a', 'b'],
    })
    expect(doc.version).toBe('kc-mission-v1')
    expect(doc.missionClass).toBe('fixer')
    expect(doc.name).toContain('kubernetes-1234')
    expect(doc.mission.title).toBe('kubernetes: kubelet crashloop on node')
    expect(doc.mission.type).toBe('troubleshoot')
    expect(doc.mission.status).toBe('completed')
    expect(doc.metadata.cncfProjects).toEqual(['kubernetes'])
    expect(doc.metadata.maturity).toBe('graduated')
    expect(doc.metadata.reactions).toBe(10)
    expect(doc.metadata.comments).toBe(4)
    // K8s-native project → prerequisites include kubectl.
    expect(doc.prerequisites.tools).toContain('kubectl')
    expect(doc.prerequisites.kubernetes).toBeDefined()
    // No linkedPR → sourceUrls has no pr key.
    expect(doc.metadata.sourceUrls.pr).toBeUndefined()
    expect(doc.metadata.sourceUrls.issue).toBe(issue.html_url)
    // security section is populated.
    expect(doc.security.sanitized).toBe(true)
    expect(doc.security.scannerVersion).toBe('cncf-gen-3.0.0')
  })

  it('includes the linkedPR URL when resolution._linkedPR is present', async () => {
    const issue = mockIssue({
      title: 'race condition in scheduler',
      body: 'panic: concurrent map write when many pods land at once',
      number: 5555,
    })
    const linkedPR = { html_url: 'https://github.com/kubernetes/kubernetes/pull/9999' }
    const doc = await generateMission(k8sProject, issue, {
      problem: 'concurrent map write',
      solution: 'Guard the pod cache mutations with a per-scheduler mutex so parallel schedules cannot race.',
      yamlSnippets: [],
      steps: [],
      _linkedPR: linkedPR,
    })
    expect(doc.metadata.sourceUrls.pr).toBe(linkedPR.html_url)
    // "advanced" bucket via race-condition keyword (+3).
    expect(doc.metadata.difficulty).toBe('advanced')
  })

  it('uses non-K8s prerequisites for a project not in the K8s-native set', async () => {
    // "harbor" is in the NON_K8S_PROJECTS set → isKubernetesNative returns
    // false → prerequisites take the PROJECT_CLI_MAP path.
    const harborProject = {
      name: 'harbor',
      repo: 'goharbor/harbor',
      maturity: 'graduated',
      category: 'security-compliance',
    }
    const issue = mockIssue({ title: 'push fails', body: 'error: 500 from registry' })
    const doc = await generateMission(harborProject, issue, {
      problem: 'push fails',
      solution: 'Check the docker-compose logs for the registry container — a 500 indicates the backing storage is unreachable.',
      yamlSnippets: [],
      steps: [],
    })
    // harbor is mapped to docker-compose+curl in PROJECT_CLI_MAP.
    expect(doc.prerequisites.tools).toContain('docker-compose')
    // No kubectl / kubernetes version pin for non-K8s projects.
    expect(doc.prerequisites.kubernetes).toBeUndefined()
    expect(doc.prerequisites.tools).not.toContain('kubectl')
  })

  it('caps codeSnippets at 3 entries from resolution.yamlSnippets', async () => {
    const issue = mockIssue({ title: 'ingress not routing' })
    const snippets = [
      'apiVersion: v1\nkind: ConfigMap\n# one',
      'apiVersion: v1\nkind: ConfigMap\n# two',
      'apiVersion: v1\nkind: ConfigMap\n# three',
      'apiVersion: v1\nkind: ConfigMap\n# four',
    ]
    const doc = await generateMission(k8sProject, issue, {
      problem: 'ingress not routing',
      solution: 'apply the corrected ingress rule and reload.',
      yamlSnippets: snippets,
      steps: [],
    })
    expect(doc.mission.resolution.codeSnippets).toHaveLength(3)
  })
})
