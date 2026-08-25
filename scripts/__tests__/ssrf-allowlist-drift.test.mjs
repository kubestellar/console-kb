/**
 * Drift-detection tests for the LLM SSRF-guard allowlist.
 *
 * `ALLOWED_ENDPOINT_PREFIXES` and `assertTrustedEndpoint()` are duplicated
 * verbatim in four scripts:
 *
 *   - enrich-install-missions.mjs      (exported, covered by security-guards.test.mjs)
 *   - generate-cncf-install-missions.mjs   (NOT exported)
 *   - generate-platform-missions.mjs   (NOT exported)
 *   - mission-executor.mjs             (NOT exported)
 *
 * Only the first copy is currently exercised. A drift in any of the other
 * three copies — e.g. someone widens the allowlist for one script but not the
 * others — is a silent SSRF regression: the three unexported copies cannot
 * be imported without triggering their module-load side effects (each does
 * `const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)` at top
 * level, which throws if `LLM_ENDPOINT` is set to anything untrusted or
 * exercises rate-limit config parsing).
 *
 * These tests read all four files as text and enforce that:
 *   1. Each defines a single `ALLOWED_ENDPOINT_PREFIXES = [ ... ]` array literal.
 *   2. The parsed contents of that array are byte-equal across all four.
 *   3. Each defines an `assertTrustedEndpoint(endpoint, allowedPrefixes = ...)`
 *      function with the same body pattern (the `.some(prefix =>
 *      endpoint.startsWith(prefix))` check that is the actual SSRF gate).
 *   4. Each performs the module-load validation gate:
 *      `const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)`.
 *   5. All prefixes use HTTPS (defence-in-depth: catch anyone quietly adding
 *      an http:// entry).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsDir = join(__dirname, '..')

const FILES = [
  'enrich-install-missions.mjs',
  'generate-cncf-install-missions.mjs',
  'generate-platform-missions.mjs',
  'mission-executor.mjs',
]

/**
 * Extract every prefix string listed in the first
 * `ALLOWED_ENDPOINT_PREFIXES = [ ... ]` array literal in `source`.
 * Returns an array of string values in declaration order, or null if the
 * array literal is not found / malformed.
 *
 * NOTE: Deliberately regex-based (not `import`) so we do not trigger the
 * module's top-level `assertTrustedEndpoint(LLM_ENDPOINT)` side effect.
 */
function extractPrefixes(source) {
  const arrayMatch = source.match(
    /ALLOWED_ENDPOINT_PREFIXES\s*=\s*\[([\s\S]*?)\]/,
  )
  if (!arrayMatch) return null
  const body = arrayMatch[1]
  const prefixes = []
  const stringRe = /['"]([^'"]+)['"]/g
  let m
  while ((m = stringRe.exec(body))) prefixes.push(m[1])
  return prefixes
}

// Load every file's source and parsed prefix list once. Failures here mean
// the test itself is broken; surface them clearly rather than as N cascading
// per-file failures.
const sources = new Map()
const prefixesPerFile = new Map()
for (const name of FILES) {
  const source = readFileSync(join(scriptsDir, name), 'utf8')
  sources.set(name, source)
  prefixesPerFile.set(name, extractPrefixes(source))
}

// ─── 1. Every file defines the allowlist in a parseable form ─────────
describe('SSRF allowlist declaration', () => {
  for (const name of FILES) {
    it(`${name} declares ALLOWED_ENDPOINT_PREFIXES with at least one entry`, () => {
      const prefixes = prefixesPerFile.get(name)
      expect(prefixes, `no ALLOWED_ENDPOINT_PREFIXES literal in ${name}`).not.toBeNull()
      expect(prefixes.length).toBeGreaterThan(0)
    })
  }
})

// ─── 2. All four copies must have byte-equal contents ───────────────
describe('SSRF allowlist drift across duplicated copies', () => {
  it('all four files declare identical ALLOWED_ENDPOINT_PREFIXES', () => {
    const canonical = prefixesPerFile.get(FILES[0])
    for (const name of FILES.slice(1)) {
      const prefixes = prefixesPerFile.get(name)
      expect(
        prefixes,
        `${name} allowlist drifted from ${FILES[0]}:\n` +
          `  ${FILES[0]}: ${JSON.stringify(canonical)}\n` +
          `  ${name}: ${JSON.stringify(prefixes)}`,
      ).toEqual(canonical)
    }
  })

  it('the shared allowlist has exactly the expected 3 approved endpoints', () => {
    // Pinned expectation so a silent widening in ALL copies still fails.
    // If a new endpoint is genuinely approved, this test AND the security
    // review sign-off must both be updated.
    expect(prefixesPerFile.get(FILES[0])).toEqual([
      'https://models.inference.ai.azure.com/',
      'https://api.openai.com/',
      'https://api.githubcopilot.com/',
    ])
  })
})

// ─── 3. Every prefix must use HTTPS ─────────────────────────────────
describe('SSRF allowlist scheme', () => {
  for (const name of FILES) {
    it(`${name}: every prefix uses https://`, () => {
      const prefixes = prefixesPerFile.get(name)
      for (const p of prefixes) {
        expect(p, `non-https prefix in ${name}: ${p}`).toMatch(/^https:\/\//)
      }
    })

    it(`${name}: every prefix ends in '/'`, () => {
      // Trailing slash matters — 'https://api.openai.com' would allow-list
      // 'https://api.openai.com.evil.com' via startsWith().
      const prefixes = prefixesPerFile.get(name)
      for (const p of prefixes) {
        expect(p.endsWith('/'), `prefix missing trailing '/' in ${name}: ${p}`).toBe(true)
      }
    })
  }
})

// ─── 4. Every file has the assertTrustedEndpoint gate function ──────
describe('assertTrustedEndpoint function shape', () => {
  for (const name of FILES) {
    it(`${name} defines assertTrustedEndpoint using a prefix startsWith check`, () => {
      const source = sources.get(name)
      // Match either `function assertTrustedEndpoint` or `export function ...`
      expect(source).toMatch(
        /(?:export\s+)?function\s+assertTrustedEndpoint\s*\(\s*endpoint\s*,\s*allowedPrefixes\s*=\s*ALLOWED_ENDPOINT_PREFIXES\s*\)/,
      )
      // The actual gate: .some(prefix => endpoint.startsWith(prefix))
      expect(source).toMatch(
        /allowedPrefixes\.some\(\s*prefix\s*=>\s*endpoint\.startsWith\(\s*prefix\s*\)\s*\)/,
      )
      // Must throw on mismatch, not silently continue.
      expect(source).toMatch(/throw\s+new\s+Error\(\s*[`'"]\s*Untrusted\s+LLM_ENDPOINT/i)
    })
  }
})

// ─── 5. Every file invokes the gate at module load ──────────────────
describe('module-load validation gate', () => {
  for (const name of FILES) {
    it(`${name} calls assertTrustedEndpoint(LLM_ENDPOINT) at module load`, () => {
      const source = sources.get(name)
      // Prevent someone from silently removing the module-load gate — that
      // would leave the SSRF check callable but never actually called.
      expect(source).toMatch(
        /const\s+TRUSTED_LLM_ENDPOINT\s*=\s*assertTrustedEndpoint\s*\(\s*LLM_ENDPOINT\s*\)/,
      )
    })
  }
})
