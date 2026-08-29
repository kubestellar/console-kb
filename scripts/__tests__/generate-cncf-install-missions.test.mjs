import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildInstallPrompt,
  formatReport,
  isMissionStale,
  replaceUntilStable,
  serializeSanitizedMissionForFile,
  loadInstallSourcesConfig,
  applyQualityGate,
} from '../generate-cncf-install-missions.mjs'

// ─── buildInstallPrompt ──────────────────────────────────────────────

describe('buildInstallPrompt', () => {
  const baseProject = { name: 'Argo CD', maturity: 'graduated', description: 'GitOps for k8s' }

  it('includes the project name, maturity, and description as headers', () => {
    const p = buildInstallPrompt(baseProject, {})
    expect(p).toContain('## CNCF Project: Argo CD')
    expect(p).toContain('Maturity: graduated')
    expect(p).toContain('Description: GitOps for k8s')
  })

  it('defaults maturity to "sandbox" when the project omits it', () => {
    const p = buildInstallPrompt({ name: 'FooProj' }, {})
    expect(p).toContain('Maturity: sandbox')
  })

  it('emits an empty description line for a missing description field', () => {
    const p = buildInstallPrompt({ name: 'BareProj' }, {})
    expect(p).toContain('Description: ')
  })

  it('includes repository metadata when repoMeta is present', () => {
    const p = buildInstallPrompt(baseProject, {
      repoMeta: { full_name: 'argoproj/argo-cd', stargazers_count: 15000, language: 'Go' },
    })
    expect(p).toContain('Repository: argoproj/argo-cd')
    expect(p).toContain('Stars: 15000 | Language: Go')
  })

  it('includes latest release with the date truncated to YYYY-MM-DD', () => {
    const p = buildInstallPrompt(baseProject, {
      latestRelease: { tag_name: 'v2.9.0', published_at: '2026-01-15T12:00:00Z' },
    })
    expect(p).toContain('Latest Release: v2.9.0 (2026-01-15)')
  })

  it('says "unknown" when latest release has no published_at', () => {
    const p = buildInstallPrompt(baseProject, {
      latestRelease: { tag_name: 'v1.0.0' },
    })
    expect(p).toContain('Latest Release: v1.0.0 (unknown)')
  })

  it('truncates the README section to 4000 characters', () => {
    const long = 'x'.repeat(10000)
    const p = buildInstallPrompt(baseProject, { readme: long })
    expect(p).toContain('## README (excerpt)')
    // The section body itself should be capped at 4000 chars.
    const readmeStart = p.indexOf('## README (excerpt)\n') + '## README (excerpt)\n'.length
    // Grab everything after the header up to the next section marker (or end).
    const rest = p.slice(readmeStart)
    const nextHeader = rest.indexOf('\n\n##')
    const section = nextHeader >= 0 ? rest.slice(0, nextHeader) : rest
    expect(section.length).toBeLessThanOrEqual(4000)
  })

  it('emits helm chart yaml when helmCharts is non-empty', () => {
    const p = buildInstallPrompt(baseProject, {
      helmCharts: [{ chartYaml: 'name: argo\nversion: 1.0', valuesYaml: 'replicas: 3' }],
    })
    expect(p).toContain('## Helm Chart.yaml')
    expect(p).toContain('name: argo')
    expect(p).toContain('## Helm values.yaml (excerpt)')
    expect(p).toContain('replicas: 3')
  })

  it('omits the values.yaml section when valuesYaml is missing', () => {
    const p = buildInstallPrompt(baseProject, {
      helmCharts: [{ chartYaml: 'name: argo' }],
    })
    expect(p).toContain('## Helm Chart.yaml')
    expect(p).not.toContain('## Helm values.yaml')
  })

  it('emits kustomization block when context.kustomize is present', () => {
    const p = buildInstallPrompt(baseProject, {
      kustomize: { kustomization: 'resources:\n  - deploy.yaml' },
    })
    expect(p).toContain('## kustomization.yaml')
    expect(p).toContain('resources:')
  })

  it('emits operator manifest block when context.operatorManifests is present', () => {
    const p = buildInstallPrompt(baseProject, {
      operatorManifests: 'kind: ClusterServiceVersion',
    })
    expect(p).toContain('## Operator Manifest (excerpt)')
    expect(p).toContain('kind: ClusterServiceVersion')
  })

  it('includes an install-mission JSON schema block with slugified name and installMethods', () => {
    const p = buildInstallPrompt({ name: 'Some Fancy Proj', installMethods: ['helm', 'kubectl'] }, {})
    expect(p).toContain('## Required JSON Schema')
    expect(p).toContain('"name": "install-some-fancy-proj"')
    expect(p).toContain('"missionClass": "installer"')
    // helm is listed → 'helm' should be added to prerequisites.tools
    expect(p).toMatch(/"tools":\s*\[\s*"kubectl",\s*"helm"\s*\]/)
  })

  it('defaults installMethods to ["kubectl"] and does not add helm to prerequisites', () => {
    const p = buildInstallPrompt({ name: 'BasicProj' }, {})
    expect(p).toMatch(/"installMethods":\s*\[\s*"kubectl"\s*\]/)
    expect(p).toMatch(/"tools":\s*\[\s*"kubectl"\s*\]/)
  })
})

