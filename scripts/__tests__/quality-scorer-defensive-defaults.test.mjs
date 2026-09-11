/**
 * Final small-branch coverage for scripts/quality-scorer.mjs.
 *
 * The existing quality-scorer.test.mjs and quality-scorer-middle-branches.test.mjs
 * cover the majority of arms, but a handful of defensive-default arms
 * (the `|| {}` / `|| ''` / `?.` fallbacks) and one of the three arms in
 * the git-diff detector on line 220 are still untested. A regression
 * that dropped one of these defaults would blow up with
 * "cannot read property of undefined" the first time a caller fed us a
 * loosely-shaped mission — exactly what the defaults exist to guard
 * against — and no test would catch it.
 *
 * Each test targets one specific branch arm, keeping the assertions
 * narrow so a real behaviour change is easy to spot.
 */
import { describe, test, expect } from 'vitest'
import { scoreMission } from '../quality-scorer.mjs'

describe('scoreMission defensive-default arms', () => {
  test('mission object with no `.mission` key uses the `{}` fallback (line 15)', () => {
    // No .mission, no .metadata — every sub-scorer must still run
    // against a synthesized empty object without throwing.
    const r = scoreMission({})
    expect(r.pass).toBe(false)
    expect(typeof r.score).toBe('number')
    // scoreUniqueness starts at 15 and never dips below 0 for empty text,
    // so contentUniqueness stays at the max.
    expect(r.breakdown.contentUniqueness).toBe(15)
    // stepsSpecificity gets a `steps || []` at call site, so 0.
    expect(r.breakdown.stepsSpecificity).toBe(0)
  })

  test('mission object with no `.metadata` key uses the `{}` fallback (line 16)', () => {
    // Only .mission set — no .metadata.
    const r = scoreMission({ mission: { description: '' } })
    // scoreMetadata against {} gives the "not intermediate difficulty" +0.5.
    expect(r.breakdown.metadataQuality).toBe(0.5)
  })
})

describe('scoreSteps / scoreCode default-description arms', () => {
  test('step with no `description` uses the empty-string fallback (lines 57, 138)', () => {
    // Two steps with only titles — the `step.description || ''` fallback
    // must run inside BOTH scoreSteps and scoreCode. The score must be
    // finite (no undefined.includes crash) and the code-in-desc arms
    // must not fire.
    const r = scoreMission({
      mission: {
        steps: [
          { title: 'First step' },
          { title: 'Second step' },
        ],
      },
    })
    // scoreSteps: 2 steps -> 2 * 1.5 = 3 from step count.
    // No commands / code fences / paths -> no per-step adds.
    // Titles aren't "install "/"deploy "/"configure "/"apply "/"create ",
    // so the specific-title +0.5 also skips.
    expect(r.breakdown.stepsSpecificity).toBeGreaterThanOrEqual(3)
    // scoreCode with no code = 0.
    expect(r.breakdown.codePresence).toBe(0)
  })
})

describe('scoreUniqueness optional-chain fallback (line 192)', () => {
  test('mission with `resolution` entirely absent still scores uniqueness', () => {
    // `mission.resolution?.codeSnippets || []` — the `?.` short-circuit
    // fires (arm 1 of the || is taken).
    const r = scoreMission({
      mission: {
        description: 'A concrete pod restart problem in the prod-web cluster.',
        steps: [{ title: 't', description: 'do a thing' }],
        // no .resolution at all
      },
      metadata: {},
    })
    // No generic phrases, no codecov garbage, no diff — uniqueness starts
    // at 15 and stays there.
    expect(r.breakdown.contentUniqueness).toBe(15)
  })
})

describe('scoreUniqueness git-diff detector second arm (line 220)', () => {
  test('text containing "index " and "--- a/" but NOT "diff --git" still triggers the -5 penalty', () => {
    // The expression is:
    //   allStepDescs.includes('diff --git')
    //   || allStepDescs.includes('index ') && allStepDescs.includes('--- a/')
    // and `&&` binds tighter than `||`. The first arm ('diff --git') is
    // already covered by an existing test; the second-arm-only path (no
    // `diff --git` header, but a partial diff with `index ` and
    // `--- a/`) has never been exercised.
    const partialDiff =
      'index 1234567..89abcde 100644\n' +
      '--- a/some/file.yaml\n' +
      '+++ b/some/file.yaml\n'
    expect(partialDiff.includes('diff --git')).toBe(false)
    expect(partialDiff.includes('index ')).toBe(true)
    expect(partialDiff.includes('--- a/')).toBe(true)

    const withDiff = scoreMission({
      mission: {
        steps: [{ title: 't', description: partialDiff }],
      },
    })
    const withoutDiff = scoreMission({
      mission: {
        steps: [{ title: 't', description: 'plain step body with no diff markers' }],
      },
    })
    // The partial diff must cost -5 relative to the plain body — everything
    // else in the two fixtures is identical.
    expect(withoutDiff.breakdown.contentUniqueness - withDiff.breakdown.contentUniqueness).toBe(5)
  })
})
