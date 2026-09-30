/**
 * Drift-detection tests for the LLM SSRF-guard allowlist.
 *
 * `ALLOWED_ENDPOINT_PREFIXES` and `assertTrustedEndpoint()` used to be
 * duplicated verbatim in four scripts. As of kubestellar/console-kb#3134 /
 * #3333, `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` were consolidated onto a single shared
 * copy in `lib/llm-endpoint-guard.mjs` (imported + re-exported from both,
 * so the module-load SSRF gate still runs at import time in each). As of
 * kubestellar/console-kb#3614 the remaining two copies —
 * `enrich-install-missions.mjs` and `lib/executor-llm.mjs` — were
 * consolidated onto the same shared copy, so there is now a single
 * declaration site:
 *
 *   - lib/llm-endpoint-guard.mjs        (shared canonical copy, imported by
 *                                        every other file below)
 *
 * These tests read the relevant files as text and enforce that:
 *   1. The single declaration site defines a single
 *      `ALLOWED_ENDPOINT_PREFIXES = [ ... ]` array literal.
 *   2. The declaration site defines an `assertTrustedEndpoint(endpoint,
 *      allowedPrefixes = ...)` function with the same body pattern (the
 *      `.some(prefix => endpoint.startsWith(prefix))` check that is the
 *      actual SSRF gate).
 *   3. Every one of the four gate-invoking files
 *      (`enrich-install-missions.mjs`, `generate-cncf-install-missions.mjs`,
 *      `lib/platform-llm-config.mjs`, `lib/executor-llm.mjs`) performs the
 *      module-load validation gate:
 *      `const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)`.
 *   4. All prefixes use HTTPS (defence-in-depth: catch anyone quietly adding
 *      an http:// entry).
 *   5. Every non-canonical file imports `ALLOWED_ENDPOINT_PREFIXES` and
 *      `assertTrustedEndpoint` from `lib/llm-endpoint-guard.mjs` rather than
 *      re-declaring them.
 *   6. `sources/llm-synthesizer/config.mjs` (console-kb#3562) guards two
 *      *different* env vars (`LLM_ENDPOINT`, `ANTHROPIC_ENDPOINT`) against
 *      two different, narrower named policies (`GITHUB_MODELS_POLICY`,
 *      `ANTHROPIC_POLICY`, both exported by `lib/llm-endpoint-guard.mjs`).
 *      It must import `assertTrustedEndpoint` from the shared module
 *      instead of re-declaring the gate function, and both named policies
 *      are pinned so they can't silently widen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsDir = join(__dirname, '..')

// Files that must invoke the module-load SSRF gate on LLM_ENDPOINT.
// generate-platform-missions.mjs delegates its gate to
// lib/platform-llm-config.mjs (console-kb#3544), which it (and the
// extracted platform/*.mjs modules) import at module load.
const GATE_FILES = [
  'enrich-install-missions.mjs',
  'generate-cncf-install-missions.mjs',
  'lib/platform-llm-config.mjs',
  'lib/executor-llm.mjs',
]

// The single declaration (owning) site.
const DECLARATION_FILES = [
  'lib/llm-endpoint-guard.mjs',
]

// Every non-canonical file that consumes the SSRF gate must import both
// symbols from lib/llm-endpoint-guard.mjs rather than re-declaring them.
// (`enrich-install-missions.mjs` re-exports the imported symbols so the
// existing runtime-import tests in `enrich-install-missions-endpoint-trust`
// and `enrich-install-missions-security-drift` keep working unchanged.)
const CONSOLIDATED_IMPORTER_FILES = [
  'enrich-install-missions.mjs',
  'generate-cncf-install-missions.mjs',
  'lib/executor-llm.mjs',
  'lib/platform-llm-config.mjs',
]

// generate-platform-missions.mjs must obtain its LLM config (and thereby the
// module-load gate) from lib/platform-llm-config.mjs, not re-parse env itself.
// (platform/github-context.mjs no longer touches LLM config at all — its
// GitHub fetch path is owned by lib/cncf-github-client.mjs, console-kb#3551.)
const CONFIG_CONSUMER_FILES = [
  'generate-platform-missions.mjs',
  'platform/synthesize.mjs',
]

// sources/llm-synthesizer/config.mjs guards two *different* env vars
// (LLM_ENDPOINT, ANTHROPIC_ENDPOINT) against two narrower, named policies
// (GITHUB_MODELS_POLICY, ANTHROPIC_POLICY) exported by
// lib/llm-endpoint-guard.mjs. It must import assertTrustedEndpoint and both
// policies rather than re-declaring its own copy of the gate function
// (console-kb#3562) — the allowlists themselves are intentionally narrower
// than LLM_ENDPOINT_POLICY, so they are not part of the byte-equality check
// above, but drift in *those* policies is pinned separately below.
const SYNTHESIZER_CONFIG_FILE = 'sources/llm-synthesizer/config.mjs'

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

/**
 * Extract every prefix string listed in the first `name = [ ... ]` array
 * literal (any export name, e.g. `GITHUB_MODELS_POLICY`) in `source`.
 */
function extractNamedPolicy(source, exportName) {
  const arrayMatch = source.match(
    new RegExp(`${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\]`),
  )
  if (!arrayMatch) return null
  const prefixes = []
  const stringRe = /['"]([^'"]+)['"]/g
  let m
  while ((m = stringRe.exec(arrayMatch[1]))) prefixes.push(m[1])
  return prefixes
}

