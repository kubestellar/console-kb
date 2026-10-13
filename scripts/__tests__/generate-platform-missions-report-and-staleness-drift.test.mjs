/**
 * Source-drift invariants for two currently untested module-internal
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
 *   2. `checkVersionFreshness(...)` — before writing a mission, the
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
 *
 * `isMissionStale(filePath)` used to be covered here too, but its body
 * was byte-identical to the copy in `generate-cncf-install-missions.mjs`
 * (differing only in the staleness threshold) and has been extracted to
 * `lib/mission-file.mjs` (console-kb#3802). Its fail-safe-polarity source
 * drift is now pinned by `lib-mission-file-staleness-drift.test.mjs`;
 * this file only keeps a thin delegation check for the local wrapper.
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

// ─── isMissionStale (thin wrapper around lib/mission-file.mjs) ───────

describe('isMissionStale delegation drift', () => {
  const body = functionBody(SOURCE, 'export function isMissionStale(filePath)')

  it('delegates to the shared implementation instead of reimplementing it', () => {
    expect(body).toContain('sharedIsMissionStale(filePath')
  })

  it('forwards FORCE_REGENERATE as forceRegenerate', () => {
    expect(body).toMatch(/forceRegenerate:\s*FORCE_REGENERATE/)
  })

  it('forwards the configurable STALENESS_THRESHOLD_DAYS as thresholdDays', () => {
    // The threshold constant name is part of the operator contract for
    // the STALENESS_DAYS env var — do not silently rename.
    expect(body).toMatch(/thresholdDays:\s*STALENESS_THRESHOLD_DAYS/)
  })

  it('is anchored to a top-level STALENESS_THRESHOLD_DAYS constant sourced from STALENESS_DAYS', () => {
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

  it('uses a bounded network timeout via safeFetch(..., { timeoutMs })', () => {
    // A missing timeout turns a hostile helm mirror into a
    // never-completing generator run. safeFetch (not plain fetch) also
    // pins the DNS resolution used for connection to the one used for
    // SSRF validation, closing a TOCTOU/DNS-rebinding gap a separate
    // isSafeFetchUrl pre-check cannot (see lib/url-fetch-guard.mjs).
    expect(body).toContain('safeFetch(url, { timeoutMs: HELM_VALIDATE_TIMEOUT_MS })')
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
