/**
 * Drift-detection tests for the anti-PII `sanitizeInfraDetails()` sanitizer.
 *
 * The function exists in TWO places today:
 *
 *   - scripts/lib/text-utils.mjs         — exported, tested (text-utils.test.mjs).
 *                                          Used by generate-cncf-missions.mjs.
 *   - scripts/generate-platform-missions.mjs — LOCAL, unexported copy.
 *                                          Used by the platform-install
 *                                          mission generator on every scraped
 *                                          README / issue snippet before that
 *                                          text is sent to an LLM endpoint.
 *
 * The two implementations already diverge in what infrastructure PII they
 * redact:
 *
 *   Pattern                                  | text-utils | platform-missions
 *   -----------------------------------------|------------|-------------------
 *   Public IPv4 (RFC 1918 negative-lookahead)|     ✓      |         ✓
 *   AWS EC2 internal hostnames (ip-…)        |     ✓      |         ✓
 *   AWS EC2 public hostnames (ec2-…)         |     ✓      |         ✗   ← LEAK
 *   GCP compute internal (*.c.*.internal)    |     ✓      |         ✗   ← LEAK
 *   GKE node names (gke-…-…-…)               |     ✗      |         ✓
 *   Cloud account IDs (12-digit)             |     ✗      |         ✓
 *
 * The tests below are behavioural: they read the source of each file, extract
 * the set of regex literals that appear inside its `sanitizeInfraDetails`
 * function, and assert against a documented union of PII patterns that BOTH
 * scrapers must redact (public IPs and AWS EC2 hostnames). Additional
 * patterns unique to one scraper are recorded but not enforced across both
 * — that is the drift that a follow-up PR should close by having
 * generate-platform-missions.mjs re-use `text-utils.sanitizeInfraDetails`.
 *
 * The two currently-drifting patterns (`ec2-*` public hostnames and
 * `*.c.*.internal` GCP hostnames not being redacted on the platform side)
 * are pinned via a single `it.fails` subtest referencing the tracking issue.
 * When the drift is closed, that subtest starts unexpectedly passing and
 * vitest reports a failure — the signal to remove the pin.
 *
 * Tracked in kubestellar/console-kb#3065.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsDir = join(__dirname, '..')

const SHARED_SANITIZER_FILE = 'lib/text-utils.mjs'
const LOCAL_SANITIZER_FILE = 'generate-platform-missions.mjs'

/**
 * Extract the body of a named `function name(...) { ... }` block from a
 * source text. Returns null if not found. Relies on the function using
 * brace balance that starts at the first `{` after the signature — good
 * enough for the two hand-written sanitizers targeted here (no ES2015
 * template braces inside their bodies).
 */
function extractFunctionBody(source, funcName) {
  const re = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(source)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 1
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i)
    }
  }
  return null
}

/**
 * Extract every regex literal that appears inside a source blob. Uses a
 * conservative pattern that recognises `/…/flags` on its own line or after
 * common tokens (`(`, `,`, `=`, `return`). Good enough for the linear,
 * hand-written sanitizer bodies we target here; we intentionally avoid a
 * full JS parser to keep the test dependency-free.
 */