// Load every relevant file's source once. Failures here mean the test
// itself is broken; surface them clearly rather than as N cascading
// per-file failures.
const ALL_FILES = [...new Set([...GATE_FILES, ...DECLARATION_FILES, ...CONSOLIDATED_IMPORTER_FILES, ...CONFIG_CONSUMER_FILES, SYNTHESIZER_CONFIG_FILE])]
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

  it('the shared allowlist has exactly the expected 4 approved endpoints', () => {
    // Pinned expectation so a silent widening in ALL copies still fails.
    // If a new endpoint is genuinely approved, this test AND the security
    // review sign-off must both be updated.
    expect(prefixesPerFile.get(FILES[0])).toEqual([
      'https://models.github.ai/',
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
      // Match either `function assertTrustedEndpoint` or `export function ...`.
      // lib/llm-endpoint-guard.mjs's copy additionally accepts an optional
      // trailing `name` param (used by sources/llm-synthesizer/config.mjs's
      // two distinct policies) — allow that here too.
      expect(source).toMatch(
        /(?:export\s+)?function\s+assertTrustedEndpoint\s*\(\s*endpoint\s*,\s*allowedPrefixes\s*=\s*ALLOWED_ENDPOINT_PREFIXES\s*(?:,\s*name\s*=\s*['"]LLM_ENDPOINT['"]\s*)?\)/,
      )
      // The actual gate: .some(prefix => endpoint.startsWith(prefix))
      expect(source).toMatch(
        /allowedPrefixes\.some\(\s*prefix\s*=>\s*endpoint\.startsWith\(\s*prefix\s*\)\s*\)/,
      )
      // Must throw on mismatch, not silently continue. lib/llm-endpoint-guard.mjs's
      // copy interpolates the (optional) `name` param into the message instead
      // of hardcoding `LLM_ENDPOINT`; the other declaration sites hardcode it.
      expect(source).toMatch(/throw\s+new\s+Error\(\s*[`'"]\s*Untrusted\s+(?:LLM_ENDPOINT|\$\{name\})/i)
    })
  }

  for (const name of CONSOLIDATED_IMPORTER_FILES) {
    it(`${name} imports assertTrustedEndpoint / ALLOWED_ENDPOINT_PREFIXES from lib/llm-endpoint-guard.mjs (no local re-declaration)`, () => {
      const source = sources.get(name)
      // Top-level scripts import './lib/llm-endpoint-guard.mjs'; siblings
      // under lib/ import './llm-endpoint-guard.mjs'.
      expect(source).toMatch(
        /import\s*\{[^}]*\bassertTrustedEndpoint\b[^}]*\}\s*from\s*['"]\.\/(?:lib\/)?llm-endpoint-guard\.mjs['"]/,
      )
      expect(source).toMatch(
        /import\s*\{[^}]*\bALLOWED_ENDPOINT_PREFIXES\b[^}]*\}\s*from\s*['"]\.\/(?:lib\/)?llm-endpoint-guard\.mjs['"]/,
      )
      expect(source).not.toMatch(/function\s+assertTrustedEndpoint\s*\(/)
    })
  }

  for (const name of CONFIG_CONSUMER_FILES) {
    it(`${name} takes its LLM config from lib/platform-llm-config.mjs (no local env parsing / gate)`, () => {
      const source = sources.get(name)
      expect(source).toMatch(
        /import\s*\{[^}]*\}\s*from\s*['"]\.\.?\/lib\/platform-llm-config\.mjs['"]/,
      )
      // The env parse + SSRF gate must live in exactly one place.
      expect(source).not.toMatch(/process\.env\.LLM_ENDPOINT/)
      expect(source).not.toMatch(/assertTrustedEndpoint\s*\(/)
      // The extracted platform/*.mjs modules must not reverse-import the
      // orchestrator they were extracted from (console-kb#3544).
      expect(source).not.toMatch(/from\s*['"]\.\.\/generate-platform-missions\.mjs['"]/)
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

// ─── 6. sources/llm-synthesizer/config.mjs imports the shared gate ─────────
// (console-kb#3562): this file guards two different env vars against two
// different, narrower named policies, so it can't just import
// ALLOWED_ENDPOINT_PREFIXES like the CONSOLIDATED_IMPORTER_FILES above — but
// it must still import assertTrustedEndpoint (and both policies) rather than
// re-declaring its own copy of the gate function.
describe('sources/llm-synthesizer/config.mjs shares the gate function', () => {
  const source = sources.get(SYNTHESIZER_CONFIG_FILE)

  it('imports assertTrustedEndpoint, GITHUB_MODELS_POLICY, and ANTHROPIC_POLICY from lib/llm-endpoint-guard.mjs', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bassertTrustedEndpoint\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/llm-endpoint-guard\.mjs['"]/,
    )
    expect(source).toMatch(/\bGITHUB_MODELS_POLICY\b/)
    expect(source).toMatch(/\bANTHROPIC_POLICY\b/)
  })

  it('does not re-declare its own assertTrustedEndpoint function', () => {
    expect(source).not.toMatch(/function\s+assertTrustedEndpoint\s*\(/)
  })

  it('calls the module-load gate for both LLM_ENDPOINT and ANTHROPIC_ENDPOINT', () => {
    expect(source).toMatch(/assertTrustedEndpoint\s*\(\s*process\.env\.LLM_ENDPOINT/)
    expect(source).toMatch(/assertTrustedEndpoint\s*\(\s*process\.env\.ANTHROPIC_ENDPOINT/)
  })

  it('GITHUB_MODELS_POLICY and ANTHROPIC_POLICY are pinned (no silent widening)', () => {
    const guardSource = sources.get('lib/llm-endpoint-guard.mjs')
    expect(extractNamedPolicy(guardSource, 'GITHUB_MODELS_POLICY')).toEqual([
      'https://models.github.ai/',
      'https://models.inference.ai.azure.com/',
    ])
    expect(extractNamedPolicy(guardSource, 'ANTHROPIC_POLICY')).toEqual(['https://api.anthropic.com/'])
  })
})
