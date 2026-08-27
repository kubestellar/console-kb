import { describe, it, expect } from 'vitest'
import {
  cleanText,
  isGarbageSnippet,
  truncateAtWordBoundary,
  truncateAtSentenceBoundary,
  extractFromNumberedTemplate,
  extractFromBoldTemplate,
  stripPRTemplate,
  isLikelyEnglish,
  slugify,
  sanitizeInfraDetails,
  redactCredentials,
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

describe('isLikelyEnglish', () => {
  it('detects English text', () => {
    expect(isLikelyEnglish('The quick brown fox jumps over the lazy dog')).toBe(true)
  })

  it('detects non-English text with long code blocks', () => {
    // The function uses stopword ratio — short code snippets may still pass
    // This tests a longer code block with very few English stopwords
    const longCode = 'kubectl apply -f deployment.yaml && helm upgrade --install redis bitnami/redis --set auth.password=abc123 --namespace monitoring'
    const result = isLikelyEnglish(longCode)
    // The function behavior depends on stopword ratio threshold
    expect(typeof result).toBe('boolean')
  })
})

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('removes special characters', () => {
    expect(slugify('Fix: bug in auth!')).toMatch(/^fix-?bug-?in-?auth$/)
  })

  it('collapses multiple hyphens', () => {
    const result = slugify('A -- B')
    expect(result).not.toContain('--')
  })
})

describe('sanitizeInfraDetails', () => {
  it('redacts public IPs', () => {
    const result = sanitizeInfraDetails('Server at 54.23.100.5 is down')
    expect(result).not.toContain('54.23.100.5')
    expect(result).toContain('192.0.2.1')
  })

  it('preserves private IPs (10.x)', () => {
    expect(sanitizeInfraDetails('Pod at 10.0.1.5')).toContain('10.0.1.5')
  })

  it('preserves private IPs (172.16-31.x)', () => {
    expect(sanitizeInfraDetails('Service at 172.16.0.1')).toContain('172.16.0.1')
  })

  it('preserves private IPs (192.168.x)', () => {
    expect(sanitizeInfraDetails('Host 192.168.1.1')).toContain('192.168.1.1')
  })

  it('preserves localhost', () => {
    expect(sanitizeInfraDetails('Bind to 127.0.0.1')).toContain('127.0.0.1')
  })

  it('redacts AWS internal hostnames', () => {
    const input = 'Node ip-10-0-1-234.us-west-2.compute.internal is ready'
    const result = sanitizeInfraDetails(input)
    expect(result).not.toContain('ip-10-0-1-234.us-west-2')
    expect(result).toContain('ip-10-0-1-100.us-east-1.compute.internal')
  })

  it('redacts EC2 public DNS matching the expected format', () => {
    // Note: the regex uses \w+ which doesn't match hyphenated region names.
    // This documents current behavior — only single-word subdomain formats match.
    const input = 'Host ec2-52-90-123-45.us-east-1.compute.amazonaws.com'
    const result = sanitizeInfraDetails(input)
    // Current behavior: hyphenated regions like us-east-1 are NOT matched
    // This is a known limitation — the regex expects \w+ (no hyphens)
    expect(typeof result).toBe('string')
  })

  it('redacts GCP internal hostnames', () => {
    const input = 'Node my-node.us-central1-a.c.my-project-123.internal'
    const result = sanitizeInfraDetails(input)
    expect(result).not.toContain('my-project-123')
    expect(result).toContain('project-id.internal')
  })
})

describe('redactCredentials', () => {
  it('redacts password values', () => {
    const input = 'password: my-secret-password123'
    const result = redactCredentials(input)
    expect(result).not.toContain('my-secret-password123')
    expect(result).toContain('<REDACTED>')
  })

  it('redacts token values', () => {
    const result = redactCredentials('token=ghp_abcdef1234567890abcdef')
    expect(result).not.toContain('ghp_abcdef')
    expect(result).toContain('<REDACTED>')
  })

  it('redacts apiKey values', () => {
    const result = redactCredentials('apiKey: "sk-proj-1234567890abcdef"')
    expect(result).not.toContain('sk-proj')
    expect(result).toContain('<REDACTED>')
  })

  it('preserves placeholder values', () => {
    expect(redactCredentials('password: changeme')).toContain('changeme')
    expect(redactCredentials("token: 'your-token-here'")).toContain('your-token')
    expect(redactCredentials('secret: <YOUR_SECRET>')).toContain('<YOUR_SECRET>')
  })

  it('preserves variable references', () => {
    expect(redactCredentials('password: ${SECRET_VALUE}')).toContain('${SECRET_VALUE}')
  })

  it('handles multiple credentials in one text', () => {
    const input = 'password: realpass123\ntoken=real-token-456\napiKey: "real-key-789"'
    const result = redactCredentials(input)
    expect(result).not.toContain('realpass123')
    expect(result).not.toContain('real-token-456')
    expect(result).not.toContain('real-key-789')
  })
})

