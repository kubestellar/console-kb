// Coverage extension for generate-cncf-missions.mjs.
//
// Two of the three exported reporting helpers — formatReport and additional
// branches of buildDescription/buildResolutionSummary — sit uncovered even
// after generate-cncf-missions.scoring-branches.test.mjs. This file drives
// every remaining branch inside those exported symbols:
//
//   • buildDescription: feature/deploy branch (both reaction-count arms) and
//     the missing-body defensive branch.
//   • buildResolutionSummary: the "long solution that shrinks below 30 chars
//     after sentence-boundary truncation" branch (falls back to source URLs).
//   • formatReport: the full report happy-path (Copilot Issues Created
//     table), the empty-report degenerate path, and the missing-missions
//     defensive path.
//
// These are pure formatters; no fs, no network, no side effects.

import { describe, it, expect } from 'vitest'
import {
  buildDescription,
  formatReport,
} from '../generate-cncf-missions.mjs'

// ─── buildDescription — feature branch ───────────────────────────────

describe('buildDescription — feature mission type', () => {
  it('renders "Requested by N+ users" when a feature request has >=5 reactions', () => {
    // "feature request" in title steers detectMissionType() to 'feature'.
    const issue = {
      title: 'Please add feature: SSO login',
      body: 'It would be great to have SSO.',
      labels: [{ name: 'kind/feature' }],
      reactions: { total_count: 12 },
    }
    const desc = buildDescription(issue, {})
    expect(desc).toContain('12+ users')
    expect(desc).not.toContain('Community-requested feature')
    expect(desc).not.toContain('This issue affects')
  })

  it('renders "Community-requested feature" when a feature request has <5 reactions', () => {
    const issue = {
      title: 'Please add feature: dark mode',
      body: 'Please add dark mode.',
      labels: [{ name: 'enhancement' }],
      reactions: { total_count: 3 },
    }
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Community-requested feature')
    expect(desc).not.toContain('+ users')
  })
})

describe('buildDescription — missing body defensive branch', () => {
  it('does not throw when issue.body is undefined and still produces a description', () => {
    const issue = {
      title: 'Pods stuck in CrashLoopBackOff',
      // body: undefined  → exercises `issue.body || ''`
      labels: [{ name: 'bug' }],
      reactions: { total_count: 8 },
    }
    const desc = buildDescription(issue, {})
    expect(desc).toContain('Pods stuck in CrashLoopBackOff')
    // With no body, no error phrase is extractable → falls through to
    // the reaction-count suffix.
    expect(desc).toContain('8+ users')
  })
})

// Note: the `summary.length < 30` guard inside buildResolutionSummary is
// unreachable through public inputs — truncateAtSentenceBoundary never
// returns fewer than MIN_SENTENCE_TRUNCATION_POINT (50) characters, and
// buildResolutionSummary requires cleanSolution.length > 50 to enter the
// truncation branch at all. It is defensive dead code and cannot be
// exercised without a source-side change.

// ─── formatReport — empty / defensive / happy-path table ────────────

describe('formatReport — degenerate report (no projects, no missions)', () => {
  it('emits header + empty table body without throwing', () => {
    const md = formatReport({
      generated: 0,
      skipped: 0,
      errors: 0,
      projects: [],
      missions: [],
    })
    expect(md).toContain('# CNCF Mission Generation Report')
    expect(md).toContain('**Mission PRs created:** 0')
    expect(md).toContain('**Skipped:** 0')
    expect(md).toContain('**Errors:** 0')
    // report.generated === 0 → the "Copilot Issues Created" section must
    // NOT appear.
    expect(md).not.toContain('## Copilot Issues Created')
  })
})

describe('formatReport — full report with per-project rows and mission table', () => {
  it('renders the per-project rows and the Copilot Issues Created table', () => {
    const md = formatReport({
      generated: 2,
      skipped: 1,
      errors: 0,
      projects: [
        { name: 'kubernetes', maturity: 'graduated', issuesFound: 5, generated: 2, errors: 0 },
        { name: 'containerd', maturity: 'graduated', issuesFound: 3, generated: 0, errors: 1 },
      ],
      missions: [
        {
          title: 'fix-crashloop',
          difficulty: 'beginner',
          sourceIssue: 'https://github.com/kubernetes/kubernetes/issues/1',
          issueNumber: 42,
          issueUrl: 'https://github.com/kubestellar/console-kb/issues/42',
        },
        {
          // Second mission is a dry-run (no issueUrl) → exercises the
          // ternary's falsy arm.
          title: 'add-oidc-support',
          difficulty: 'intermediate',
          sourceIssue: 'https://github.com/kubernetes/kubernetes/issues/2',
          issueNumber: 43,
          issueUrl: undefined,
        },
      ],
    })
    expect(md).toContain('## Projects Processed')
    expect(md).toContain('| kubernetes | graduated | 5 | 2 | 0 |')
    expect(md).toContain('| containerd | graduated | 3 | 0 | 1 |')
    expect(md).toContain('## Copilot Issues Created')
    expect(md).toContain('| fix-crashloop | beginner |')
    expect(md).toContain('[#42](https://github.com/kubestellar/console-kb/issues/42)')
    // Dry-run mission: literal 'dry-run' string in the Issue column.
    expect(md).toContain('| add-oidc-support | intermediate |')
    expect(md).toContain('| dry-run |')
  })
})

describe('formatReport — generated>0 but missions field missing', () => {
  it('does not throw when report.missions is undefined and still emits the table header', () => {
    const md = formatReport({
      generated: 1,
      skipped: 0,
      errors: 0,
      projects: [
        { name: 'kubernetes', maturity: 'graduated', issuesFound: 1, generated: 1, errors: 0 },
      ],
      // missions: undefined → exercises the `report.missions || []` fallback
    })
    expect(md).toContain('## Copilot Issues Created')
    expect(md).toContain('| Mission | Difficulty | Source | Issue |')
    // Table header only, no rows appended.
    const rowCount = (md.match(/\| \[source\]\(/g) || []).length
    expect(rowCount).toBe(0)
  })
})
