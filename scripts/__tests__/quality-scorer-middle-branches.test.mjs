/**
 * Additional branch coverage for scripts/quality-scorer.mjs.
 *
 * The existing scripts/__tests__/quality-scorer.test.mjs covers the
 * empty-mission / capped-out extremes and the top-line summary shape,
 * but leaves the middle branches of scoreResolution, scoreCode, and
 * scoreMetadata untested. A regression that flipped one of those middle
 * comparisons (e.g. `steps.length >= 3` -> `> 3`, `summary.length > 100`
 * -> `>= 100`, or `reactions > 5` -> `>= 5`) would land silently.
 *
 * All tests use the same buildMission fixture shape as the sibling
 * suite and drive scoreMission from the public API so no private
 * helpers need to be re-exported.
 */
import { describe, test, expect } from 'vitest'
import { scoreMission } from '../quality-scorer.mjs'

const buildMission = (overrides = {}) => ({
  mission: {
    description: '',
    steps: [],
    resolution: { summary: '', steps: [], codeSnippets: [] },
    ...overrides.mission,
  },
  metadata: overrides.metadata || {},
})

// ---------------------------------------------------------------------------
// scoreResolution middle branches
// ---------------------------------------------------------------------------

describe('scoreResolution middle branches', () => {
  test('summary length 51-100 chars awards the small length bonus (+3), not +6', () => {
    // 60-char summary — enters the >50 branch but NOT the >100 branch.
    const summary = 'Configmap was recreated to fix mount error in prod ns k8s'
    expect(summary.length).toBeGreaterThan(50)
    expect(summary.length).toBeLessThanOrEqual(100)
    const r = scoreMission(buildMission({
      mission: { resolution: { summary, steps: [], codeSnippets: [] } },
    }))
    // >50 length: +3, no "why" keywords, no steps, not-generic: +3
    // -> total 6
    expect(r.breakdown.resolutionCompleteness).toBe(6)
  })

  test('summary length <= 50 chars awards no length bonus', () => {
    const summary = 'Short fix summary.' // ~18 chars
    expect(summary.length).toBeLessThanOrEqual(50)
    const r = scoreMission(buildMission({
      mission: { resolution: { summary, steps: [], codeSnippets: [] } },
    }))
    // no length bonus, no "why", no steps, not-generic: +3 only
    expect(r.breakdown.resolutionCompleteness).toBe(3)
  })

  test('resolution.steps.length in [1,2] awards +2, not +4', () => {
    // One step + short summary -> isolate the steps branch.
    const r = scoreMission(buildMission({
      mission: {
        resolution: { summary: 'x', steps: [{}, {}], codeSnippets: [] },
      },
    }))
    // No length bonus, no "why", steps>=1: +2, not-generic: +3 -> 5
    expect(r.breakdown.resolutionCompleteness).toBe(5)
  })

  test('resolution.codeSnippets present adds +2', () => {
    const withoutSnippets = scoreMission(buildMission({
      mission: { resolution: { summary: 'x', steps: [], codeSnippets: [] } },
    }))
    const withSnippets = scoreMission(buildMission({
      mission: {
        resolution: {
          summary: 'x',
          steps: [],
          codeSnippets: ['echo hi'],
        },
      },
    }))
    expect(withSnippets.breakdown.resolutionCompleteness -
           withoutSnippets.breakdown.resolutionCompleteness).toBe(2)
  })

  test('"review the issue" filler in summary suppresses the not-generic +3', () => {
    // The regex is /see linked pr for|review the issue/i — the sibling
    // suite only exercises the "see linked pr for" arm.
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary: 'Please review the issue for context on the fix.',
          steps: [],
          codeSnippets: [],
        },
      },
    }))
    // ~46 chars <=50 so no length bonus, no "why", no steps,
    // "review the issue" matches -> no +3.
    expect(r.breakdown.resolutionCompleteness).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// scoreCode middle branches
// ---------------------------------------------------------------------------

