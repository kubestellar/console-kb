/**
 * Drift-detection tests for the LLM SSRF-guard allowlist.
 *
 * `ALLOWED_ENDPOINT_PREFIXES` and `assertTrustedEndpoint()` used to be
 * duplicated verbatim in four scripts. As of kubestellar/console-kb#3134 /
 * #3333, `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` were consolidated onto a single shared
 * copy in `lib/llm-endpoint-guard.mjs` (imported + re-exported from both,
 * so the module-load SSRF gate still runs at import time in each). The
 * remaining two copies are out of scope for that refactor (see
 * kubestellar/console-kb#3100) and still carry their own local declaration:
 *
 *   - enrich-install-missions.mjs      (exported, covered by security-guards.test.mjs)
 *   - lib/executor-llm.mjs             (NOT exported; extracted from
 *                                        mission-executor.mjs by console-kb#3151,
 *                                        re-exported unchanged from there)
 *   - lib/llm-endpoint-guard.mjs        (shared canonical copy, imported by
 *                                        generate-cncf-install-missions.mjs and
 *                                        generate-platform-missions.mjs)
 *
 * These tests read the relevant files as text and enforce that:
 *   1. Each of the three declaration sites defines a single
 *      `ALLOWED_ENDPOINT_PREFIXES = [ ... ]` array literal.
 *   2. The parsed contents of that array are byte-equal across all three,
 *      AND the two consolidated generator scripts import the shared copy
 *      rather than re-declaring it.
 *   3. Each declaration site defines an `assertTrustedEndpoint(endpoint,
 *      allowedPrefixes = ...)` function with the same body pattern (the
 *      `.some(prefix => endpoint.startsWith(prefix))` check that is the
 *      actual SSRF gate).
 *   4. Every one of the four files (declaration sites + consolidated
 *      importers) performs the module-load validation gate:
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

// Files that must invoke the module-load SSRF gate on LLM_ENDPOINT.
const GATE_FILES = [
  'enrich-install-missions.mjs',
  'generate-cncf-install-missions.mjs',
  'generate-platform-missions.mjs',
  'lib/executor-llm.mjs',
]

// Files that declare (own) ALLOWED_ENDPOINT_PREFIXES / assertTrustedEndpoint
// locally. generate-cncf-install-missions.mjs and generate-platform-missions.mjs
// import both from lib/llm-endpoint-guard.mjs instead (checked separately below).
const DECLARATION_FILES = [
  'enrich-install-missions.mjs',
  'lib/executor-llm.mjs',
  'lib/llm-endpoint-guard.mjs',
]

// generate-cncf-install-missions.mjs / generate-platform-missions.mjs must
// import the shared guard rather than re-declaring it.
const CONSOLIDATED_IMPORTER_FILES = [
  'generate-cncf-install-missions.mjs',
  'generate-platform-missions.mjs',
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

// Load every relevant file's source once. Failures here mean the test
// itself is broken; surface them clearly rather than as N cascading
// per-file failures.
const ALL_FILES = [...new Set([...GATE_FILES, ...DECLARATION_FILES, ...CONSOLIDATED_IMPORTER_FILES])]
const sources = new Map()
for (const name of ALL_FILES) {
  sources.set(name, readFileSync(join(scriptsDir, name), 'utf8'))
}

const prefixesPerFile = new Map()
for (const name of DECLARATION_FILES) {
  prefixesPerFile.set(name, extractPrefixes(sources.get(name)))
}
// The consolidated files resolve to the shared lib's prefixes.
for (const name of CONSOLIDATED_IMPORTER_FILES) {
  prefixesPerFile.set(name, prefixesPerFile.get('lib/llm-endpoint-guard.mjs'))
}

const FILES = [...prefixesPerFile.keys()]

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

// ─── 4. Every declaration site has the assertTrustedEndpoint gate function ──
describe('assertTrustedEndpoint function shape', () => {
  for (const name of DECLARATION_FILES) {
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

  for (const name of CONSOLIDATED_IMPORTER_FILES) {
    it(`${name} imports assertTrustedEndpoint / ALLOWED_ENDPOINT_PREFIXES from lib/llm-endpoint-guard.mjs (no local re-declaration)`, () => {
      const source = sources.get(name)
      expect(source).toMatch(
        /import\s*\{[^}]*\bassertTrustedEndpoint\b[^}]*\}\s*from\s*['"]\.\/lib\/llm-endpoint-guard\.mjs['"]/,
      )
      expect(source).toMatch(
        /import\s*\{[^}]*\bALLOWED_ENDPOINT_PREFIXES\b[^}]*\}\s*from\s*['"]\.\/lib\/llm-endpoint-guard\.mjs['"]/,
      )
      expect(source).not.toMatch(/function\s+assertTrustedEndpoint\s*\(/)
    })
  }
})

// ─── 5. Every consumer invokes the gate at module load ───────────────
describe('module-load validation gate', () => {
  for (const name of GATE_FILES) {
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
