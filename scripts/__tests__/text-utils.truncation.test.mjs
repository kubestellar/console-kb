import { describe, it, expect } from 'vitest'
import {
  truncateAtWordBoundary,
  truncateAtSentenceBoundary,
} from '../lib/text-utils.mjs'

describe('truncateAtWordBoundary', () => {
  it('returns original text if shorter than maxLen', () => {
    expect(truncateAtWordBoundary('short text', 100)).toBe('short text')
  })

  it('truncates at last word boundary', () => {
    const result = truncateAtWordBoundary('hello world foo bar', 11)
    expect(result).toBe('hello world')
  })

  it('adds ellipsis when requested', () => {
    const result = truncateAtWordBoundary('hello world foo bar', 11, { ellipsis: true })
    expect(result).toBe('hello world…')
  })

  it('handles null/empty text', () => {
    expect(truncateAtWordBoundary(null, 100)).toBe('')
    expect(truncateAtWordBoundary('', 100)).toBe('')
  })
})

describe('truncateAtSentenceBoundary', () => {
  it('returns original text if shorter than maxLen', () => {
    expect(truncateAtSentenceBoundary('Short.', 100)).toBe('Short.')
  })

  it('truncates at sentence boundary', () => {
    const input = 'First sentence here is fine. Second sentence here. Third sentence is long enough to exceed the limit easily.'
    const result = truncateAtSentenceBoundary(input, 55)
    expect(result).toContain('First sentence')
    expect(result.endsWith('.')).toBe(true)
  })

  it('falls back to word boundary if no sentence break', () => {
    const input = 'No sentence breaks in this very long text that exceeds the limit'
    const result = truncateAtSentenceBoundary(input, 30)
    expect(result.length).toBeLessThanOrEqual(30)
  })

  it('handles null/empty text', () => {
    expect(truncateAtSentenceBoundary(null, 100)).toBe('')
    expect(truncateAtSentenceBoundary('', 100)).toBe('')
  })
})

describe('truncateAtWordBoundary — MIN_TRUNCATION_POINT branch', () => {
  it('returns the raw slice when the last space falls before position 20', () => {
    const input = 'supercalifragilisticexpialidocious tail words'
    const result = truncateAtWordBoundary(input, 15)
    expect(result).toBe('supercalifragil')
    expect(result).not.toContain(' ')
  })

  it('appends ellipsis to the raw slice when ellipsis is requested', () => {
    const input = 'supercalifragilisticexpialidocious tail'
    const result = truncateAtWordBoundary(input, 15, { ellipsis: true })
    expect(result).toBe('supercalifragil…')
  })
})

describe('truncateAtSentenceBoundary — sentence-boundary branch', () => {
  it('truncates at ". " past the min-truncation-point', () => {
    const input =
      'This sentence must be longer than fifty characters so we clear the min. ' +
      'And a follow-up sentence continues on after the period so the truncation lands cleanly here.'
    const result = truncateAtSentenceBoundary(input, 120)
    expect(result.endsWith('.')).toBe(true)
    expect(result).toContain('clear the min.')
    expect(result).not.toContain('follow-up sentence continues')
  })

  it('truncates at ".\\n" past the min-truncation-point', () => {
    const input =
      'This first sentence is long enough to clear the fifty-char guard.\n' +
      'Second sentence that should get cut off entirely.'
    const result = truncateAtSentenceBoundary(input, 100)
    expect(result.endsWith('.')).toBe(true)
    expect(result).toContain('fifty-char guard.')
    expect(result).not.toContain('Second sentence')
  })
})

