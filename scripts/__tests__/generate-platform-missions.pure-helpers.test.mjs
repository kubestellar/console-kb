/**
 * Unit tests for the two pure helpers now exported from
 * scripts/generate-platform-missions.mjs:
 *
 *   - serializeSanitizedMissionForFile(mission)
 *       Sole guard between an LLM-produced mission object and disk. Refuses
 *       to write oversized JSON (>1 MB) and refuses any post-sanitization
 *       payload that still contains a <script> tag or an on<event>=
 *       attribute. The issue that motivated exporting this
 *       (kubestellar/console-kb#3182) calls it out as a security-critical
 *       gate that was previously unreachable from vitest.
 *
 *   - formatReport(results)
 *       Pure Markdown formatter for the CI report. Groups results by
 *       verdict (pass / draft / rejected / skipped / failed), prints per-
 *       platform score lines, and appends grouped `Issues:` lines for
 *       drafted and rejected entries. Zero side effects.
 *
 * These two functions are pure — no fs, no network, no clock — so a
 * conventional vitest run covers every branch. Refs #3182 (partial:
 * this PR exports + tests 2 of the 6 helpers the issue calls out; the
 * remaining 4 require more setup and follow in separate PRs).
 */
import { describe, it, expect } from 'vitest'
import {
  serializeSanitizedMissionForFile,
  formatReport,
} from '../generate-platform-missions.mjs'

