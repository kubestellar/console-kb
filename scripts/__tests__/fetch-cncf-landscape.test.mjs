/**
 * fetch-cncf-landscape.test.mjs
 *
 * Unit tests for the pure helpers exported from
 * scripts/fetch-cncf-landscape.mjs. The full script fetches
 * landscape.yml over HTTP and writes cncf-projects.mjs on disk, so it
 * cannot be exercised safely under `npm test`. Prior to this file
 * nothing in __tests__/ imported the module at all — a regression in
 * category detection, the landscape yaml parser, or the CNCF selection
 * / dedup / sort pipeline would land silently.
 *
 * Tests target:
 *   - detectCategory: representative per-category matches + fallback
 *   - CATEGORY_PATTERNS: table shape invariant
 *   - parseLandscapeItems: normal parse, trailing item flushed, items
 *     missing name or repo dropped
 *   - toCncfProjects: maturity filter, slugification, repo extraction,
 *     dedup by repo, and (graduated < incubating < sandbox, then name)
 *     sort order
 *   - renderCncfProjectsModule: header shape, per-maturity comments,
 *     entry lines, CATEGORY_TO_DIR footer, empty-list edge case
 */
import { describe, it, expect } from 'vitest'
import {
  detectCategory,
  CATEGORY_PATTERNS,
  parseLandscapeItems,
  toCncfProjects,
  renderCncfProjectsModule,
} from '../fetch-cncf-landscape.mjs'

describe('detectCategory', () => {
  it('classifies observability projects', () => {
    expect(detectCategory('Prometheus', 'prometheus/prometheus')).toBe('observability')
    expect(detectCategory('OpenTelemetry', 'open-telemetry/opentelemetry')).toBe('observability')
  })

  it('classifies networking projects', () => {
    expect(detectCategory('Envoy', 'envoyproxy/envoy')).toBe('networking')
    expect(detectCategory('Cilium', 'cilium/cilium')).toBe('networking')
  })

  it('classifies security projects', () => {
    expect(detectCategory('Falco', 'falcosecurity/falco')).toBe('security')
    expect(detectCategory('OPA', 'open-policy-agent/opa')).toBe('security')
  })

  it('classifies storage projects', () => {
    expect(detectCategory('Rook', 'rook/rook')).toBe('storage')
  })

  it('classifies runtime projects', () => {
    expect(detectCategory('containerd', 'containerd/containerd')).toBe('runtime')
  })

  it('classifies orchestration projects', () => {
    expect(detectCategory('Kubernetes', 'kubernetes/kubernetes')).toBe('orchestration')
    expect(detectCategory('KubeStellar', 'kubestellar/kubestellar')).toBe('orchestration')
  })

  it('falls back to app-definition for unmatched names', () => {
    expect(detectCategory('made-up-widget', 'someone/made-up-widget')).toBe('app-definition')
  })

  it('is case-insensitive', () => {
    expect(detectCategory('PROMETHEUS', 'PROM/prom')).toBe('observability')
  })
})

describe('CATEGORY_PATTERNS', () => {
  it('is a non-empty array of [RegExp, string] pairs', () => {
    expect(Array.isArray(CATEGORY_PATTERNS)).toBe(true)
    expect(CATEGORY_PATTERNS.length).toBeGreaterThan(0)
    for (const row of CATEGORY_PATTERNS) {
      expect(row).toHaveLength(2)
      expect(row[0]).toBeInstanceOf(RegExp)
      expect(typeof row[1]).toBe('string')
      expect(row[1].length).toBeGreaterThan(0)
    }
  })
})

