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
