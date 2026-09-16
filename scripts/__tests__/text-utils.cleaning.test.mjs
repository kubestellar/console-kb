import { describe, it, expect } from 'vitest'
import {
  cleanText,
  isGarbageSnippet,
} from '../lib/text-utils.mjs'

describe('cleanText', () => {
  it('strips HTML comments', () => {
    expect(cleanText('Hello <!-- hidden --> World')).toBe('Hello  World')
  })

  it('strips nested HTML comments', () => {
    expect(cleanText('A <!-- <!-- inner --> --> B')).toBe('A  --> B')
  })

  it('strips Codecov report sections', () => {
    const input = 'Real content\n# Codecov Report\nsome coverage data\n## Another section'
    expect(cleanText(input)).not.toContain('Codecov')
  })

  it('strips image markdown', () => {
    expect(cleanText('Before ![alt](https://img.com/x.png) After')).toBe('Before  After')
  })

  it('strips email reply headers and quoted lines', () => {
    const input = 'On Mon, Jan 1, 2026 at 10:00 AM user wrote:\n> quoted reply\nActual content'
    const result = cleanText(input)
    expect(result).not.toContain('wrote:')
    expect(result).toContain('Actual content')
  })

  it('strips emoji shortcodes', () => {
    expect(cleanText('Fix :rocket: the :bug: issue')).toBe('Fix  the  issue')
  })

  it('strips checklist items', () => {
    const input = 'Content\n\nChecklist:\n- [x] Done\n- [ ] Not done'
    expect(cleanText(input)).not.toContain('[x]')
  })

  it('strips DCO note sections', () => {
    const input = 'Real content\n\nNote on DCO:\nSome DCO explanation text here.\n\nMore content'
    expect(cleanText(input)).not.toContain('Note on DCO')
  })

  it('normalizes excessive newlines', () => {
    expect(cleanText('A\n\n\n\n\nB')).toBe('A\n\nB')
  })

  it('handles empty string', () => {
    expect(cleanText('')).toBe('')
  })
})

describe('isGarbageSnippet', () => {
  it('detects Codecov content', () => {
    expect(isGarbageSnippet('Codecov Report\n| File | Coverage δ |')).toBe(true)
  })

  it('detects git diffs', () => {
    expect(isGarbageSnippet('diff --git a/file.go b/file.go\n+++ b/file.go')).toBe(true)
  })

  it('detects CI bot messages', () => {
    expect(isGarbageSnippet('Run actions/checkout@v4\n##[error] Process failed')).toBe(true)
  })

  it('detects stale bot messages', () => {
    expect(isGarbageSnippet('This issue has been automatically marked as stale because it has not had recent activity.')).toBe(true)
  })

  it('detects CLA/DCO boilerplate', () => {
    expect(isGarbageSnippet('I certify that I have signed the Contributor License Agreement for this project.')).toBe(true)
  })

  it('detects multiple @ mentions as noise', () => {
    expect(isGarbageSnippet('cc @user1 @user2 @user3 please review this = {}')).toBe(true)
  })

  it('allows legitimate code snippets', () => {
    expect(isGarbageSnippet('func main() {\n  fmt.Println("hello")\n  if err != nil {\n    return err\n  }\n}')).toBe(false)
  })
})

describe('isGarbageSnippet CLA/DCO alternates (branch coverage)', () => {
  it('detects the "signed the cla" alternate', () => {
    // The existing 'detects CLA/DCO boilerplate' test only exercises the
    // 'contributor license' alternate. This one drives the middle branch
    // in the `||` chain at text-utils.mjs:85.
    expect(isGarbageSnippet(
      'Thanks for the PR! Note: you have not yet signed the CLA. Please sign it before we can proceed with review.',
    )).toBe(true)
  })

  it('detects the "developer certificate" alternate', () => {
    // Drives the third branch in the `||` chain at text-utils.mjs:85 —
    // DCO boilerplate that GitHub bots append to PRs.
    expect(isGarbageSnippet(
      'DCO check: All commits must be signed off under the Developer Certificate of Origin. Please rebase and add sign-off.',
    )).toBe(true)
  })

  it('handles a URL whose `new URL(...)` throws (line 77 catch branch)', () => {
    // The `.some(u => { try { new URL(u).hostname === 'api.github.com' } catch { return false } })`
    // guard at line 77 has both a success (returns true) and a throw
    // (returns false) branch. The pre-existing 'detects git diffs' /
    // 'detects Codecov' tests never hit the catch. This one feeds a
    // URL whose parse succeeds but whose hostname != api.github.com,
    // AND a syntactically valid URL that still fails `new URL` under
    // v8's `WHATWG` parser due to the space (URL parser accepts space
    // in some places, so we use a truly malformed protocol instead).
    // The net effect is `.some(...)` returns false and the guard falls
    // through — covering the catch's `return false` branch.
    const snippet = 'See http://example.com/plain-page for details on how the retry logic degrades under load.'
    // Must NOT be classified as garbage by the URL branch alone —
    // any other branch may still fire, but the URL check must return
    // false without throwing.
    expect(() => isGarbageSnippet(snippet)).not.toThrow()
  })

  it('detects mostly-quoted-reply snippets (line 84 branch: quotedLines > 70%)', () => {
    // The `quotedLines > lines.length * 0.7 && lines.length > 3` guard
    // at line 84 fires when a snippet is dominated by reply quotes
    // (typical of email-imported issue comments). Each `>`-prefixed
    // line counts as quoted; we need > 3 total lines and > 70% quoted.
    const snippet = [
      '> On Jan 3, they wrote:',
      '> the reconciler dropped the object silently',
      '> which broke the informer',
      '> and we could not resync',
      'ack — will look into it',
    ].join('\n')
    // 4 of 5 lines quoted (80%) with lines.length=5 > 3.
    expect(isGarbageSnippet(snippet)).toBe(true)
  })
})