// ─── formatReport ────────────────────────────────────────────────────

describe('formatReport', () => {
  it('renders header, summary counts, and formatted avgScore', () => {
    const md = formatReport({
      published: 5, drafts: 2, rejected: 1, skipped: 3, errors: 0, avgScore: 72.4567,
    })
    expect(md).toContain('# CNCF Install Mission Generation Report')
    expect(md).toContain('Generated: ')
    expect(md).toContain('Model: ')
    expect(md).toContain('- Published: 5')
    expect(md).toContain('- Drafts: 2')
    expect(md).toContain('- Rejected: 1')
    expect(md).toContain('- Skipped: 3')
    expect(md).toContain('- Errors: 0')
    expect(md).toContain('- Average Score: 72.5')
  })

  it('renders N/A when avgScore is null/undefined', () => {
    const md = formatReport({ published: 0, drafts: 0, rejected: 0, skipped: 0, errors: 0 })
    expect(md).toContain('- Average Score: N/A')
  })

  it('lists projects section when report.projects is non-empty', () => {
    const md = formatReport({
      published: 1, drafts: 0, rejected: 0, skipped: 0, errors: 0, avgScore: 80,
      projects: [
        { name: 'Argo', maturity: 'graduated', score: 85, tier: 'published', installMethods: 'helm,kubectl' },
      ],
    })
    expect(md).toContain('## Projects')
    expect(md).toContain('- **Argo** (graduated): score=85, tier=published, methods=helm,kubectl')
  })

  it('omits the Projects section when report.projects is empty', () => {
    const md = formatReport({
      published: 0, drafts: 0, rejected: 0, skipped: 0, errors: 0, avgScore: 0, projects: [],
    })
    expect(md).not.toContain('## Projects')
  })

  it('lists rejected projects with reasons when rejectedProjects is non-empty', () => {
    const md = formatReport({
      published: 0, drafts: 0, rejected: 1, skipped: 0, errors: 0, avgScore: 0,
      rejectedProjects: [{ name: 'Broken', reason: 'schema errors' }],
    })
    expect(md).toContain('## Rejected Projects')
    expect(md).toContain('- **Broken**: schema errors')
  })

  it('omits rejected-projects section when empty', () => {
    const md = formatReport({
      published: 1, drafts: 0, rejected: 0, skipped: 0, errors: 0, avgScore: 90,
      rejectedProjects: [],
    })
    expect(md).not.toContain('## Rejected Projects')
  })
})

// ─── isMissionStale ──────────────────────────────────────────────────

describe('isMissionStale', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cncf-install-stale-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns true for a mission generated 30 days ago (older than 14-day window)', () => {
    const path = join(dir, 'old.json')
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString()
    writeFileSync(path, JSON.stringify({ metadata: { generatedAt: thirtyDaysAgo } }))
    expect(isMissionStale(path)).toBe(true)
  })

  it('returns false for a mission generated 1 day ago (inside 14-day window)', () => {
    const path = join(dir, 'fresh.json')
    const oneDayAgo = new Date(Date.now() - 1 * 86400_000).toISOString()
    writeFileSync(path, JSON.stringify({ metadata: { generatedAt: oneDayAgo } }))
    expect(isMissionStale(path)).toBe(false)
  })

  it('returns true when the mission has no metadata.generatedAt', () => {
    const path = join(dir, 'no-meta.json')
    writeFileSync(path, JSON.stringify({ mission: { title: 'x' } }))
    expect(isMissionStale(path)).toBe(true)
  })

  it('returns true when the file does not exist (readFileSync throws)', () => {
    expect(isMissionStale(join(dir, 'does-not-exist.json'))).toBe(true)
  })

  it('returns true when the file contains invalid JSON', () => {
    const path = join(dir, 'garbage.json')
    writeFileSync(path, '{not json')
    expect(isMissionStale(path)).toBe(true)
  })
})

// ─── replaceUntilStable ──────────────────────────────────────────────

