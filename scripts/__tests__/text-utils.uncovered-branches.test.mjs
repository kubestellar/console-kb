import { describe, it, expect } from 'vitest'
import {
  isGarbageSnippet,
  extractFromNumberedTemplate,
  extractFromBoldTemplate,
} from '../lib/text-utils.mjs'

// Coverage for the last remaining true-arm branches in text-utils.mjs
// (isGarbageSnippet quoted-reply detector, and the numbered/bold PR-template
// filter arms that strip stray issue-ref lists and /kind /area /sig markers).

describe('isGarbageSnippet — >70% quoted-reply detector', () => {
  it('flags a mostly-quoted multi-line reply block', () => {
    // 4 lines, all starting with '>' (100% > 70%), and >3 lines total.
    // Words are non-stopword gibberish so the prose threshold is not tripped,
    // and '>' is in the codeChars set so the short-non-code guard is not tripped.
    const snippet = [
      '> quux blorb glarch',
      '> quux blorb glarch',
      '> quux blorb glarch',
      '> quux blorb glarch',
    ].join('\n')
    expect(isGarbageSnippet(snippet)).toBe(true)
  })
})

describe('extractFromNumberedTemplate — issue-ref-only section filter', () => {
  it('drops sections that are only a run of #NNNN issue references', () => {
    const text = [
      '## 1. Related issues',
      '#12345 #67890 #23456',
      '## 2. Description',
      'This section has actual useful content that exceeds twenty chars.',
    ].join('\n')
    const out = extractFromNumberedTemplate(text)
    expect(out).not.toContain('#12345')
    expect(out).toContain('actual useful content')
  })
})

describe('isGarbageSnippet — first-time-contributor PR template arm', () => {
  it('flags snippets containing the "for first time contributors" phrase', () => {
    // Include curly braces + colon so the `!codeChars.test(snippet) && length<200`
    // guard on line 71 does NOT short-circuit; keep total words <= 10 so the
    // prose-threshold guard on line 81 does not fire; keep @mentions to <2 and
    // avoid every other earlier arm so line 73 is the only reachable return.
    const snippet = '{ note: for first time contributors follow guide; }'
    expect(isGarbageSnippet(snippet)).toBe(true)
  })

  it('flags snippets containing the "please ensure your pull request" phrase', () => {
    const snippet = '{ note: please ensure your pull request follows spec; }'
    expect(isGarbageSnippet(snippet)).toBe(true)
  })
})

describe('isGarbageSnippet — GitHub REST JSON payload arm', () => {
  it('flags snippets that look like a serialized GitHub release response', () => {
    // JSON payload with the `"tag_name"` key: has {, }, : so codeChars is
    // satisfied and the earlier short-non-code guard does not fire. All
    // upstream arms miss and line 75 is the first true return.
    const snippet = '{"tag_name": "v1.0.0", "id": 42}'
    expect(isGarbageSnippet(snippet)).toBe(true)
  })

  it('flags snippets carrying the "html_url" JSON key', () => {
    const snippet = '{"html_url": "example.invalid/r/1"}'
    expect(isGarbageSnippet(snippet)).toBe(true)
  })

  it('flags snippets carrying the "created_at" JSON key', () => {
    const snippet = '{"created_at": "2024-01-01T00:00:00Z"}'
    expect(isGarbageSnippet(snippet)).toBe(true)
  })
})

describe('extractFromBoldTemplate — /kind /area /sig marker filter', () => {
  it('drops short sections that are only Prow-style /kind /area /sig markers', () => {
    const text = [
      '**Type of change**',
      '/kind bug',
      '/area core',
      '/sig quality',
      '**Description**',
      'A real description that is well beyond twenty characters in length.',
    ].join('\n')
    const out = extractFromBoldTemplate(text)
    expect(out).not.toContain('/kind bug')
    expect(out).not.toContain('/area core')
    expect(out).toContain('real description')
  })
})
