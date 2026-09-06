/**
 * Source-drift invariants for three currently untested module-internal
 * helpers of `scripts/generate-platform-missions.mjs`:
 *
 *   1. `formatReport(results)`     — assembles the Markdown platform
 *      generation report emitted after each run. Its bucket vocabulary
 *      and per-entry rendering shape are load-bearing: downstream
 *      dashboards / humans scanning the workflow log expect
 *      "## Summary", "## Published", "## Drafted (needs review)", and
 *      "## Rejected" sections plus a `- **<platform>** (score: N)` row
 *      shape. A quiet rename or an accidental drop of the `issues`
 *      dump would silently strip actionable info from the report.
 *
 *   2. `isMissionStale(filePath)`  — decides whether an existing
 *      mission on disk must be regenerated. Three branches must all
 *      survive refactors:
 *        (a) `FORCE_REGENERATE` short-circuits to `true`
 *        (b) missing or invalid `metadata.generatedAt` treats the
 *            mission as stale (fail-safe: regenerate)
 *        (c) an unreadable / non-JSON file returns `true`
 *      Any regression that flips the fail-safe polarity to `false`
 *      would let corrupt / unreadable missions be treated as fresh
 *      and never regenerated.
 *
 *   3. `checkVersionFreshness(...)` — before writing a mission, the
 *      generator checks the helm repo's `index.yaml` for the pinned
 *      chart version. The version string comes from an HTTP-fetched
 *      chart index and is interpolated into a `RegExp`. The module
 *      already learned this lesson (js/incomplete-sanitization,
 *      CWE-116/20) and escapes ALL regex metacharacters via
 *      `s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`. A partial-set
 *      refactor (e.g. dropping `|` or `\\`) would re-open the RegExp
 *      injection path.
 *
 * These helpers are module-internal (no exports), so this suite uses
 * the same source-drift pattern already established for this file by
 * `generate-platform-missions-security-drift.test.mjs` and
 * `generate-platform-missions-verdict-drift.test.mjs`.
 *
 * See kubestellar/console-kb#3182 (10% coverage — mostly-untested CLI
 * generator) for the tracking issue this suite is filed under.
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

function functionBody(src, header) {
  const start = src.indexOf(header)
  expect(start, `expected to find "${header}" in source`).toBeGreaterThanOrEqual(0)
  // Match the closing `\n}` at column zero — same convention used by
  // the sibling drift suites for this file.
  const end = src.indexOf('\n}\n', start)
  expect(end, `expected "${header}" to have a top-level closing brace`).toBeGreaterThan(start)
  return src.slice(start, end + 2)
}

// ─── formatReport ───────────────────────────────────────────────────

describe('formatReport source drift', () => {
  const body = functionBody(SOURCE, 'function formatReport(results)')

  it('emits the top-level report title', () => {
    expect(body).toContain('# Platform Mission Generation Report')
  })

  it('emits an ISO-timestamped "Generated:" line', () => {
    expect(body).toMatch(/Generated:\s*\$\{new Date\(\)\.toISOString\(\)\}/)
  })

  it('emits a "## Summary" section header', () => {
    expect(body).toContain('## Summary')
  })

  it('emits exactly the five known bucket labels in the summary', () => {
    // Downstream tooling greps for these prefixes — they must not drift.
    for (const label of ['Published:', 'Drafted:', 'Rejected:', 'Skipped:', 'Failed:']) {
      expect(body, `summary must include "- ${label}"`).toContain(`- ${label}`)
    }
  })

  it('splits results by verdict into published / drafted / rejected buckets', () => {
    for (const verdict of ['pass', 'draft', 'rejected']) {
      expect(body).toContain(`r.verdict === '${verdict}'`)
    }
  })

  it('also tallies the skipped and failed verdicts', () => {
    for (const verdict of ['skipped', 'failed']) {
      expect(body).toContain(`r.verdict === '${verdict}'`)
    }
  })

  it('emits per-entry rows with platform name and score', () => {
    // Shape is `- **<platform>** (score: <score>)`
    expect(body).toMatch(/-\s+\*\*\$\{r\.platform\}\*\*\s+\(score:\s+\$\{r\.score\}\)/)
  })

  it('dumps drafted issues when present', () => {
    // A regression that drops the issues dump strips actionable info.
    const drafted = body.slice(body.indexOf('drafted.length > 0'))
    expect(drafted).toMatch(/if\s*\(\s*r\.issues\?\.length\s*\)/)
    expect(drafted).toContain("Issues:")
  })

  it('dumps rejected issues when present', () => {
    const rejected = body.slice(body.indexOf('rejected.length > 0'))
    expect(rejected).toMatch(/if\s*\(\s*r\.issues\?\.length\s*\)/)
    expect(rejected).toContain("Issues:")
  })
})

// ─── isMissionStale ─────────────────────────────────────────────────

describe('isMissionStale source drift', () => {
  const body = functionBody(SOURCE, 'function isMissionStale(filePath)')

  it('short-circuits to true when FORCE_REGENERATE is set', () => {
    // This must be the FIRST guard — swapping order would parse the
    // file on every call even in a forced-regeneration run.
    expect(body).toMatch(/^\s*if\s*\(FORCE_REGENERATE\)\s*return\s*true/m)
    const forceIdx = body.indexOf('FORCE_REGENERATE')
    const readIdx = body.indexOf('readFileSync')
    expect(forceIdx).toBeGreaterThan(0)
    expect(readIdx).toBeGreaterThan(forceIdx)
  })

  it('reads and JSON-parses the mission file', () => {
    expect(body).toContain('readFileSync(filePath')
    expect(body).toContain("JSON.parse")
  })

  it('treats a missing metadata.generatedAt as stale (fail-safe)', () => {
    expect(body).toContain('metadata?.generatedAt')
    // The `if (!generatedAt) return true` guard must remain.
    expect(body).toMatch(/if\s*\(!generatedAt\)\s*return\s*true/)
  })

  it('compares age in days against STALENESS_THRESHOLD_DAYS', () => {
    // The threshold constant name is part of the operator contract for
    // the STALENESS_DAYS env var — do not silently rename.
    expect(body).toContain('STALENESS_THRESHOLD_DAYS')
    // Age computation must be in days: divide by 1000 * 60 * 60 * 24.
    expect(body).toMatch(/1000\s*\*\s*60\s*\*\s*60\s*\*\s*24/)
  })

  it('catches read/parse failures and returns true (fail-safe polarity)', () => {
    // The catch block MUST return true — flipping to false would
    // treat a corrupt / unreadable mission as fresh forever.
    expect(body).toMatch(/catch\s*\{[\s\S]*?return\s+true[\s\S]*?\}/)
    // And, crucially, must not silently `return false` in the catch.
    const catchMatch = body.match(/catch\s*\{([\s\S]*?)\}/)
    expect(catchMatch, 'isMissionStale must have a catch block').not.toBeNull()
    expect(catchMatch[1]).not.toMatch(/return\s+false/)
  })

  it('is anchored to a top-level STALENESS_THRESHOLD_DAYS constant sourced from STALENESS_DAYS', () => {
    // Kept in this file (not just the helper's own drift) because a
    // rename of the constant without updating this helper would
    // silently break staleness detection for every platform run.
    expect(SOURCE).toMatch(
      /const\s+STALENESS_THRESHOLD_DAYS\s*=\s*parseInt\(process\.env\.STALENESS_DAYS\s*\|\|\s*'14',\s*10\)/,
    )
  })
})

// ─── checkVersionFreshness (regex-injection defense) ────────────────

describe('checkVersionFreshness regex-metachar escape drift', () => {
  const body = functionBody(SOURCE, 'async function checkVersionFreshness(helmRepoUrl, chartName, version)')

  it('has an escapeRegExpChars helper that escapes every regex metacharacter', () => {
    // The exact character class MUST include every JS regex
    // metacharacter used in Helm index.yaml version strings that
    // could otherwise be treated as regex syntax when interpolated
    // into a new RegExp. Dropping any one re-opens CWE-116/20.
    // The set below matches the current source; if it needs to
    // change, update this expectation in the same PR.
    const REQUIRED = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\\\']
    // Match `s.replace(<regex>, ...)`. The replacement string contains
    // literal backslashes which are painful to double-escape in a JS
    // regex — we only care about the character class, which is
    // delimited by the FIRST slash and the last slash-before-flags.
    const escapeLine = body.match(/const\s+escapeRegExpChars\s*=\s*s\s*=>\s*s\.replace\(\s*\/([^\n]+?)\/[gimsuy]*\s*,/)
    expect(escapeLine, 'checkVersionFreshness must define escapeRegExpChars via s.replace(/.../, ...)').not.toBeNull()
    const charClass = escapeLine[1]
    for (const meta of REQUIRED) {
      expect(
        charClass,
        `escapeRegExpChars regex must escape "${meta.replace('\\\\', '\\')}"`,
      ).toContain(meta)
    }
    for (const meta of REQUIRED) {
      expect(
        charClass,
        `escapeRegExpChars regex must escape "${meta.replace('\\\\', '\\')}"`,
      ).toContain(meta)
    }
  })

  it('applies escapeRegExpChars to the caller-supplied version before constructing the RegExp', () => {
    // Untrusted (HTTP-derived) version string must be escaped
    // before interpolation into `new RegExp(...)`.
    expect(body).toMatch(/new RegExp\(\s*`[^`]*escapeRegExpChars\(version\)[^`]*`/)
  })

  it('uses a bounded network timeout via AbortSignal.timeout', () => {
    // A missing timeout turns a hostile helm mirror into a
    // never-completing generator run.
    expect(body).toContain('AbortSignal.timeout(HELM_VALIDATE_TIMEOUT_MS)')
    expect(SOURCE).toMatch(/const\s+HELM_VALIDATE_TIMEOUT_MS\s*=\s*\d+/)
  })

  it('fails open (returns true) on fetch failure so a broken helm mirror does not block generation', () => {
    // Two paths must both return true:
    //   - non-ok HTTP response
    //   - thrown fetch error
    expect(body).toMatch(/if\s*\(!res\.ok\)\s*return\s*true/)
    expect(body).toMatch(/catch\s*\{[^}]*return\s+true[^}]*\}/)
  })
})
