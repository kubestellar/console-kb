import { describe, it, expect } from 'vitest'
import {
  slugify,
  titleCase,
  generateIssueTitle,
  generateIssueBody,
  generateIssueLabels,
} from '../lib/outreach-helpers.mjs'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Cert Manager')).toBe('cert-manager')
  })

  it('strips non-alphanumeric characters', () => {
    expect(slugify('Envoy!! Gateway++')).toBe('envoy-gateway')
  })

  it('collapses runs of separators into a single hyphen', () => {
    expect(slugify('foo   bar___baz')).toBe('foo-bar-baz')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--Kubernetes--')).toBe('kubernetes')
  })
})

describe('titleCase', () => {
  it('title-cases a hyphenated string', () => {
    expect(titleCase('cert-manager')).toBe('Cert Manager')
  })

  it('title-cases an underscored string', () => {
    expect(titleCase('open_telemetry')).toBe('Open Telemetry')
  })

  it('handles a single-word string', () => {
    expect(titleCase('istio')).toBe('Istio')
  })
})

describe('generateIssueTitle', () => {
  it('embeds the title-cased project name', () => {
    const title = generateIssueTitle({ name: 'cert-manager' })
    expect(title).toContain('Cert Manager')
    expect(title).toContain('AI-Powered Install Mission')
  })
})

describe('generateIssueBody', () => {
  it('reuses the same slug for the mission URL and file path reference', () => {
    const body = generateIssueBody({ name: 'Cert Manager' })
    expect(body).toContain('/missions/install-cert-manager')
    expect(body).toContain('install-cert-manager.json')
  })

  it('honors an explicit consoleUrl override', () => {
    const body = generateIssueBody({ name: 'istio' }, 'https://custom.example.com')
    expect(body).toContain('https://custom.example.com/missions/install-istio')
  })

  it('URL-encodes the improveUrl query parameters', () => {
    const body = generateIssueBody({ name: 'istio' })
    const match = body.match(/\[📝 Suggest an Improvement →\]\((.*?)\)/)
    expect(match).not.toBeNull()
    const improveUrl = match[1]
    expect(improveUrl).toContain('issues/new?title=')
    expect(improveUrl).not.toContain(' ')
    expect(improveUrl).toContain(encodeURIComponent('Improve AI Mission: Istio'))
  })

  it('produces a body of substantial minimum length', () => {
    const body = generateIssueBody({ name: 'istio' })
    expect(body.length).toBeGreaterThan(500)
  })
})

describe('generateIssueLabels', () => {
  it('returns the expected labels', () => {
    expect(generateIssueLabels()).toEqual(['ai-mission', 'community', 'installation'])
  })

  it('returns a fresh array each call (no shared reference)', () => {
    const a = generateIssueLabels()
    const b = generateIssueLabels()
    expect(a).not.toBe(b)
    a.push('mutated')
    expect(b).toEqual(['ai-mission', 'community', 'installation'])
  })
})