describe('replaceUntilStable', () => {
  it('removes every occurrence of a global pattern in one pass', () => {
    expect(replaceUntilStable('aaabbbccc', /b/g)).toBe('aaaccc')
  })

  it('iteratively removes nested/overlapping matches until stable', () => {
    // Naive replace('<>', '') on '<<>>' leaves '<>'; must iterate to remove all.
    expect(replaceUntilStable('<<>>', /<>/)).toBe('')
  })

  it('returns input unchanged when the pattern does not match', () => {
    expect(replaceUntilStable('hello', /world/)).toBe('hello')
  })

  it('applies the replacement string (not just deletion) until stable', () => {
    // 'aa' -> 'a' repeatedly collapses to a single 'a'.
    expect(replaceUntilStable('aaaaaa', /aa/, 'a')).toBe('a')
  })

  it('returns empty string when input is empty', () => {
    expect(replaceUntilStable('', /x/)).toBe('')
  })
})

// ─── serializeSanitizedMissionForFile ────────────────────────────────

describe('serializeSanitizedMissionForFile', () => {
  it('serializes a small mission to indented JSON with a trailing newline', () => {
    const s = serializeSanitizedMissionForFile({ name: 'x', mission: { title: 't' } })
    expect(s.endsWith('\n')).toBe(true)
    expect(s).toContain('"name": "x"')
    expect(s).toContain('  "mission"') // indented
  })

  it('throws when the serialized mission exceeds 1,000,000 bytes', () => {
    // Padding as a stringifiable field pushes JSON past 1 MB.
    const huge = { name: 'x', mission: { title: 't', pad: 'a'.repeat(1_000_500) } }
    expect(() => serializeSanitizedMissionForFile(huge)).toThrow(/oversized mission/)
  })

  it('throws when serialized mission contains a <script> tag', () => {
    const bad = { name: 'x', mission: { title: '<script>alert(1)</script>' } }
    expect(() => serializeSanitizedMissionForFile(bad)).toThrow(/unsafe HTML/)
  })

  it('throws when serialized mission contains an inline event handler (onclick=)', () => {
    const bad = { name: 'x', mission: { description: 'foo onclick=\\"evil()\\"' } }
    expect(() => serializeSanitizedMissionForFile(bad)).toThrow(/unsafe HTML/)
  })

  it('accepts a mission containing the word "script" outside a tag context', () => {
    const ok = { name: 'x', mission: { description: 'This installs a shell script for setup.' } }
    expect(() => serializeSanitizedMissionForFile(ok)).not.toThrow()
  })
})

// ─── loadInstallSourcesConfig ────────────────────────────────────────

describe('loadInstallSourcesConfig', () => {
  it('loads the shipped install-sources.yaml and returns a parsed object with quality thresholds', () => {
    const config = loadInstallSourcesConfig()
    expect(config).toBeTypeOf('object')
    expect(config.quality).toBeTypeOf('object')
    // Values from install-sources.yaml
    expect(config.quality.minScore).toBe(60)
    expect(config.quality.draftMinScore).toBe(40)
  })
})

// ─── applyQualityGate ─────────────────────────────────────────────────