describe('serializeSanitizedMissionForFile — happy path', () => {
  it('returns pretty-printed JSON for a small clean mission', () => {
    const mission = { platform: 'demo', mission: { title: 'Install demo' } }
    const out = serializeSanitizedMissionForFile(mission)
    expect(out).toContain('"platform": "demo"')
    expect(out).toContain('"title": "Install demo"')
    // Pretty-print uses 2-space indent
    expect(out).toMatch(/^\{\n  "platform"/)
    // Round-trips as valid JSON
    expect(JSON.parse(out)).toEqual(mission)
  })

  it('serializes an empty mission object without throwing', () => {
    expect(() => serializeSanitizedMissionForFile({})).not.toThrow()
    expect(serializeSanitizedMissionForFile({})).toBe('{}')
  })
})

describe('serializeSanitizedMissionForFile — oversize guard (1 MB limit)', () => {
  it('throws when the serialized mission exceeds 1_000_000 bytes', () => {
    // 500_001 chars in a string yields ~500_003 bytes when JSON.stringified
    // (surrounding quotes), and pretty-printed structure adds a few more.
    // Two such strings comfortably exceed 1_000_000.
    const big = 'x'.repeat(500_001)
    const mission = { a: big, b: big }
    expect(() => serializeSanitizedMissionForFile(mission)).toThrow(
      /Refusing to write oversized mission/,
    )
  })

  it('permits a mission whose serialized form is just under 1 MB', () => {
    // 400_000 chars → ~400_004 bytes serialized; comfortably below limit.
    const mission = { blob: 'y'.repeat(400_000) }
    expect(() => serializeSanitizedMissionForFile(mission)).not.toThrow()
  })
})

describe('serializeSanitizedMissionForFile — script/event-handler guard', () => {
  it('rejects a mission containing a raw <script> tag anywhere in the tree', () => {
    const mission = { mission: { steps: [{ description: '<script>alert(1)</script>' }] } }
    expect(() => serializeSanitizedMissionForFile(mission)).toThrow(
      /Refusing to write mission containing unsafe HTML/,
    )
  })

  it('rejects a mission containing a case-variant script tag (<SCRIPT>)', () => {
    const mission = { title: '<SCRIPT SRC="x">' }
    expect(() => serializeSanitizedMissionForFile(mission)).toThrow(
      /Refusing to write mission containing unsafe HTML/,
    )
  })

  it('rejects a mission containing an on<event>= handler attribute', () => {
    const mission = { html: '<img src=x onerror=alert(1)>' }
    expect(() => serializeSanitizedMissionForFile(mission)).toThrow(
      /Refusing to write mission containing unsafe HTML/,
    )
  })

  it('rejects on<event>= with whitespace before the equals sign', () => {
    // The regex is /\bon\w+\s*=/i — matches `onclick =` too.
    const mission = { html: 'onclick = handler' }
    expect(() => serializeSanitizedMissionForFile(mission)).toThrow(
      /Refusing to write mission containing unsafe HTML/,
    )
  })

  it('permits a mission whose text merely mentions the word "script" (no tag)', () => {
    const mission = { description: 'Run the install script from upstream docs.' }
    expect(() => serializeSanitizedMissionForFile(mission)).not.toThrow()
  })
})

describe('formatReport — verdict grouping', () => {
  const header = /^# Platform Mission Generation Report\nGenerated: /

  it('emits the report header and a Summary block with zero counts on empty input', () => {
    const out = formatReport([])
    expect(out).toMatch(header)
    expect(out).toContain('## Summary')
    expect(out).toContain('- Published: 0')
    expect(out).toContain('- Drafted: 0')
    expect(out).toContain('- Rejected: 0')
    expect(out).toContain('- Skipped: 0')
    expect(out).toContain('- Failed: 0')
    // None of the per-verdict headings appear when the corresponding
    // bucket is empty.
    expect(out).not.toContain('## Published')
    expect(out).not.toContain('## Drafted')
    expect(out).not.toContain('## Rejected')
  })

  it('renders a Published section with score-annotated bullets and no Issues line', () => {
    const out = formatReport([
      { platform: 'foo', verdict: 'pass', score: 92 },
      { platform: 'bar', verdict: 'pass', score: 88 },
    ])
    expect(out).toContain('- Published: 2')
    expect(out).toContain('## Published')
    expect(out).toContain('- **foo** (score: 92)')
    expect(out).toContain('- **bar** (score: 88)')
    // A published entry never triggers the "Issues:" continuation line.
    expect(out).not.toContain('Issues:')
  })

  it('renders Drafted with an Issues: continuation when issues are supplied', () => {
    const out = formatReport([
      { platform: 'qux', verdict: 'draft', score: 71, issues: ['Only 2 steps (min 3)', 'No verification step found'] },
    ])
    expect(out).toContain('## Drafted (needs review)')
    expect(out).toContain('- **qux** (score: 71)')
    expect(out).toContain('  Issues: Only 2 steps (min 3); No verification step found')
  })

  it('renders Drafted without Issues: line when issues is missing or empty', () => {
    const out = formatReport([
      { platform: 'quux', verdict: 'draft', score: 60 }, // no issues field
      { platform: 'quuz', verdict: 'draft', score: 55, issues: [] }, // empty
    ])
    expect(out).toContain('## Drafted (needs review)')
    expect(out).toContain('- **quux** (score: 60)')
    expect(out).toContain('- **quuz** (score: 55)')
    expect(out).not.toContain('Issues:')
  })

  it('renders a Rejected section with Issues: continuation', () => {
    const out = formatReport([
      { platform: 'evil', verdict: 'rejected', score: 12, issues: ['Malicious content detected: script'] },
    ])
    expect(out).toContain('## Rejected')
    expect(out).toContain('- **evil** (score: 12)')
    expect(out).toContain('  Issues: Malicious content detected: script')
  })

  it('counts skipped and failed verdicts in Summary but does not print per-item sections for them', () => {
    // formatReport counts all 5 verdicts but only prints per-platform
    // bullets for pass/draft/rejected; skipped/failed roll up in
    // Summary only.
    const out = formatReport([
      { platform: 'ok', verdict: 'pass', score: 90 },
      { platform: 'sk', verdict: 'skipped', score: 0 },
      { platform: 'fx', verdict: 'failed', score: 0 },
    ])
    expect(out).toContain('- Published: 1')
    expect(out).toContain('- Skipped: 1')
    expect(out).toContain('- Failed: 1')
    expect(out).toContain('## Published')
    // No section headings for skipped / failed:
    expect(out).not.toContain('## Skipped')
    expect(out).not.toContain('## Failed')
  })

  it('groups a mixed batch into three sections in Published → Drafted → Rejected order', () => {
    const out = formatReport([
      { platform: 'a', verdict: 'pass', score: 95 },
      { platform: 'b', verdict: 'draft', score: 70, issues: ['x'] },
      { platform: 'c', verdict: 'rejected', score: 20, issues: ['y'] },
      { platform: 'd', verdict: 'pass', score: 91 },
    ])
    const pubIdx = out.indexOf('## Published')
    const draftIdx = out.indexOf('## Drafted')
    const rejIdx = out.indexOf('## Rejected')
    expect(pubIdx).toBeGreaterThan(0)
    expect(draftIdx).toBeGreaterThan(pubIdx)
    expect(rejIdx).toBeGreaterThan(draftIdx)
    // Both pass entries land in the same Published section:
    expect(out).toContain('- **a** (score: 95)')
    expect(out).toContain('- **d** (score: 91)')
  })
})
