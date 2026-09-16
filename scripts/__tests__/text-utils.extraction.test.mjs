import { describe, it, expect } from 'vitest'
import {
  extractFromNumberedTemplate,
  extractFromBoldTemplate,
  stripPRTemplate,
} from '../lib/text-utils.mjs'

describe('extractFromNumberedTemplate', () => {
  it('returns text unchanged if no numbered sections', () => {
    expect(extractFromNumberedTemplate('Just plain text')).toBe('Just plain text')
  })

  it('extracts content from numbered PR template', () => {
    const input = '## 1. What does this PR do?\nAdds a new feature for caching\n\n## 2. Why?\nPerformance improvement for large clusters\n\n## 3. Related issue\n#123'
    const result = extractFromNumberedTemplate(input)
    expect(result).toContain('Adds a new feature for caching')
    expect(result).toContain('Performance improvement for large clusters')
  })

  it('filters out short/trivial answers', () => {
    const input = '## 1. What?\nyes\n\n## 2. Why?\nImproves performance for large-scale deployments significantly'
    const result = extractFromNumberedTemplate(input)
    expect(result).not.toContain('yes')
  })

  it('handles null/empty', () => {
    expect(extractFromNumberedTemplate(null)).toBe('')
    expect(extractFromNumberedTemplate('')).toBe('')
  })

  it('filters out legitimate GitHub issue references', () => {
    const input = '## 1. Related issues\n#42\n\n## 2. Description\nThis fixes the caching layer for large clusters with 100+ namespaces'
    const result = extractFromNumberedTemplate(input)
    expect(result).not.toContain('#42')
    expect(result).toContain('caching layer')
  })

  it('filters out legitimate GitHub URLs (regression for CWE-020 CodeQL #145)', () => {
    const input = '## 1. Related issues\nhttps://github.com/kubestellar/console/issues/123\n\n## 2. Description\nThis addresses the timeout bug in namespace reconciliation logic'
    const result = extractFromNumberedTemplate(input)
    expect(result).not.toContain('https://github.com/kubestellar')
    expect(result).toContain('timeout bug')
  })

  it('does NOT filter spoofed hostnames like github.com.attacker.com (CWE-020 fix)', () => {
    const input = '## 1. Context\nhttps://github.com.attacker.com/payload/evil is a reference to the vulnerability\n\n## 2. Fix\nUpdated the regex to require a trailing slash after github.com to prevent hostname confusion'
    const result = extractFromNumberedTemplate(input)
    // The spoofed URL should NOT be filtered out — it's not a real GitHub URL
    expect(result).toContain('github.com.attacker.com')
  })
})

describe('extractFromBoldTemplate', () => {
  it('returns text unchanged if no bold headers', () => {
    expect(extractFromBoldTemplate('No bold here')).toBe('No bold here')
  })

  it('extracts content from bold-header template', () => {
    const input = '**What does this PR do?**\nThis fixes a critical bug in the scheduler\n\n**Why?**\nThe scheduler was crashing under high load conditions'
    const result = extractFromBoldTemplate(input)
    expect(result).toContain('fixes a critical bug')
    expect(result).toContain('crashing under high load')
  })

  it('handles null/empty', () => {
    expect(extractFromBoldTemplate(null)).toBe('')
    expect(extractFromBoldTemplate('')).toBe('')
  })
})