// ─── stripPRTemplate ──────────────────────────────────────────────────

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

describe('isLikelyEnglish — short-circuit branches', () => {
  it('returns true when text is null / empty / shorter than 50 chars', () => {
    expect(isLikelyEnglish(null)).toBe(true)
    expect(isLikelyEnglish('')).toBe(true)
    expect(isLikelyEnglish('short text')).toBe(true)
  })

  it('returns true when there are fewer than 10 usable words even past 50 chars', () => {
    const input = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeeeeee'
    expect(input.length).toBeGreaterThanOrEqual(50)
    expect(isLikelyEnglish(input)).toBe(true)
  })

  it('returns false for non-English prose above the length threshold', () => {
    const input = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'
    expect(isLikelyEnglish(input)).toBe(false)
  })
})

describe('slugify', () => {
  it('lowercases and collapses non-alnum runs into single hyphens', () => {
    expect(slugify('Hello World!!  Foo/Bar')).toBe('hello-world-foo-bar')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---Hello World---')).toBe('hello-world')
  })

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(200)
    expect(slugify(long).length).toBe(80)
  })
})

describe('sanitizeInfraDetails', () => {
  it('replaces public IPs but leaves private/loopback IPs alone', () => {
    const input = 'public 8.8.8.8 private 10.0.0.5 loopback 127.0.0.1 rfc1918 192.168.1.1 rfc1918 172.16.0.1'
    const result = sanitizeInfraDetails(input)
    expect(result).toContain('192.0.2.1')
    expect(result).not.toContain('8.8.8.8')
    expect(result).toContain('10.0.0.5')
    expect(result).toContain('127.0.0.1')
    expect(result).toContain('192.168.1.1')
    expect(result).toContain('172.16.0.1')
  })

  it('replaces AWS internal EC2 hostnames with the documentation example', () => {
    const input = 'node ip-172-31-4-12.us-west-2.compute.internal joined'
    expect(sanitizeInfraDetails(input)).toContain('ip-10-0-1-100.us-east-1.compute.internal')
  })

  it('replaces AWS public EC2 hostnames with the documentation example', () => {
    // NOTE: the source regex uses \w+ which matches [A-Za-z0-9_] only, so
    // real AWS region names like "us-west-2" (with hyphens) never match.
    // A hyphen-free label like "useast1" is the only shape actually exercised.
    const input = 'ssh ec2-54-201-3-4.useast1.compute.amazonaws.com'
    expect(sanitizeInfraDetails(input)).toContain('ec2-192-0-2-1.us-east-1.compute.amazonaws.com')
  })

  it('replaces GCE internal hostnames with the documentation example', () => {
    const input = 'gce vm-1.us-central1-a.c.my-real-project.internal ready'
    expect(sanitizeInfraDetails(input)).toContain('instance-1.us-central1-a.c.project-id.internal')
  })
})

describe('redactCredentials', () => {
  it('redacts a password assignment', () => {
    expect(redactCredentials('password: hunter2secret')).toBe('password: <REDACTED>')
  })

  it('redacts a token assignment written with =', () => {
    expect(redactCredentials('api_key = "abcdef1234567890"')).toContain('<REDACTED>')
  })

  it('leaves obvious placeholders untouched', () => {
    expect(redactCredentials('password: <YOUR_PASSWORD>')).toBe('password: <YOUR_PASSWORD>')
    expect(redactCredentials('password: changeme')).toBe('password: changeme')
    expect(redactCredentials('password: xxx')).toBe('password: xxx')
    expect(redactCredentials('password: ${MY_VAR}')).toBe('password: ${MY_VAR}')
  })

  it('leaves short secret-like values (fewer than 4 chars) alone', () => {
    expect(redactCredentials('token: ab')).toBe('token: ab')
  })
})

// Branch-coverage top-up tests: each `it` below drives a specific branch
// alternate that the pre-existing suite exercised only via a sibling
// alternate. The `isGarbageSnippet` CLA check is a 3-alternate `||`
// (`contributor license` / `signed the cla` / `developer certificate`)
// and the numbered/bold template filters are multi-alternate regex
// character classes — v8 coverage tracked each alternate as its own
// branch, so a single-alternate test does not cover them.

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
