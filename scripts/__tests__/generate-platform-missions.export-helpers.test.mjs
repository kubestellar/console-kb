/**
 * Behavioural tests for four helpers newly exported from
 * `scripts/generate-platform-missions.mjs`:
 *
 *   - applyQualityGate(mission)
 *   - buildPlatformPrompt(platform, context)
 *   - checkVersionFreshness(helmRepoUrl, chartName, version)
 *   - isMissionStale(filePath)
 *
 * These previously had only source-drift invariants (verdict / staleness
 * / security drift tests) — they were never actually invoked because they
 * were module-internal. Together they cover the bulk of the mission-
 * generation code path called out in kubestellar/console-kb#3182
 * ("generate-platform-missions.mjs at 10% coverage").
 *
 * Refs #3182 (partial: 4 of the 6 helpers named in the issue now have
 * behavioural coverage; the LLM synthesis path still requires more
 * elaborate mocking and is intentionally deferred to a follow-up PR).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyQualityGate,
  buildPlatformPrompt,
  checkVersionFreshness,
  isMissionStale,
} from '../generate-platform-missions.mjs'

// ─── applyQualityGate ────────────────────────────────────────────────

describe('applyQualityGate — issue detection', () => {
  it('flags a mission with fewer than 3 steps', () => {
    const mission = {
      mission: {
        steps: [{ title: 't', description: 'helm install foo' }],
        resolution: { summary: 'ok' },
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues.some(i => /Only 1 steps/.test(i))).toBe(true)
    expect(result.pass).toBe(false)
    expect(['draft', 'rejected']).toContain(result.verdict)
  })

  it('flags a mission with no install command', () => {
    const mission = {
      mission: {
        steps: [
          { title: 's1', description: 'kubectl get pods' },
          { title: 's2', description: 'kubectl describe' },
          { title: 's3', description: 'kubectl logs' },
        ],
        resolution: { summary: 'ok' },
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues).toContain('No install command found (helm/kubectl/docker)')
  })

  it('flags a mission with no verification step', () => {
    const mission = {
      mission: {
        steps: [
          { title: 's1', description: 'helm install foo' },
          { title: 's2', description: 'wait' },
          { title: 's3', description: 'done' },
        ],
        resolution: { summary: 'ok' },
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues).toContain('No verification step found')
  })

  it('flags a mission missing resolution summary', () => {
    const mission = {
      mission: {
        steps: [
          { title: 's1', description: 'helm install foo' },
          { title: 's2', description: 'kubectl get pods' },
          { title: 's3', description: 'done' },
        ],
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues).toContain('No resolution summary')
  })

  it('accepts install commands from title as well as description', () => {
    const mission = {
      mission: {
        steps: [
          { title: 'helm install foo', description: '' },
          { title: 'kubectl get pods', description: '' },
          { title: 's3', description: 'done' },
        ],
        resolution: { summary: 'ok' },
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues).not.toContain('No install command found (helm/kubectl/docker)')
    expect(result.issues).not.toContain('No verification step found')
  })

  it('returns a numeric score and one of the three verdicts', () => {
    const mission = {
      mission: {
        steps: [
          { title: 's1', description: 'helm install foo' },
          { title: 's2', description: 'kubectl get pods' },
          { title: 's3', description: 'done' },
        ],
        resolution: { summary: 'ok' },
      },
    }
    const result = applyQualityGate(mission)
    expect(typeof result.score).toBe('number')
    expect(['pass', 'draft', 'rejected']).toContain(result.verdict)
    expect(typeof result.pass).toBe('boolean')
  })

  it('handles a mission with no steps at all', () => {
    const result = applyQualityGate({ mission: {} })
    expect(result.issues.some(i => /Only 0 steps/.test(i))).toBe(true)
    expect(result.pass).toBe(false)
  })

  it('flags a mission that embeds sensitive data (AWS Access Key) in a step', () => {
    const mission = {
      mission: {
        steps: [
          { title: 's1', description: 'helm install foo AKIAIOSFODNN7EXAMPLE' },
          { title: 's2', description: 'kubectl get pods' },
          { title: 's3', description: 'done' },
        ],
        resolution: { summary: 'ok' },
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues.some(i => /Sensitive data detected/.test(i))).toBe(true)
    expect(result.issues.some(i => /AWS Access Key/.test(i))).toBe(true)
    expect(result.pass).toBe(false)
  })

  it('flags a mission that embeds malicious content (XSS script tag) in resolution', () => {
    const mission = {
      mission: {
        steps: [
          { title: 's1', description: 'helm install foo' },
          { title: 's2', description: 'kubectl get pods' },
          { title: 's3', description: 'done' },
        ],
        resolution: { summary: 'ok <script>alert(1)</script>' },
      },
    }
    const result = applyQualityGate(mission)
    expect(result.issues.some(i => /Malicious content detected/.test(i))).toBe(true)
    expect(result.issues.some(i => /XSS: script tag/.test(i))).toBe(true)
    expect(result.pass).toBe(false)
  })
})

// ─── buildPlatformPrompt ─────────────────────────────────────────────

describe('buildPlatformPrompt — sections', () => {
  it('includes the platform header with name, category and description', () => {
    const out = buildPlatformPrompt(
      { name: 'MyPlatform', category: 'service-mesh', description: 'A mesh.' },
      {},
    )
    expect(out).toContain('## Platform: MyPlatform')
    expect(out).toContain('Category: service-mesh')
    expect(out).toContain('Description: A mesh.')
  })

  it('falls back to defaults for missing category/description', () => {
    const out = buildPlatformPrompt({ name: 'X' }, {})
    expect(out).toContain('Category: Kubernetes platform')
    expect(out).toContain('Description: ')
  })

  it('adds version and provider lines only when supplied', () => {
    const withMeta = buildPlatformPrompt(
      { name: 'X', version: '1.2.3', provider: 'Acme' },
      {},
    )
    expect(withMeta).toContain('Latest Version: 1.2.3')
    expect(withMeta).toContain('Provider: Acme')

    const without = buildPlatformPrompt({ name: 'X' }, {})
    expect(without).not.toContain('Latest Version:')
    expect(without).not.toContain('Provider:')
  })

  it('renders the latest release with published date prefix', () => {
    const out = buildPlatformPrompt(
      { name: 'X' },
      { releases: [{ tag_name: 'v9.9.9', published_at: '2025-01-15T10:00:00Z' }] },
    )
    expect(out).toContain('Latest Release: v9.9.9 (2025-01-15)')
  })

  it('renders unknown when release has no published_at', () => {
    const out = buildPlatformPrompt(
      { name: 'X' },
      { releases: [{ tag_name: 'v1' }] },
    )
    expect(out).toContain('Latest Release: v1 (unknown)')
  })

  it('renders repo meta with stars and language', () => {
    const out = buildPlatformPrompt(
      { name: 'X' },
      { repoMeta: { full_name: 'org/repo', stargazers_count: 42, language: 'Go' } },
    )
    expect(out).toContain('Repository: org/repo')
    expect(out).toContain('Stars: 42 | Language: Go')
  })

  it('truncates README to 3000 chars', () => {
    const long = 'A'.repeat(5000)
    const out = buildPlatformPrompt({ name: 'X' }, { readme: long })
    expect(out).toContain('## README (excerpt)')
    // 3000 As should be present but not 3001
    expect(out).toContain('A'.repeat(3000))
    expect(out).not.toContain('A'.repeat(3001))
  })

  it('embeds Chart.yaml, values.yaml (truncated to 2000), and kustomization.yaml when supplied', () => {
    const longValues = 'v'.repeat(3000)
    const out = buildPlatformPrompt(
      { name: 'X' },
      {
        helmChart: 'name: chart',
        helmValues: longValues,
        kustomize: 'resources: []',
      },
    )
    expect(out).toContain('## Chart.yaml')
    expect(out).toContain('name: chart')
    expect(out).toContain('## values.yaml (excerpt)')
    expect(out).toContain('v'.repeat(2000))
    expect(out).not.toContain('v'.repeat(2001))
    expect(out).toContain('## kustomization.yaml')
    expect(out).toContain('resources: []')
  })

  it('appends a JSON schema block naming the platform slug', () => {
    const out = buildPlatformPrompt({ name: 'Cool Platform!' }, {})
    expect(out).toContain('## Required Output Schema')
    expect(out).toContain('"name": "platform-cool-platform"')
    expect(out).toContain('"missionClass": "installer"')
    expect(out).toContain('"version": "kc-mission-v1"')
  })

  it('honours platform.installMethods and prerequisites.tools in the schema', () => {
    const out = buildPlatformPrompt(
      {
        name: 'X',
        installMethods: ['helm', 'kubectl'],
        prerequisites: { tools: ['helm', 'yq'] },
      },
      {},
    )
    expect(out).toContain('"installMethods"')
    expect(out).toContain('"helm"')
    expect(out).toContain('"yq"')
  })
})

// ─── checkVersionFreshness ───────────────────────────────────────────

describe('checkVersionFreshness', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns true when the index.yaml fetch is non-2xx (fail-open)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => '',
    })
    const result = await checkVersionFreshness('https://helm.example.com', 'foo', '1.0.0')
    expect(result).toBe(true)
  })

  it('returns true when the pinned version is present in index.yaml', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'entries:\n  foo:\n    - name: foo\n      version: 1.2.3\n',
    })
    const result = await checkVersionFreshness('https://helm.example.com', 'foo', '1.2.3')
    expect(result).toBe(true)
  })

  it('returns false when the pinned version is not in index.yaml', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'entries:\n  foo:\n    - name: foo\n      version: 9.9.9\n',
    })
    const result = await checkVersionFreshness('https://helm.example.com', 'foo', '1.2.3')
    expect(result).toBe(false)
  })

  it('returns true when fetch throws (network / timeout — fail-open)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await checkVersionFreshness('https://helm.example.com', 'foo', '1.0.0')
    expect(result).toBe(true)
  })

  it('escapes regex metacharacters in the version string (no injection)', async () => {
    // Version "1.2.3" as a literal must not match a different but similar
    // encoded string like "1x2x3". If the escape were dropped, "." would
    // match any char and the assertion below would fail.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'version: 1x2x3\n',
    })
    const result = await checkVersionFreshness('https://helm.example.com', 'foo', '1.2.3')
    expect(result).toBe(false)
  })
})

// ─── isMissionStale ──────────────────────────────────────────────────

describe('isMissionStale', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gpm-stale-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns true for a missing / unreadable file (fail-safe)', () => {
    expect(isMissionStale(join(dir, 'does-not-exist.json'))).toBe(true)
  })

  it('returns true for a non-JSON file (fail-safe)', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{ not valid json')
    expect(isMissionStale(p)).toBe(true)
  })

  it('returns true when metadata.generatedAt is missing', () => {
    const p = join(dir, 'no-generated.json')
    writeFileSync(p, JSON.stringify({ metadata: {} }))
    expect(isMissionStale(p)).toBe(true)
  })

  it('returns false for a mission generated today', () => {
    const p = join(dir, 'fresh.json')
    writeFileSync(p, JSON.stringify({
      metadata: { generatedAt: new Date().toISOString() },
    }))
    expect(isMissionStale(p)).toBe(false)
  })

  it('returns true for a mission older than the staleness threshold', () => {
    const p = join(dir, 'stale.json')
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(p, JSON.stringify({ metadata: { generatedAt: oldDate } }))
    expect(isMissionStale(p)).toBe(true)
  })
})