describe('scoreCode middle branches', () => {
  test('codeSnippets count is capped at 3 (max +6)', () => {
    // Provide 5 snippets, none matching apiVersion+kind, no steps.
    // Expected: Math.min(5, 3) * 2 = 6.
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary: '',
          codeSnippets: ['a', 'b', 'c', 'd', 'e'],
        },
      },
    }))
    expect(r.breakdown.codePresence).toBe(6)
  })

  test('step with kubectl in prose but no code fence gets only +1', () => {
    const r = scoreMission(buildMission({
      mission: {
        steps: [{ title: 't', description: 'Run kubectl get pods here' }],
        resolution: { summary: '', codeSnippets: [] },
      },
    }))
    // No snippets, no ```, kubectl match: +1
    expect(r.breakdown.codePresence).toBe(1)
  })

  test('step with fenced block but no CLI keyword gets +2 only', () => {
    const r = scoreMission(buildMission({
      mission: {
        steps: [{ title: 't', description: '```\nsome code\n```' }],
        resolution: { summary: '', codeSnippets: [] },
      },
    }))
    // ```: +2
    expect(r.breakdown.codePresence).toBe(2)
  })

  test('apiVersion snippet WITHOUT kind gets no manifest bonus', () => {
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary: '',
          codeSnippets: ['apiVersion: v1'],
        },
      },
    }))
    // 1 snippet: +2, no "kind:" -> no +3
    expect(r.breakdown.codePresence).toBe(2)
  })

  test('YAML manifest bonus applies at most once', () => {
    // Three fully-qualified manifests -> +2*3 = 6 for snippets, +3 for
    // the FIRST manifest match (break); the second matcher must not
    // double-count.
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary: '',
          codeSnippets: [
            'apiVersion: v1\nkind: Pod',
            'apiVersion: apps/v1\nkind: Deployment',
            'apiVersion: v1\nkind: Service',
          ],
        },
      },
    }))
    // 3 snippets: +6, manifest bonus +3 (once) -> 9
    expect(r.breakdown.codePresence).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// scoreMetadata middle branches
// ---------------------------------------------------------------------------

describe('scoreMetadata middle branches', () => {
  test('1-2 tags award +1 (not +2)', () => {
    const one = scoreMission(buildMission({ metadata: { tags: ['a'] } }))
    const two = scoreMission(buildMission({ metadata: { tags: ['a', 'b'] } }))
    const three = scoreMission(buildMission({ metadata: { tags: ['a', 'b', 'c'] } }))
    // Baseline (default-difficulty): 0.5
    expect(one.breakdown.metadataQuality).toBe(1.5)
    expect(two.breakdown.metadataQuality).toBe(1.5)
    // The 3-tag arm should award +2 for a total of 2.5.
    expect(three.breakdown.metadataQuality).toBe(2.5)
  })

  test('reactions in (5, 20] award +1 (not +2)', () => {
    const low = scoreMission(buildMission({ metadata: { reactions: 6 } }))
    const boundary = scoreMission(buildMission({ metadata: { reactions: 20 } }))
    const high = scoreMission(buildMission({ metadata: { reactions: 21 } }))
    // low: 0.5 + 1 = 1.5. boundary: still >5, not >20 -> 0.5 + 1 = 1.5.
    // high: >20 -> 0.5 + 2 = 2.5.
    expect(low.breakdown.metadataQuality).toBe(1.5)
    expect(boundary.breakdown.metadataQuality).toBe(1.5)
    expect(high.breakdown.metadataQuality).toBe(2.5)
  })

  test('reactions <= 5 award 0 for engagement', () => {
    const r = scoreMission(buildMission({ metadata: { reactions: 5 } }))
    // 5 is NOT >5, so no engagement bonus. Baseline only: 0.5.
    expect(r.breakdown.metadataQuality).toBe(0.5)
  })

  test('difficulty "beginner" earns the non-default +1 (not just "expert")', () => {
    const r = scoreMission(buildMission({ metadata: { difficulty: 'beginner' } }))
    // Non-intermediate: +1 (not the 0.5 default). Nothing else set.
    expect(r.breakdown.metadataQuality).toBe(1)
  })

  test('sourceUrls without .issue/.source does not award the source bonus', () => {
    const r = scoreMission(buildMission({
      metadata: { sourceUrls: { comment: 'https://x/y' } },
    }))
    // Only the default-difficulty half-point should show up.
    expect(r.breakdown.metadataQuality).toBe(0.5)
  })

  test('sourceUrls.source variant awards the source bonus (+2)', () => {
    // The sibling suite exercises .issue and .sourceIssue; this hits
    // the middle .source arm of the || chain.
    const r = scoreMission(buildMission({
      metadata: { sourceUrls: { source: 'https://example.com/thread' } },
    }))
    // 0.5 baseline + 2 source -> 2.5
    expect(r.breakdown.metadataQuality).toBe(2.5)
  })

  test('targetResourceKinds present awards +2', () => {
    const r = scoreMission(buildMission({
      metadata: { targetResourceKinds: ['Pod'] },
    }))
    expect(r.breakdown.metadataQuality).toBe(2.5)
  })

  test('cncfProjects present awards +1', () => {
    const r = scoreMission(buildMission({
      metadata: { cncfProjects: ['kubernetes'] },
    }))
    expect(r.breakdown.metadataQuality).toBe(1.5)
  })
})