describe('stripPRTemplate', () => {
  it('handles null/empty', () => {
    expect(stripPRTemplate(null)).toBe('')
    expect(stripPRTemplate('')).toBe('')
  })

  it('strips HTML comments', () => {
    const input = '<!-- This is a comment -->\nActual description of the change'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('<!--')
    expect(result).toContain('Actual description')
  })

  it('strips nested HTML comments', () => {
    const input = '<!-- outer <!-- inner --> still comment -->\nReal content here'
    const result = stripPRTemplate(input)
    expect(result).toContain('Real content')
  })

  it('strips checklist items', () => {
    const input = 'Description\n- [x] Tests added\n- [ ] Docs updated\n\nThe real fix'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('[x]')
    expect(result).not.toContain('[ ]')
  })

  it('strips "Fixes/Closes" lines with issue numbers', () => {
    const input = 'Fixes #123\nCloses #456\n\nThis PR adds retry logic for network timeouts'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('Fixes #123')
    expect(result).not.toContain('Closes #456')
    expect(result).toContain('retry logic')
  })

  it('strips "Fixes" lines with full GitHub URLs', () => {
    const input = 'Fixes https://github.com/kubestellar/console/issues/789\n\nAdds validation for namespace names'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('github.com/kubestellar')
    expect(result).toContain('validation for namespace')
  })

  it('strips GitHub asset URLs', () => {
    const input = 'See screenshot: https://github.com/org/repo/assets/12345/image.png\n\nThe component renders correctly now'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('assets/12345')
    expect(result).toContain('renders correctly')
  })

  it('strips Signed-off-by lines', () => {
    const input = 'Fix timeout\n\nSigned-off-by: Dev <dev@example.com>'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('Signed-off-by')
    expect(result).toContain('Fix timeout')
  })

  it('strips @ mentions and cc lines', () => {
    const input = 'cc @reviewer1 @reviewer2\n\nThis optimizes the query planner for multi-cluster environments'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('@reviewer1')
    expect(result).toContain('query planner')
  })

  it('strips /kind and /area labels', () => {
    const input = '/kind bug\n/area networking\n\nFixes the DNS resolution timeout in federated services'
    const result = stripPRTemplate(input)
    expect(result).not.toContain('/kind')
    expect(result).not.toContain('/area')
    expect(result).toContain('DNS resolution')
  })

  it('strips bold-header template questions', () => {
    const input = '**What type of PR is this?**\nBug fix\n\n**What this PR does:**\nFixes a race condition in the event loop that caused duplicate notifications'
    const result = stripPRTemplate(input)
    expect(result).toContain('race condition')
  })

  it('preserves substantive content', () => {
    const input = '## Summary\n\nThis PR refactors the authentication middleware to support both JWT and session-based auth simultaneously.'
    const result = stripPRTemplate(input)
    expect(result).toContain('refactors the authentication middleware')
  })
})
describe('extractFromNumberedTemplate — filter branches', () => {
  it('drops short parts, plain issue refs, github URLs, and one-word answers', () => {
    const input =
      '### 1. Why is this needed\n' +
      '#123\n' +
      '### 2. Which issue does this fix\n' +
      'https://github.com/foo/bar/issues/9\n' +
      '### 3. Additional context\n' +
      'yes\n' +
      '### 4. Anything else\n' +
      'This is the substantive content that describes the actual change made here in enough detail.'
    const result = extractFromNumberedTemplate(input)
    expect(result).toContain('substantive content')
    expect(result).not.toContain('#123')
    expect(result).not.toMatch(/^yes$/m)
    expect(result).not.toContain('https://github.com/foo/bar/issues/9')
  })

  it('drops short affirming phrases like "sure" / "thanks"', () => {
    const input =
      '### 1. Why is this needed\n' +
      'sure, this works fine\n' +
      '### 2. Which issue does this fix\n' +
      'The substantive body explaining the entire architectural change and its motivation across services.'
    const result = extractFromNumberedTemplate(input)
    expect(result).toContain('substantive body')
    expect(result).not.toMatch(/^sure, this works fine$/m)
  })

  it('returns text unchanged when fewer than 2 numbered sections are present', () => {
    const input = '### 1. Only one section\nSome body content.'
    expect(extractFromNumberedTemplate(input)).toBe(input)
  })

  it('returns empty string for null/empty input', () => {
    expect(extractFromNumberedTemplate(null)).toBe('')
    expect(extractFromNumberedTemplate('')).toBe('')
  })
})

describe('extractFromBoldTemplate — filter branches', () => {
  it('drops short "/kind" and "> Uncomment" boilerplate parts', () => {
    const input =
      '**What type of PR**\n' +
      '> Uncomment one of the following\n' +
      '/kind bug\n' +
      '**What this PR does**\n' +
      'The real body explains the actual behavior change in depth so downstream readers understand it.'
    const result = extractFromBoldTemplate(input)
    expect(result).toContain('real body explains')
    expect(result).not.toContain('Uncomment')
    expect(result).not.toMatch(/^\/kind bug$/m)
  })

  it('returns text unchanged when fewer than 2 bold headers are present', () => {
    const input = '**Only one header**\nBody content.'
    expect(extractFromBoldTemplate(input)).toBe(input)
  })

  it('returns empty string for null/empty input', () => {
    expect(extractFromBoldTemplate(null)).toBe('')
    expect(extractFromBoldTemplate('')).toBe('')
  })
})

