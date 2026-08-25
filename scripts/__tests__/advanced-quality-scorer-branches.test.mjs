/**
 * Branch-coverage tests for scripts/advanced-quality-scorer.mjs.
 *
 * The pre-existing `advanced-quality-scorer.test.js` only exercises a "perfect"
 * mission and a "poor" mission end-to-end. This file targets each of the five
 * dimension scorers (clarity, completeness, correctness, structure,
 * observability) plus the top-level `scoreMissionAdvanced` wiring so that
 * penalties, thresholds, and metadata resolution are all covered.
 */
import { describe, it, expect } from 'vitest'
import { scoreMissionAdvanced, MIN_SCORE } from '../advanced-quality-scorer.mjs'

const baseMission = (overrides = {}) => ({
  mission: {
    description: '',
    steps: [],
    resolution: { summary: '', codeSnippets: [] },
    ...overrides.mission,
  },
  metadata: overrides.metadata || {},
})

describe('MIN_SCORE default', () => {
  it('defaults to 60 when QUALITY_THRESHOLD env is unset', () => {
    // The module reads process.env at import time. In the vitest run the
    // variable is unset, so MIN_SCORE must be the documented default of 60.
    expect(MIN_SCORE).toBe(60)
  })
})

describe('scoreMissionAdvanced — top-level wiring', () => {
  it('returns all five breakdown dimensions and defaults path/project', () => {
    const result = scoreMissionAdvanced(baseMission())
    expect(Object.keys(result.breakdown).sort()).toEqual([
      'clarity',
      'completeness',
      'correctness',
      'observability',
      'structure',
    ])
    expect(result.project).toBe('unknown')
    expect(result.path).toBe('unknown')
    expect(result).toHaveProperty('pass')
    expect(result).toHaveProperty('issues')
    expect(result).toHaveProperty('suggestions')
  })

  it('honors explicit project + filepath arguments when metadata has no cncfProjects', () => {
    const result = scoreMissionAdvanced(baseMission(), 'coredns', 'fixes/coredns/oom.json')
    expect(result.project).toBe('coredns')
    expect(result.path).toBe('fixes/coredns/oom.json')
  })

  it('prefers metadata.cncfProjects[0] over the project argument', () => {
    const mission = baseMission({ metadata: { cncfProjects: ['istio', 'linkerd'] } })
    const result = scoreMissionAdvanced(mission, 'ignored-project')
    expect(result.project).toBe('istio')
  })

  it('falls back to the project arg when cncfProjects is defined but empty', () => {
    const mission = baseMission({ metadata: { cncfProjects: [] } })
    const result = scoreMissionAdvanced(mission, 'fallback')
    expect(result.project).toBe('fallback')
  })

  it('applies the supplied threshold to compute pass', () => {
    // Empty mission scores very low. With threshold=0 it must pass; with
    // threshold=1000 it must fail. This confirms the threshold argument is
    // wired through to the returned `pass` flag.
    const empty = baseMission()
    expect(scoreMissionAdvanced(empty, 'p', 'f', 0).pass).toBe(true)
    expect(scoreMissionAdvanced(empty, 'p', 'f', 1000).pass).toBe(false)
  })

  it('deduplicates issues and suggestions via Set', () => {
    // A mission with several short steps whose titles are all generic will
    // cause the structure scorer to add the "Step titles are completely
    // generic" issue only once even though multiple steps trip the check.
    const mission = baseMission({
      mission: {
        description: 'short',
        steps: [
          { title: 'Understand the problem', description: '' },
          { title: 'Apply the fix', description: '' },
        ],
        resolution: { summary: '', codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    const genericIssueCount = result.issues.filter(
      (i) => i === 'Step titles are completely generic',
    ).length
    expect(genericIssueCount).toBe(1)
  })

  it('rounds the final score to an integer', () => {
    const result = scoreMissionAdvanced(baseMission())
    expect(Number.isInteger(result.score)).toBe(true)
  })
})

describe('clarity dimension', () => {
  it('penalizes a description shorter than 30 chars', () => {
    const mission = baseMission({ mission: { description: 'too short' } })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Description is too brief or ambiguous')
    expect(result.breakdown.clarity).toBeLessThan(100)
  })

  it('detects Codecov bot noise regardless of case', () => {
    const mission = baseMission({
      mission: {
        description:
          'CODECOV report — Coverage dropped, please review the automated report attached.',
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Description contains auto-generated bot noise')
  })

  it('detects stale-bot noise', () => {
    const mission = baseMission({
      mission: {
        description:
          'This issue has been automatically marked as stale because it has not had recent activity.',
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Description contains auto-generated bot noise')
  })

  it('detects leftover PR template phrases', () => {
    const mission = baseMission({
      mission: {
        description:
          'What this PR does / why we need it: fixes a bug in the controller loop.',
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Description contains leftover PR template text')
  })

  it('never drives clarity below zero even with multiple penalties', () => {
    const mission = baseMission({
      mission: {
        description:
          'codecov what this pr does — Special notes for your reviewer: none.',
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.breakdown.clarity).toBeGreaterThanOrEqual(0)
  })
})

describe('completeness dimension', () => {
  it('penalizes missing steps heavily', () => {
    const mission = baseMission({
      mission: {
        steps: [],
        resolution: { summary: 'x'.repeat(80), codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Missing actionable steps')
  })

  it('penalizes a single-step mission with an "insufficient" warning', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: 'Do the thing', description: 'kubectl apply -f x.yaml' }],
        resolution: { summary: 'x'.repeat(80), codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain(
      'Insufficient steps to fully cover problem and resolution',
    )
  })

  it('accepts a resolution summary of 20+ chars without a completeness issue', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'A', description: '```kubectl apply```' },
          { title: 'B', description: 'ok' },
        ],
        resolution: {
          summary: 'A thorough explanation that is definitely over twenty chars.',
          codeSnippets: [],
        },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain(
      'Missing or inadequate resolution summary',
    )
  })

  it('flags a resolution summary shorter than 20 chars', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'A', description: 'ok' },
          { title: 'B', description: 'ok' },
        ],
        resolution: { summary: 'too short', codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Missing or inadequate resolution summary')
  })
})

describe('correctness dimension', () => {
  it('penalizes a mission whose steps contain git diff output', () => {
    const mission = baseMission({
      mission: {
        steps: [
          {
            title: 'Apply patch',
            description:
              'diff --git a/foo.go b/foo.go\n--- a/foo.go\n+++ b/foo.go\n@@\n- old\n+ new',
          },
        ],
        resolution: { summary: 'x'.repeat(80), codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain(
      'Includes raw git diff output instead of actionable commands or YAML',
    )
  })

  it('accepts fenced code in a step as valid code presence', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: 'Run', description: '```kubectl get pods```' }],
        resolution: { summary: 'x'.repeat(80), codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain(
      'Instruction logic missing required configuration fragments or commands',
    )
  })

  it('accepts codeSnippets on the resolution as valid code presence', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: 'Run', description: 'plain text with no fence' }],
        resolution: {
          summary: 'x'.repeat(80),
          codeSnippets: ['kubectl apply -f fix.yaml'],
        },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain(
      'Instruction logic missing required configuration fragments or commands',
    )
  })

  it('flags a mission with neither fenced code nor snippets', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: 'Run', description: 'plain text' }],
        resolution: { summary: 'x'.repeat(80), codeSnippets: [] },
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain(
      'Instruction logic missing required configuration fragments or commands',
    )
  })
})

describe('structure dimension', () => {
  it('flags missing tags', () => {
    const mission = baseMission({ metadata: { difficulty: 'intermediate' } })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Missing categorization tags')
  })

  it('flags missing difficulty when only whitespace', () => {
    const mission = baseMission({
      metadata: { tags: ['a', 'b'], difficulty: '   ' },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Difficulty level not set')
  })

  it('does not flag structure issues when tags and difficulty are set', () => {
    const mission = baseMission({
      metadata: { tags: ['x'], difficulty: 'advanced' },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('Missing categorization tags')
    expect(result.issues).not.toContain('Difficulty level not set')
  })

  it('flags when every step title is generic', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'Understand the problem', description: 'x' },
          { title: 'Apply the fix', description: 'x' },
          { title: 'Verify the fix', description: 'x' },
        ],
      },
      metadata: { tags: ['x'], difficulty: 'beginner' },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('Step titles are completely generic')
  })

  it('does not flag generic titles when at least one is specific', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'Understand the problem', description: 'x' },
          { title: 'Patch coredns ConfigMap', description: 'x' },
        ],
      },
      metadata: { tags: ['x'], difficulty: 'beginner' },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('Step titles are completely generic')
  })
})

describe('observability dimension', () => {
  it('flags missing verification and missing log/event evidence', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: 'Apply', description: 'edit the file' }],
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).toContain('No verification step or command found')
    expect(result.issues).toContain('Missing expected output or log checks')
  })

  it('recognises a "verify" step title as verification', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'Apply patch', description: 'plain text' },
          { title: 'Verify deployment', description: 'plain text' },
        ],
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('No verification step or command found')
  })

  it('recognises kubectl get/describe/logs as verification AND logs evidence', () => {
    const mission = baseMission({
      mission: {
        steps: [
          {
            title: 'Inspect',
            description: 'run `kubectl -n kube-system get pods` to inspect',
          },
        ],
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('No verification step or command found')
    expect(result.issues).not.toContain('Missing expected output or log checks')
  })

  it('recognises helm test as verification', () => {
    const mission = baseMission({
      mission: {
        steps: [{ title: 'Smoke test', description: 'helm test release-name' }],
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('No verification step or command found')
  })

  it('recognises curl commands as verification', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'HTTP check', description: 'curl https://svc.local/healthz' },
        ],
      },
    })
    const result = scoreMissionAdvanced(mission)
    expect(result.issues).not.toContain('No verification step or command found')
  })

  it('recognises "error:" markers in a step as expected-output evidence', () => {
    const mission = baseMission({
      mission: {
        steps: [
          { title: 'Verify status', description: 'Expected output contains "error: not found"' },
        ],
      },
    })
    const result = scoreMissionAdvanced(mission)
    // verify title trips verification; "error:" trips logs-or-events
    expect(result.issues).not.toContain('No verification step or command found')
    expect(result.issues).not.toContain('Missing expected output or log checks')
  })

  it('never drives observability below zero even when both penalties apply', () => {
    const mission = baseMission({ mission: { steps: [] } })
    const result = scoreMissionAdvanced(mission)
    expect(result.breakdown.observability).toBeGreaterThanOrEqual(0)
  })
})
