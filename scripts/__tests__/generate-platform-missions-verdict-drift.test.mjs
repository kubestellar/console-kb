/**
 * Source-drift invariant for the internal verdict vocabulary of
 * `scripts/generate-platform-missions.mjs`.
 *
 * The generator has three verdict producers and two verdict consumers:
 *
 *   Producers (values that end up in `results[i].verdict`):
 *     - applyQualityGate(...)          → 'pass' | 'draft' | 'rejected'
 *     - main() early-continue path     → 'skipped'
 *     - main() LLM-failure path        → 'failed'
 *
 *   Consumers (values compared against `r.verdict`):
 *     - formatReport(results)          → filters the Markdown report buckets
 *     - main() end-of-run summary      → prints the console tally
 *
 * A regression that renames one side without the other silently mis-reports
 * platform generation runs. The known example this test was written for is
 * kubestellar/console-kb#3072: `applyQualityGate` emits verdict `'pass'`,
 * but both consumers filter on `'publish'` — so passing platforms are
 * counted as neither published nor drafted nor rejected, and every
 * generated report reads `Published: 0`.
 *
 * Because `applyQualityGate` and `formatReport` are module-internal
 * (not exported), this invariant is enforced by static analysis of the
 * source text — same pattern as `sanitize-infra-details-drift.test.mjs`
 * and `ssrf-allowlist-drift.test.mjs`. This is intentionally strict:
 * any new verdict literal introduced on one side must be introduced on
 * the other, or explicitly noted in the corresponding allowlist below.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(
  join(HERE, '..', 'generate-platform-missions.mjs'),
  'utf8',
)

/**
 * Verdicts that come out of applyQualityGate. The verdict expression is
 *
 *   const verdict = !pass
 *     ? (score >= DRAFT_THRESHOLD ? 'draft' : 'rejected')
 *     : 'pass'
 *
 * so we just parse the two-line ternary and the trailing literal.
 */
function extractQualityGateVerdicts(src) {
  const start = src.indexOf('function applyQualityGate')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  const body = src.slice(start, end)
  const literals = new Set()
  for (const m of body.matchAll(/verdict\s*=[\s\S]*?['"]([a-z]+)['"][\s\S]*?['"]([a-z]+)['"][\s\S]*?['"]([a-z]+)['"]/g)) {
    literals.add(m[1])
    literals.add(m[2])
    literals.add(m[3])
    break
  }
  return literals
}

/**
 * Verdicts pushed directly by main(): the early-continue path for
 * missions that don't need regeneration, and the LLM-failure path.
 */
function extractMainDirectVerdicts(src) {
  const literals = new Set()
  for (const m of src.matchAll(/results\.push\(\s*\{[^}]*verdict:\s*['"]([a-z]+)['"]/g)) {
    literals.add(m[1])
  }
  return literals
}

/**
 * Every `r.verdict === '<literal>'` filter comparison anywhere in the
 * file. This catches both `formatReport` and the end-of-`main` summary.
 */
function extractConsumerVerdicts(src) {
  const literals = new Set()
  for (const m of src.matchAll(/r\.verdict\s*===\s*['"]([a-z]+)['"]/g)) {
    literals.add(m[1])
  }
  return literals
}

/**
 * Every allowlisted key in VERDICT_SUFFIX_MAP — the filename-suffix
 * table used when writing missions to disk.
 */
function extractSuffixMapKeys(src) {
  const literals = new Set()
  const m = src.match(/VERDICT_SUFFIX_MAP\s*=\s*Object\.freeze\(\{([^}]*)\}\)/)
  if (!m) return literals
  for (const kv of m[1].matchAll(/\b([a-z]+)\s*:/g)) {
    literals.add(kv[1])
  }
  return literals
}

describe('generate-platform-missions.mjs verdict-vocabulary drift', () => {
  const gate = extractQualityGateVerdicts(SOURCE)
  const direct = extractMainDirectVerdicts(SOURCE)
  const consumer = extractConsumerVerdicts(SOURCE)
  const suffixKeys = extractSuffixMapKeys(SOURCE)
  const produced = new Set([...gate, ...direct])

  it('applyQualityGate emits the documented three-verdict vocabulary', () => {
    // Locks the producer against future silent additions or renames.
    // If this test needs to change, the corresponding formatReport
    // filters and (if applicable) VERDICT_SUFFIX_MAP entry must
    // change in the same PR.
    expect([...gate].sort()).toEqual(['draft', 'pass', 'rejected'])
  })

  it('main() pushes the documented two direct verdicts', () => {
    // Same lock for the non-gated paths: {'skipped','failed'}.
    expect([...direct].sort()).toEqual(['failed', 'skipped'])
  })

  it('every consumer verdict literal is actually produced somewhere', () => {
    // The bug this test was written for: 'publish' appears in both
    // formatReport() and the end-of-main summary but is never produced.
    // Every passing platform therefore gets counted as neither
    // published, drafted, nor rejected in the generated report and
    // console tally.
    //
    // Rename either side to match once fixed, then this assertion
    // will start passing. Tracked in kubestellar/console-kb#3072.
    const unproduced = [...consumer].filter(v => !produced.has(v))
    expect(unproduced).toEqual([])
  })

  it('every produced verdict is either counted by a consumer or explicitly allowlisted in VERDICT_SUFFIX_MAP', () => {
    // This asserts the opposite direction: if applyQualityGate or the
    // direct-push paths add a new verdict, at least one downstream
    // (report, summary, or filename-suffix table) has to acknowledge
    // it — otherwise a future run silently drops it on the floor.
    //
    // The suffix map is included in the allowlist because it *is* a
    // legitimate acknowledgement site: 'pass' currently only appears
    // there (with empty suffix), even though — until #3072 is fixed —
    // 'pass' does not appear among the r.verdict filters.
    const acknowledged = new Set([...consumer, ...suffixKeys])
    const dropped = [...produced].filter(v => !acknowledged.has(v))
    expect(dropped).toEqual([])
  })

  it('VERDICT_SUFFIX_MAP only allowlists real producer verdicts (or explicit legacy aliases)', () => {
    // Every entry in the suffix map should be a real producer verdict.
    // Historical aliases ('review') are allowed to stay documented in
    // the map — they may be intentionally accepted for backward
    // compatibility with older mission files. But adding a brand-new
    // key here without a corresponding producer would be a bug.
    const LEGACY_ALIASES = new Set(['review'])
    const orphans = [...suffixKeys]
      .filter(v => !produced.has(v) && !LEGACY_ALIASES.has(v))
    expect(orphans).toEqual([])
  })
})
