/**
 * Nullish-step-field branch coverage for advanced-quality-scorer.mjs.
 *
 * The pre-existing `advanced-quality-scorer-branches.test.mjs` covers each
 * dimension end-to-end, but every test supplies `title:` and `description:`
 * on every step. The scorer defensively normalises both fields with
 * `(step.title || '').toLowerCase()` / `(step.description || '').toLowerCase()`
 * — the right-hand fallback branches of those two `||` expressions inside
 * `evaluateActionability` (line 202) and `evaluateObservability` (line 224)
 * were the last two uncovered branches in this module. A regression that
 * removed the `|| ''` guard would surface as a `TypeError: Cannot read
 * properties of undefined` on the very first mission with a stepless title;
 * this file pins that shape down.
 */
import { describe, it, expect } from 'vitest'
import { scoreMissionAdvanced } from '../advanced-quality-scorer.mjs'

const baseMission = (overrides = {}) => ({
  mission: {
    description: '',
    steps: [],
    resolution: { summary: '', codeSnippets: [] },
    ...overrides.mission,
  },
  metadata: overrides.metadata || {},
})

describe('advanced-quality-scorer: nullish step-field branches', () => {
  it('tolerates steps whose title is missing (undefined) inside evaluateActionability', () => {
    // No `title` key at all — the `(step.title || '')` fallback in
    // evaluateActionability must resolve to '' rather than throwing.
    const mission = baseMission({
      mission: {
        steps: [{ description: 'kubectl apply -f patch.yaml' }],
      },
      metadata: { tags: ['x'], difficulty: 'beginner' },
    })
    const result = scoreMissionAdvanced(mission)
    // A missing title cannot match any of the "understand/verify the fix/
    // apply the fix" generic patterns, so the "generic titles" penalty
    // must not fire even though every step counted as non-generic.
    expect(result.issues).not.toContain('Step titles are completely generic')
    expect(typeof result.score).toBe('number')
  })

  it('tolerates steps whose title is null inside evaluateActionability', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: null, description: 'kubectl apply -f patch.yaml' }],
      },
      metadata: { tags: ['x'], difficulty: 'beginner' },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('Step titles are completely generic')
  })

  it('tolerates steps whose title AND description are missing inside evaluateObservability', () => {
    // Both `(step.title || '')` and `(step.description || '')` fallbacks
    // must resolve to '' — evaluateObservability walks `steps` and reads
    // both fields to detect verification + logs/events.
    const mission = baseMission({
      mission: {
        // Two stepless-shape steps, one with an empty object, one with
        // an unrelated key. Neither has title nor description.
        steps: [{}, { note: 'placeholder from a scraped template' }],
      },
    })
    const result = scoreMissionAdvanced(mission)
    // No verification signal can be extracted from empty titles/descs, so
    // the observability dimension must flag both defects rather than
    // throwing.
    expect(result.issues).toContain('No verification step or command found')
    expect(result.issues).toContain('Missing expected output or log checks')
  })

  it('tolerates a step whose description is missing but title is a verification signal', () => {
    // Cross-branch: title is present (drives the title-side match) while
    // description is absent (exercises the description-side fallback).
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'Apply patch' },
          { title: 'Verify deployment rollout' },
        ],
      },
    })
    const result = scoreMissionAdvanced(mission)
    // A "verify" title should satisfy the verification signal even with
    // no description on any step.
    expect(result.issues).not.toContain('No verification step or command found')
    // But no kubectl-in-description means the logs/events check still fires.
    expect(result.issues).toContain('Missing expected output or log checks')
  })
})