function extractRegexLiterals(source) {
  const out = []
  const re = /(?:^|[\s(,=]|return\s)(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/g
  let m
  while ((m = re.exec(source)) !== null) out.push(m[1])
  return out
}

function loadSanitizerRegexes(relFile, funcName) {
  const src = readFileSync(join(scriptsDir, relFile), 'utf8')
  const body = extractFunctionBody(src, funcName)
  if (body == null) {
    throw new Error(
      `sanitizeInfraDetails: could not locate '${funcName}' inside ` +
      `${relFile}. The drift test lost sight of its target — either ` +
      `the function was renamed, or the drift was closed by inlining. ` +
      `Update the test.`
    )
  }
  return extractRegexLiterals(body)
}

// ─── Fixture: patterns BOTH sanitizers must catch ────────────────────
//
// Documented as regex-substring probes (not full regex equality) so that
// a cosmetic refactor (e.g. adding non-capturing groups, swapping `\d` for
// `[0-9]`, or reordering RFC 1918 alternations) does NOT flag as drift.
// Each probe is a discriminating fragment that must appear verbatim inside
// SOME regex literal in the sanitizer body.
const MUST_REDACT_IN_BOTH = [
  {
    label: 'public IPv4 (RFC 1918 negative-lookahead)',
    probe: '(?!10\\.|172\\.',
  },
  {
    label: 'AWS EC2 internal hostname (ip-N-N-N-N.*.compute.internal)',
    probe: '\\bip-\\d+-\\d+-\\d+-\\d+',
  },
]

// ─── Drift patterns: currently caught by ONE side only ───────────────
//
// These are the LEAK vectors this test exposes. Each entry names the
// pattern that ONE sanitizer redacts and the OTHER does not. If a
// production fix closes the drift by re-using the shared sanitizer, the
// pinned `it.fails` subtest below turns green and this list should be
// deleted along with the pin.
const DRIFT_ONLY_IN_SHARED = [
  {
    label: 'AWS EC2 public hostname (ec2-N-N-N-N.*.compute.amazonaws.com)',
    probe: 'ec2-\\d+-\\d+-\\d+-\\d+',
  },
  {
    label: 'GCP compute internal (*.<region>-<zone>.c.<project>.internal)',
    probe: '\\.c\\.',
  },
]

const DRIFT_ONLY_IN_LOCAL = [
  {
    label: 'GKE node names (gke-…-…-…)',
    probe: 'gke-[a-z0-9-]+',
  },
  {
    label: 'cloud account IDs (bare 12-digit)',
    probe: '\\b\\d{12}\\b',
  },
]

describe('sanitizeInfraDetails drift between text-utils and generate-platform-missions', () => {
  let sharedRegexes
  let localRegexes

  it('locates a sanitizeInfraDetails function body in each file', () => {
    // Sanity gate: if either helper fails to find the function, every
    // downstream subtest would produce misleading passes/fails. Run
    // this first so a rename or refactor surfaces here with a clear
    // error before the pattern loop below.
    sharedRegexes = loadSanitizerRegexes(SHARED_SANITIZER_FILE, 'sanitizeInfraDetails')
    localRegexes = loadSanitizerRegexes(LOCAL_SANITIZER_FILE, 'sanitizeInfraDetails')
    expect(sharedRegexes.length).toBeGreaterThan(0)
    expect(localRegexes.length).toBeGreaterThan(0)
  })

  describe('MUST-redact patterns (both sanitizers)', () => {
    for (const { label, probe } of MUST_REDACT_IN_BOTH) {
      it(`shared sanitizer redacts: ${label}`, () => {
        const src = readFileSync(join(scriptsDir, SHARED_SANITIZER_FILE), 'utf8')
        const body = extractFunctionBody(src, 'sanitizeInfraDetails')
        expect(body).toContain(probe)
      })
      it(`local platform sanitizer redacts: ${label}`, () => {
        const src = readFileSync(join(scriptsDir, LOCAL_SANITIZER_FILE), 'utf8')
        const body = extractFunctionBody(src, 'sanitizeInfraDetails')
        expect(body).toContain(probe)
      })
    }
  })

  describe('pinned drift (expected to fail today; delete pin once closed)', () => {
    // A single `it.fails` subtest that asserts the drift IS closed —
    // i.e. that the local platform sanitizer also handles the two
    // AWS-public/GCP patterns currently only in the shared version.
    // When that becomes true (production PR aligns the two, or better,
    // has generate-platform-missions.mjs import from lib/text-utils),
    // this test starts passing, `it.fails` flips it to a failure, and
    // the pin gets removed. That is the intended workflow.
    it.fails(
      'local platform sanitizer covers AWS EC2 public + GCP internal hostnames',
      () => {
        const src = readFileSync(join(scriptsDir, LOCAL_SANITIZER_FILE), 'utf8')
        const body = extractFunctionBody(src, 'sanitizeInfraDetails')
        for (const { label, probe } of DRIFT_ONLY_IN_SHARED) {
          expect(body, `missing coverage: ${label}`).toContain(probe)
        }
      }
    )
  })

  describe('documentation-only: patterns unique to one side', () => {
    // Not enforced — these subtests exist so a future contributor
    // grepping for the drift pattern name finds this file. If either
    // side stops handling its unique pattern, its own author-owned
    // test suite (text-utils.test.mjs / any future
    // generate-platform-missions unit test) is the right place to
    // catch that regression.
    it('records shared-only patterns', () => {
      expect(DRIFT_ONLY_IN_SHARED.map(d => d.label)).toEqual([
        'AWS EC2 public hostname (ec2-N-N-N-N.*.compute.amazonaws.com)',
        'GCP compute internal (*.<region>-<zone>.c.<project>.internal)',
      ])
    })
    it('records local-only patterns', () => {
      expect(DRIFT_ONLY_IN_LOCAL.map(d => d.label)).toEqual([
        'GKE node names (gke-…-…-…)',
        'cloud account IDs (bare 12-digit)',
      ])
    })
  })
})
