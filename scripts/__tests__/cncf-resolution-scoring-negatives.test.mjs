import { describe, it, expect } from 'vitest'
import { extractResolutionFromIssue } from '../lib/cncf-resolution.mjs'

/**
 * Additional branch coverage for the comment-scoring heuristic in
 * scripts/lib/cncf-resolution.mjs (extractResolutionFromIssue). The
 * existing __tests__/extract-resolution-branches.test.mjs exercises the
 * linkedPR extraction paths and a few scoring negatives, but
 * `npm run test:coverage` still showed 76.47% branch coverage (65/85) on
 * this file, with these specific branches never taken:
 *
 *   - COLLABORATOR / CONTRIBUTOR author-authority tiers (L97-98)
 *   - "fixed in" / "resolved by" / "solution" keyword bonuses (L100-103)
 *   - the >500-char length bonus (L109)
 *   - the conversational-tone negative inside the scoring loop (L121),
 *     distinct from the top-level isLowQualityComment filter
 *   - the email-reply-header negative inside the scoring loop (L123)
 *   - the embedded-<img> negative (L125)
 *   - the yamlSnippets cutoff at 5 snippets (L144)
 *
 * These pin the remaining scoring-heuristic branches against silent
 * regressions in which comments get selected as a mission's "solution".
 */

function mkIssue(body = 'Some issue body text', extra = {}) {
  return {
    title: 'Test issue',
    body,
    labels: [],
    comments: 1,
    reactions: { total_count: 1 },
    html_url: 'https://github.com/test/repo/issues/1',
    number: 1,
    ...extra,
  }
}

describe('extractResolutionFromIssue — author-authority and keyword bonuses', () => {
  it('scores a COLLABORATOR comment with a keyword bonus highly enough to win', () => {
    const comments = [
      {
        body: 'The fix is to bump the timeout. Resolved by setting timeoutSeconds to 60 in the probe config.',
        author_association: 'COLLABORATOR',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    expect(result.solution).toContain('bump the timeout')
  })

  it('scores a CONTRIBUTOR comment with the "solution" keyword bonus', () => {
    const comments = [
      {
        body:
          'The fix / solution / workaround is to set the replica count to 3 and restart the deployment ' +
          'to pick up the new config.',
        author_association: 'CONTRIBUTOR',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    expect(result.solution).toContain('replica count')
  })

  it('applies the >500-char length bonus so a long detailed comment wins', () => {
    const longBody =
      'The fix is to patch the controller. ' + 'Additional detail about the rollout steps and verification. '.repeat(12)
    const comments = [{ body: longBody, author_association: 'NONE' }]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    expect(longBody.length).toBeGreaterThan(500)
    expect(result.solution).toContain('patch the controller')
  })
})

describe('extractResolutionFromIssue — in-loop conversational/email/img negatives', () => {
  it('penalises a conversational-tone comment inside the scoring loop even with a code block', () => {
    const comments = [
      {
        body:
          "I think the fix is to bump the probe timeout.\n\n```yaml\ntimeoutSeconds: 60\n```\n\n" +
          'This should resolve the restart loop we discussed.',
        author_association: 'NONE',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    // The leading "I think" penalty (-6) combined with no author-authority
    // bonus must keep this below MIN_COMMENT_SCORE despite the code block.
    expect(result.solution).toBe('')
  })

  it('penalises an email-reply-header comment inside the scoring loop', () => {
    const comments = [
      {
        body:
          'On Mon, Jan 5, 2026 at 10:00 AM Jane Doe wrote:\n' +
          'The fix is to restart the operator and reapply the CRD after the upgrade.',
        author_association: 'NONE',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    expect(result.solution).toBe('')
  })

  it('penalises a comment containing an embedded <img> screenshot', () => {
    const comments = [
      {
        body:
          'The fix is to update the config map as shown below.\n' +
          '<img src="https://user-images.githubusercontent.com/1/screenshot.png" alt="screenshot">\n' +
          'That resolved it for me after redeploying.',
        author_association: 'NONE',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    expect(result.solution).toBe('')
  })
})

describe('extractResolutionFromIssue — yamlSnippets cutoff', () => {
  it('stops collecting yamlSnippets once 5 have been found, ignoring later code blocks', () => {
    const makeBlock = (n) => `\`\`\`yaml\nblock: ${n}\nvalue: some-config-${n}\n\`\`\`countname`
    const body = Array.from({ length: 7 }, (_, i) => makeBlock(i)).join('\n\n')
    const result = extractResolutionFromIssue(mkIssue(body), [], null)
    expect(result.yamlSnippets.length).toBe(5)
    expect(result.yamlSnippets.some((s) => s.includes('block: 6'))).toBe(false)
  })
})