describe('applyQualityGate', () => {
  const config = { quality: { minScore: 60, draftMinScore: 40 } }

  const highQualityMission = {
    metadata: {
      tags: ['argo-cd', 'gitops', 'install'],
      targetResourceKinds: ['Deployment'],
      difficulty: 'advanced',
      sourceUrls: { issue: 'https://github.com/x/y/issues/1' },
      reactions: 25,
      cncfProjects: ['argo-cd'],
    },
    mission: {
      description: 'Argo CD server pods crash with CrashLoopBackOff because the admin secret is missing after a fresh Helm install in the argocd namespace.',
      steps: [
        { title: 'Install Argo CD via Helm', description: 'Run `helm install argocd argo/argo-cd -n argocd --create-namespace` to deploy the chart.\n```yaml\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: argocd\n```' },
        { title: 'Check pod status for CrashLoopBackOff', description: 'Run `kubectl get pods -n argocd` to confirm the argocd-server pod is failing.' },
        { title: 'Inspect server logs for the missing secret', description: 'Run `kubectl logs deployment/argocd-server -n argocd` to see the missing argocd-secret error.' },
        { title: 'Recreate the admin secret', description: 'Apply `kubectl create secret generic argocd-secret -n argocd --from-literal=admin.password=changeme` to restore the required secret at /manifests/secret.yaml.' },
        { title: 'Confirm the deployment is healthy', description: 'Run `kubectl rollout status deployment/argocd-server -n argocd` to verify the rollout completed successfully.' },
      ],
      resolution: {
        summary: 'The root cause is that the Helm chart does not auto-generate argocd-secret when installed with custom values, so the server pod fails because it cannot read the admin password. Recreating the secret manually resolves this because argocd-server watches for it at startup.',
        codeSnippets: ['apiVersion: v1\nkind: Secret\nmetadata:\n  name: argocd-secret\n  namespace: argocd\ntype: Opaque'],
      },
    },
  }

  it('returns tier="published" with a numeric score when the mission passes every gate and scores above minScore', () => {
    const result = applyQualityGate(highQualityMission, config)
    expect(result.tier).toBe('published')
    expect(typeof result.score).toBe('number')
    expect(Number.isNaN(result.score)).toBe(false)
    expect(result.score).toBeGreaterThanOrEqual(config.quality.minScore)
    expect(result.gates.every(g => g.pass)).toBe(true)
  })

  it('returns tier="rejected" with a single "security" gate when sensitive data is found', () => {
    const mission = {
      metadata: {},
      mission: {
        description: 'Contains an AWS key AKIAABCDEFGHIJKLMNOP embedded in the steps.',
        steps: [{ title: 'Step', description: 'x' }],
        resolution: { summary: 'x' },
      },
    }
    const result = applyQualityGate(mission, config)
    expect(result.tier).toBe('rejected')
    expect(result.gates).toHaveLength(1)
    expect(result.gates[0].gate).toBe('security')
    expect(result.gates[0].pass).toBe(false)
  })

  it('returns tier="rejected" with a single "malicious" gate when malicious content is found', () => {
    const mission = {
      metadata: {},
      mission: {
        description: 'Injects a payload <script>alert(1)</script> into the page.',
        steps: [{ title: 'Step', description: 'x' }],
        resolution: { summary: 'x' },
      },
    }
    const result = applyQualityGate(mission, config)
    expect(result.tier).toBe('rejected')
    expect(result.gates).toHaveLength(1)
    expect(result.gates[0].gate).toBe('malicious')
    expect(result.gates[0].pass).toBe(false)
  })

  it('fails the "install-cmd" gate when no step contains a recognized install command', () => {
    const mission = {
      ...highQualityMission,
      mission: {
        ...highQualityMission.mission,
        steps: highQualityMission.mission.steps.filter(s => !/helm install/.test(s.description)),
      },
    }
    const result = applyQualityGate(mission, config)
    const installGate = result.gates.find(g => g.gate === 'install-cmd')
    expect(installGate.pass).toBe(false)
  })

  it('fails the "verification" gate when no step contains a recognized verification command', () => {
    const mission = {
      ...highQualityMission,
      mission: {
        ...highQualityMission.mission,
        steps: highQualityMission.mission.steps.filter(s => !/kubectl (get|logs|rollout)/.test(s.description)),
      },
    }
    const result = applyQualityGate(mission, config)
    const verifyGate = result.gates.find(g => g.gate === 'verification')
    expect(verifyGate.pass).toBe(false)
  })

  it('fails the "step-count" gate when the mission has fewer than 3 steps', () => {
    const mission = {
      ...highQualityMission,
      mission: {
        ...highQualityMission.mission,
        steps: highQualityMission.mission.steps.slice(0, 2),
      },
    }
    const result = applyQualityGate(mission, config)
    const stepGate = result.gates.find(g => g.gate === 'step-count')
    expect(stepGate.pass).toBe(false)
  })

  it('returns tier="draft" when the score is between draftMinScore and minScore and a gate fails', () => {
    const mission = {
      metadata: { tags: ['argo-cd'], reactions: 3 },
      mission: {
        description: 'Argo CD server pods crash with CrashLoopBackOff because the admin secret is missing after a fresh install in the argocd namespace.',
        steps: [
          { title: 'Check pod status for CrashLoopBackOff', description: 'Run `kubectl get pods -n argocd` to confirm the argocd-server pod is failing.' },
          { title: 'Inspect server logs for the missing secret', description: 'Run `kubectl logs deployment/argocd-server -n argocd` to see the missing argocd-secret error.' },
          { title: 'Recreate the admin secret manually', description: 'Manually create the argocd-secret with the admin password at /manifests/secret.yaml so the server can authenticate.' },
        ],
        resolution: {
          summary: 'The root cause is that the secret was deleted and never regenerated, so the server pod fails because it cannot read the admin password.',
        },
      },
    }
    const result = applyQualityGate(mission, config)
    expect(result.tier).toBe('draft')
    expect(result.score).toBeGreaterThanOrEqual(config.quality.draftMinScore)
    expect(result.gates.some(g => !g.pass)).toBe(true)
  })

  it('returns tier="rejected" when the score is below draftMinScore', () => {
    const mission = {
      metadata: {},
      mission: {
        description: 'Something is wrong.',
        steps: [
          { title: 'Understand the problem', description: 'Look at it.' },
          { title: 'Apply the fix', description: 'Do the thing.' },
        ],
        resolution: { summary: 'Fixed it.' },
      },
    }
    const result = applyQualityGate(mission, config)
    expect(result.tier).toBe('rejected')
    expect(result.score).toBeLessThan(config.quality.draftMinScore)
  })
})