describe('parseLandscapeItems', () => {
  it('extracts name/repo/project from consecutive item blocks', () => {
    const yaml = [
      '        - item:',
      '          name: Prometheus',
      '          repo_url: https://github.com/prometheus/prometheus',
      '          project: graduated',
      '        - item:',
      '          name: Envoy',
      '          repo_url: https://github.com/envoyproxy/envoy',
      '          project: graduated',
    ].join('\n')
    const items = parseLandscapeItems(yaml)
    expect(items).toEqual([
      { name: 'Prometheus', repo: 'https://github.com/prometheus/prometheus', project: 'graduated' },
      { name: 'Envoy', repo: 'https://github.com/envoyproxy/envoy', project: 'graduated' },
    ])
  })

  it('flushes the final item at EOF', () => {
    const yaml = [
      '        - item:',
      '          name: Solo',
      '          repo_url: https://github.com/solo/solo',
      '          project: sandbox',
    ].join('\n')
    expect(parseLandscapeItems(yaml)).toEqual([
      { name: 'Solo', repo: 'https://github.com/solo/solo', project: 'sandbox' },
    ])
  })

  it('drops items missing name or repo_url', () => {
    const yaml = [
      '        - item:',
      '          name: NoRepoHere',
      '          project: graduated',
      '        - item:',
      '          repo_url: https://github.com/x/y',
      '          project: graduated',
      '        - item:',
      '          name: Good',
      '          repo_url: https://github.com/g/g',
      '          project: graduated',
    ].join('\n')
    const items = parseLandscapeItems(yaml)
    expect(items).toEqual([
      { name: 'Good', repo: 'https://github.com/g/g', project: 'graduated' },
    ])
  })

  it('returns an empty array for input with no items', () => {
    expect(parseLandscapeItems('')).toEqual([])
    expect(parseLandscapeItems('# just comments\nfoo: bar\n')).toEqual([])
  })
})

describe('toCncfProjects', () => {
  it('keeps only graduated/incubating/sandbox projects', () => {
    const items = [
      { name: 'Grad', repo: 'https://github.com/g/g', project: 'graduated' },
      { name: 'Inc', repo: 'https://github.com/i/i', project: 'incubating' },
      { name: 'Sand', repo: 'https://github.com/s/s', project: 'sandbox' },
      { name: 'Arch', repo: 'https://github.com/a/a', project: 'archived' },
      { name: 'None', repo: 'https://github.com/n/n' },
    ]
    const out = toCncfProjects(items)
    expect(out.map(p => p.maturity).sort()).toEqual(['graduated', 'incubating', 'sandbox'])
  })

  it('drops items whose repo URL is not a github.com owner/repo', () => {
    const items = [
      { name: 'GoodOne', repo: 'https://github.com/good/one', project: 'graduated' },
      { name: 'GitLab', repo: 'https://gitlab.com/x/y', project: 'graduated' },
      { name: 'Malformed', repo: 'not a url', project: 'graduated' },
    ]
    const out = toCncfProjects(items)
    expect(out).toHaveLength(1)
    expect(out[0].repo).toBe('good/one')
  })

  it('slugifies name to lower-kebab-case', () => {
    const items = [
      { name: 'Open Policy Agent!!', repo: 'https://github.com/opa/opa', project: 'graduated' },
    ]
    expect(toCncfProjects(items)[0].name).toBe('open-policy-agent')
  })

  it('trims leading and trailing dashes from the slug', () => {
    const items = [
      { name: '!!weird!!', repo: 'https://github.com/x/weird', project: 'sandbox' },
    ]
    expect(toCncfProjects(items)[0].name).toBe('weird')
  })

  it('extracts owner/repo from a github.com URL (no path suffix normalisation)', () => {
    const items = [
      { name: 'A', repo: 'https://github.com/foo/bar', project: 'graduated' },
      { name: 'B', repo: 'https://github.com/foo/bar/tree/main', project: 'graduated' },
    ]
    const repos = toCncfProjects(items).map(p => p.repo)
    // Both share the same repo → dedup keeps first only.
    expect(repos).toEqual(['foo/bar'])
  })

  it('deduplicates by repo (first occurrence wins)', () => {
    const items = [
      { name: 'First', repo: 'https://github.com/x/y', project: 'graduated' },
      { name: 'Dup', repo: 'https://github.com/x/y', project: 'sandbox' },
    ]
    const out = toCncfProjects(items)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('first')
    expect(out[0].maturity).toBe('graduated')
  })

  it('sorts by maturity (graduated → incubating → sandbox) then name', () => {
    const items = [
      { name: 'zeta',  repo: 'https://github.com/z/z', project: 'sandbox' },
      { name: 'alpha', repo: 'https://github.com/a/a', project: 'sandbox' },
      { name: 'delta', repo: 'https://github.com/d/d', project: 'graduated' },
      { name: 'bravo', repo: 'https://github.com/b/b', project: 'graduated' },
      { name: 'echo',  repo: 'https://github.com/e/e', project: 'incubating' },
    ]
    const out = toCncfProjects(items).map(p => `${p.maturity}:${p.name}`)
    expect(out).toEqual([
      'graduated:bravo',
      'graduated:delta',
      'incubating:echo',
      'sandbox:alpha',
      'sandbox:zeta',
    ])
  })

  it('attaches a category derived from name+repo', () => {
    const items = [
      { name: 'Prometheus', repo: 'https://github.com/prometheus/prometheus', project: 'graduated' },
    ]
    expect(toCncfProjects(items)[0].category).toBe('observability')
  })
})

