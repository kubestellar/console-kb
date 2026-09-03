import { describe, it, expect } from 'vitest'
import { extractResolutionFromIssue } from '../generate-cncf-missions.mjs'

/**
 * Branch coverage for extractResolutionFromIssue in
 * scripts/generate-cncf-missions.mjs (previously ~2 tests). Targets:
 *
 *   - linkedPR.body headered-section match (L385-388)
 *   - linkedPR.body fallback to extractFromNumberedTemplate (L391-396)
 *   - linkedPR.body fallback to extractFromBoldTemplate
 *   - comment-scoring path picks a high-scoring comment as the solution
 *     when no linkedPR is present (L446-454)
 *   - low-quality comment filter drops "me too"/"+1"/CLA/template-debris
 *     comments even when they are long
 *   - bot / codecov comments are penalized enough to drop below the
 *     MIN_COMMENT_SCORE floor
 *
 * These pin the "picked the best comment" contract that downstream
 * mission generation depends on, and lock in the negative-scoring
 * heuristics against silent regressions.
 */

function mkIssue(body = 'Some issue body text', extra = {}) {
  return {
    title: 'Test issue',
    body,
    labels: [],
    comments: 2,
    reactions: { total_count: 15 },
    html_url: 'https://github.com/test/repo/issues/1',
    number: 1,
    ...extra,
  }
}

describe('extractResolutionFromIssue — linked PR body', () => {
  it('picks the ## Solution section from linkedPR.body when the header regex matches', () => {
    const linkedPR = {
      body:
        '## Background\nSome preamble text unrelated to the fix itself.\n\n' +
        '## Solution\nRun `kubectl apply -f config.yaml` and then restart the deployment. This resolves the CrashLoopBackOff.\n\n' +
        '## Testing\nran e2e locally',
    }
    const result = extractResolutionFromIssue(mkIssue(), [], linkedPR)
    expect(result.solution).toContain('kubectl apply')
    expect(result.solution).toContain('restart the deployment')
    // Preamble before the ## Solution header must not leak in.
    expect(result.solution).not.toContain('preamble')
  })

  it('falls back to numbered-template extraction when no ## Solution header is present', () => {
    const linkedPR = {
      body:
        '### 1. Why is this PR needed?\nThe deployment controller was leaking a goroutine on every reconcile — fixes the memory growth reported in #42.\n\n' +
        '### 2. What changes were made?\nStopped the leak by cancelling the context in the defer block.\n',
    }
    const result = extractResolutionFromIssue(mkIssue(), [], linkedPR)
    // Non-empty answer from the numbered template must appear.
    expect(result.solution.length).toBeGreaterThan(20)
    expect(result.solution).toMatch(/goroutine|deployment|leak/i)
  })
})

describe('extractResolutionFromIssue — comment scoring', () => {
  it('picks the highest-scoring comment as the solution when no linkedPR is provided', () => {
    const comments = [
      // Low: a "me too" comment above MIN_COMMENT_LENGTH but below MIN_COMMENT_SCORE.
      {
        body: 'I have the same issue on my cluster, seeing the exact same CrashLoopBackOff behavior every restart.',
        author_association: 'NONE',
      },
      // High: OWNER + "the fix" + code block + long body -> well over MIN_COMMENT_SCORE (=8).
      {
        body:
          'The fix is to bump the readiness probe delay. Apply the following config:\n\n' +
          '```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          readinessProbe:\n            initialDelaySeconds: 30\n```\n\n' +
          'This resolves the timing issue during rollout. We verified the workaround on staging before merging.',
        author_association: 'OWNER',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    expect(result.solution).toContain('readiness probe')
    expect(result.solution).toContain('The fix is')
    // The "me too" body must not have won.
    expect(result.solution).not.toMatch(/me too|same issue/i)
    // The code block should still be captured as a YAML snippet regardless
    // of which comment won the scoring.
    expect(result.yamlSnippets.some(s => s.includes('readinessProbe'))).toBe(true)
  })

  it('drops low-quality template/CLA/PR-debris comments even when long', () => {
    const cla =
      'I hereby agree to the terms of the CLA. Pre-Submission checklist:\n' +
      '- [x] read the guidelines\n- [x] signed off my commits\n- [x] Does this PR introduce a user-facing change?\n\n' +
      'Please review at your convenience.'
    const comments = [{ body: cla, author_association: 'MEMBER' }]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    // Filtered by isLowQualityComment before scoring; nothing survives.
    expect(result.solution).toBe('')
  })

  it('drops bot/codecov comments even when they contain code blocks', () => {
    const comments = [
      {
        body:
          'codecov report: coverage decreased by 0.3%.\n\n' +
          '```diff\n- covered: 88%\n+ covered: 87.7%\n```\n\n' +
          'Please review the affected files before merging this change.',
        author_association: 'NONE',
        user: { type: 'Bot' },
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    // Bot penalty + codecov penalty puts the score well below MIN_COMMENT_SCORE.
    expect(result.solution).toBe('')
  })

  it('penalises question-heavy comments so they never win the scoring', () => {
    const comments = [
      // Question-heavy: 3 questions / 3 sentences -> >0.5 ratio -> -5.
      {
        body:
          'Are you seeing this on a fresh cluster? Have you tried restarting the pod? What version of the operator is installed on your cluster?',
        author_association: 'MEMBER',
      },
    ]
    const result = extractResolutionFromIssue(mkIssue(), comments, null)
    // With no positive keywords and heavy question penalty, this cannot
    // clear MIN_COMMENT_SCORE.
    expect(result.solution).toBe('')
  })
})