describe('extractFromNumberedTemplate short-filler filter alternates (branch coverage)', () => {
  // The `p.length < 80 && /^(not that|i think|i believe|possibly|maybe|
  // probably|sure|thanks|thank you)/i.test(p)` filter at text-utils.mjs:135
  // has 9 regex alternates; the pre-existing 'filters out short/trivial
  // answers' test only exercises the `yes` path (from the sibling
  // `yes|no|none|n/a` filter at line 134), leaving line 135's alternates
  // untouched. Each `it` below drives one of the short-filler alternates.

  const scaffold = (answer) =>
    `## 1. Description\n${answer}\n\n` +
    '## 2. Details\nRefactors the cache eviction policy so cold entries expire after five minutes instead of ten, cutting memory usage under sustained load.'

  it.each([
    ['not that', 'not that big of a deal really'],
    ['i think', 'i think this is fine'],
    ['i believe', 'i believe so, yes'],
    ['possibly', 'possibly but I am not sure'],
    ['maybe', 'maybe next week we can look'],
    ['probably', 'probably yes, will check later'],
    ['sure', 'sure, whatever works for you'],
    ['thanks', 'thanks for the quick review!'],
    ['thank you', 'thank you very much for looking'],
  ])('filters out the "%s" short-filler alternate', (label, filler) => {
    const result = extractFromNumberedTemplate(scaffold(filler))
    expect(result).not.toContain(filler)
    expect(result).toContain('cache eviction policy')
  })

  it('keeps the short-filler when it exceeds the 80-char length cap', () => {
    // The length guard is `p.length < 80`; a filler-prefixed sentence
    // longer than 80 chars must survive the filter so the second half
    // of the `&&` at line 135 is exercised on both sides.
    const long =
      'maybe next week the team can revisit this because the current heuristic is too aggressive and skips real edits'
    expect(long.length).toBeGreaterThan(80)
    const result = extractFromNumberedTemplate(scaffold(long))
    expect(result).toContain(long)
  })

  it('filters out a section body that is only stacked issue references (line 136 branch)', () => {
    // The `/^#\d+[\s\n]*(?:#\d+[\s\n]*)*$/` filter at line 136 catches
    // sections whose whole content is a chain of #NNN issue links. The
    // existing '#42' test at line 133 only covers a single-issue single
    // line — this one exercises the multi-issue repetition alternate.
    const input =
      '## 1. Related issues\n#42 #99 #123\n\n## 2. Description\n' +
      'This PR replaces the ad-hoc reconciliation loop with a proper informer chain so RBAC updates propagate within a second.'
    const result = extractFromNumberedTemplate(input)
    expect(result).not.toContain('#42')
    expect(result).not.toContain('#99')
    expect(result).toContain('informer chain')
  })
})

describe('extractFromBoldTemplate kind/area/sig filter alternates (branch coverage)', () => {
  // The `/^(?:>\s*)?\/(?:kind|area|sig)\s+\w+$/gm` filter at
  // text-utils.mjs:154 has three alternates in the `(?:kind|area|sig)`
  // group. Cover each so branch tracking marks the alternate group as
  // fully exercised.

  const scaffold = (label) =>
    `**Kind of change**\n${label}\n\n**Description**\n` +
    'Adds a dedicated retry pool so transient DNS lookups no longer starve the main workqueue during upgrade rollouts.'

  it.each([
    ['/kind', '/kind bug'],
    ['/area', '/area scheduling'],
    ['/sig', '/sig auth'],
  ])('filters out the standalone "%s" label alternate', (_alt, label) => {
    const result = extractFromBoldTemplate(scaffold(label))
    expect(result).not.toContain(label)
    expect(result).toContain('retry pool')
  })

  it('filters out a quoted "> /kind bug" variant (the optional > prefix)', () => {
    // The leading `(?:>\s*)?` group has two states — present and absent.
    // The `>` prefix appears in Falco/KEDA templates that include the
    // label inside a blockquote. Exercising this alternate lifts the
    // remaining branch on line 154.
    const input =
      '**Kind of change**\n> /area networking\n\n**Description**\n' +
      'Threads the CNI plugin config through the upgrade validator so mis-typed pod-cidr entries fail fast at plan time.'
    const result = extractFromBoldTemplate(input)
    expect(result).not.toContain('/area networking')
    expect(result).toContain('CNI plugin config')
  })
})