describe('renderCncfProjectsModule', () => {
  const projects = [
    { name: 'aaa', repo: 'a/a', maturity: 'graduated', category: 'orchestration' },
    { name: 'bbb', repo: 'b/b', maturity: 'graduated', category: 'observability' },
    { name: 'ccc', repo: 'c/c', maturity: 'incubating', category: 'security' },
  ]

  it('writes a stable header including project count and generatedAt', () => {
    const out = renderCncfProjectsModule(projects, '2026-01-02T03:04:05Z')
    expect(out).toContain(' * Total: 3 projects')
    expect(out).toContain(' * Generated: 2026-01-02T03:04:05Z')
    expect(out).toContain('export const CNCF_PROJECTS = [')
  })

  it('emits a maturity divider comment on maturity change only', () => {
    const out = renderCncfProjectsModule(projects, 'x')
    expect(out).toMatch(/\/\/ Graduated/)
    expect(out).toMatch(/\/\/ Incubating/)
    // Only one Graduated divider (not one per graduated entry)
    expect(out.match(/\/\/ Graduated/g)).toHaveLength(1)
  })

  it('emits one entry line per project with all four fields', () => {
    const out = renderCncfProjectsModule(projects, 'x')
    expect(out).toContain('{ name: "aaa", repo: "a/a", maturity: "graduated", category: "orchestration" },')
    expect(out).toContain('{ name: "ccc", repo: "c/c", maturity: "incubating", category: "security" },')
  })

  it('appends the CATEGORY_TO_DIR footer with the expected keys', () => {
    const out = renderCncfProjectsModule(projects, 'x')
    expect(out).toContain('export const CATEGORY_TO_DIR = {')
    for (const key of [
      'orchestration',
      'observability',
      'networking',
      'security',
      'storage',
      'runtime',
      'app-definition',
    ]) {
      expect(out).toContain(`'${key}':`)
    }
  })

  it('handles the empty-list edge case', () => {
    const out = renderCncfProjectsModule([], '2026-01-01T00:00:00Z')
    expect(out).toContain(' * Total: 0 projects')
    expect(out).toContain('export const CNCF_PROJECTS = [')
    expect(out).not.toMatch(/\/\/ Graduated/)
    expect(out).toContain('export const CATEGORY_TO_DIR = {')
  })

  it('produces valid ES module source (parses via dynamic data-URL import)', async () => {
    const src = renderCncfProjectsModule(projects, '2026-01-01T00:00:00Z')
    const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
    const mod = await import(url)
    expect(mod.CNCF_PROJECTS).toHaveLength(3)
    expect(mod.CNCF_PROJECTS[0]).toEqual(projects[0])
    expect(mod.CATEGORY_TO_DIR['app-definition']).toBe('workloads')
  })
})
