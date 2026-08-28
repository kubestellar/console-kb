import { describe, it, expect } from 'vitest'
import {
  isGarbageSnippet,
  extractFromNumberedTemplate,
  extractFromBoldTemplate,
} from '../lib/text-utils.mjs'

// Targeted regression guards for previously uncovered branch arms in text-utils.mjs.
// These branches encode real defensive filters that fire on hostile / templated
// input; each test exercises the true-arm of a specific guard so a future
// refactor can't silently drop the check.

describe('isGarbageSnippet — uncovered branch arms', () => {
  it('detects >2 embedded image markdown links (screenshot-heavy comments)', () => {
    const s = '![a](https://x.com/1.png)\n![b](https://x.com/2.png)\n![c](https://x.com/3.png)\nfoo bar baz'
    expect(isGarbageSnippet(s)).toBe(true)
  })

  it('detects casual chatter phrases (yay thanks / sorry about / LGTM / btw)', () => {
    expect(isGarbageSnippet('yay thanks for the fix!')).toBe(true)
    expect(isGarbageSnippet('sorry about the noise here')).toBe(true)
    expect(isGarbageSnippet('LGTM ship it')).toBe(true)
    expect(isGarbageSnippet('btw this is unrelated but')).toBe(true)
  })

  it('flags short prose with no code characters (< 200 chars, no ={}$:;|><[]())', () => {
    expect(isGarbageSnippet('just a short comment without any code markers at all here')).toBe(true)
  })

  it('detects PR-template boilerplate (first time contributors / please ensure your pull request)', () => {
    expect(isGarbageSnippet('For first time contributors, welcome!')).toBe(true)
    expect(isGarbageSnippet('Please ensure your pull request follows the guidelines.')).toBe(true)
  })

  it('detects query-performance image dumps (query performance + ![image])', () => {
    expect(isGarbageSnippet('Query performance issue: ![image](https://x.com/y.png)')).toBe(true)
  })

  it('detects api.github.com URL dumps', () => {
    expect(isGarbageSnippet('See https://api.github.com/repos/foo/bar/issues')).toBe(true)
  })

  it('detects CLA / DCO boilerplate (contributor license / signed the cla / developer certificate)', () => {
    expect(isGarbageSnippet('Please review the Contributor License Agreement.')).toBe(true)
    expect(isGarbageSnippet('I have signed the CLA for this project.')).toBe(true)
    expect(isGarbageSnippet('Developer Certificate of Origin attestation.')).toBe(true)
  })
})

describe('extractFromNumberedTemplate — uncovered filter arms', () => {
  it('drops parts that are just an issue reference or a github.com URL', () => {
    const input = [
      '### 1. Section A',
      '#42',
      '### 2. Section B',
      'https://github.com/foo/bar/issues/1',
      '### 3. Section C',
      'This is genuine content that should survive the filter.',
    ].join('\n')
    const out = extractFromNumberedTemplate(input)
    expect(out).not.toContain('#42')
    expect(out).not.toContain('https://github.com/foo/bar/issues/1')
    expect(out).toContain('genuine content')
  })

  it('drops short hedging prose (i think / possibly / thanks) under 80 chars', () => {
    const input = [
      '### 1. Section A',
      'I think this might be broken',
      '### 2. Section B',
      'Thanks for looking',
      '### 3. Section C',
      'A properly substantive paragraph that describes the actual problem in detail.',
    ].join('\n')
    const out = extractFromNumberedTemplate(input)
    expect(out).not.toContain('I think this might be broken')
    expect(out).not.toContain('Thanks for looking')
    expect(out).toContain('substantive paragraph')
  })
})

describe('extractFromBoldTemplate — uncovered filter arms', () => {
  it('drops parts that are just a /kind, /area, or /sig command (with optional leading quote)', () => {
    const input = [
      '**Section A**',
      '/kind bug',
      '**Section B**',
      '> /area docs',
      '**Section C**',
      'This paragraph is real substantive content that must be preserved by the extractor.',
    ].join('\n')
    const out = extractFromBoldTemplate(input)
    expect(out).not.toMatch(/^\s*\/kind bug\s*$/m)
    expect(out).not.toMatch(/^\s*>\s*\/area docs\s*$/m)
    expect(out).toContain('substantive content')
  })
})
