/**
 * Drift-detection tests for LLM endpoint configuration.
 *
 * Every mission-generation / enrichment / execution script used to carry
 * its own `LLM_ENDPOINT` default of `https://models.github.ai/...` plus a
 * shared host allowlist (`ALLOWED_ENDPOINT_PREFIXES`, `GITHUB_MODELS_POLICY`)
 * in `lib/llm-endpoint-guard.mjs` (console-kb#3134, #3333, #3562, #3614).
 * GitHub Models was retired, and every call site now goes through the
 * env-configured LLM proxy owned by `lib/llm-proxy-config.mjs`
 * (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`, console-kb#3702).
 *
 * These tests read the relevant files as text and enforce that:
 *   1. No script references the retired `models.github.ai` endpoint.
 *   2. Only `lib/llm-proxy-config.mjs` reads `LLM_BASE_URL` / `LLM_API_KEY`,
 *      and no script reads the legacy `LLM_ENDPOINT` / `LLM_TOKEN` env vars.
 *   3. Every LLM call site imports its config from `lib/llm-proxy-config.mjs`
 *      (directly, or via `lib/platform-llm-config.mjs`).
 *   4. `lib/llm-endpoint-guard.mjs` keeps only the fixed-host Anthropic
 *      policy, pinned so it can't silently widen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsDir = join(__dirname, '..')

const CONFIG_FILE = 'lib/llm-proxy-config.mjs'

// Files that issue LLM requests and must take their endpoint/key/model from
// lib/llm-proxy-config.mjs.
const DIRECT_CONSUMERS = [
  'enrich-install-missions.mjs',
  'generate-cncf-install-missions.mjs',
  'lib/executor-llm.mjs',
  'lib/llm-json-request.mjs',
  'lib/platform-llm-config.mjs',
  'mission-executor.mjs',
  'sources/llm-synthesizer/config.mjs',
]
// Platform modules get the proxy config via lib/platform-llm-config.mjs.
const PLATFORM_CONSUMERS = [
  'generate-platform-missions.mjs',
  'platform/synthesize.mjs',
]
const OTHER_LLM_FILES = [
  'lib/llm-endpoint-guard.mjs',
  'sources/llm-synthesizer/index.mjs',
  'sources/llm-synthesizer/providers.mjs',
  'sources/llm-synthesizer.mjs',
]

const ALL_FILES = [CONFIG_FILE, ...DIRECT_CONSUMERS, ...PLATFORM_CONSUMERS, ...OTHER_LLM_FILES]
const sources = new Map(ALL_FILES.map((name) => [name, readFileSync(join(scriptsDir, name), 'utf8')]))

describe('retired GitHub Models endpoint is gone', () => {
  for (const name of ALL_FILES) {
    it(`${name} does not reference models.github.ai`, () => {
      expect(sources.get(name)).not.toMatch(/models\.github\.ai/)
    })

    it(`${name} does not read legacy LLM_ENDPOINT / LLM_TOKEN env vars`, () => {
      expect(sources.get(name)).not.toMatch(/process\.env\.LLM_(?:ENDPOINT|TOKEN)\b/)
    })
  }
})

describe('single LLM proxy config module', () => {
  it(`${CONFIG_FILE} reads LLM_BASE_URL, LLM_API_KEY and LLM_MODEL`, () => {
    const src = sources.get(CONFIG_FILE)
    expect(src).toMatch(/env\.LLM_BASE_URL/)
    expect(src).toMatch(/env\.LLM_API_KEY/)
    expect(src).toMatch(/env\.LLM_MODEL/)
  })

  for (const name of ALL_FILES.filter((n) => n !== CONFIG_FILE)) {
    it(`${name} does not parse LLM_BASE_URL / LLM_API_KEY itself`, () => {
      expect(sources.get(name)).not.toMatch(/process\.env\.LLM_(?:BASE_URL|API_KEY)\b/)
    })
  }

  for (const name of DIRECT_CONSUMERS) {
    it(`${name} imports from lib/llm-proxy-config.mjs`, () => {
      expect(sources.get(name)).toMatch(
        /from\s*['"](?:\.\.?\/)+(?:lib\/)?llm-proxy-config\.mjs['"]/,
      )
    })
  }

  for (const name of PLATFORM_CONSUMERS) {
    it(`${name} imports its LLM config from lib/platform-llm-config.mjs (no reverse import)`, () => {
      const src = sources.get(name)
      expect(src).toMatch(/import\s*\{[^}]*\}\s*from\s*['"]\.\.?\/lib\/platform-llm-config\.mjs['"]/)
      expect(src).not.toMatch(/from\s*['"]\.\.\/generate-platform-missions\.mjs['"]/)
    })
  }
})

describe('lib/llm-endpoint-guard.mjs keeps only the fixed-host Anthropic gate', () => {
  const guard = sources.get('lib/llm-endpoint-guard.mjs')

  it('no longer declares the GitHub Models / OpenAI allowlists', () => {
    expect(guard).not.toMatch(/ALLOWED_ENDPOINT_PREFIXES\s*=/)
    expect(guard).not.toMatch(/GITHUB_MODELS_POLICY\s*=/)
  })

  it('ANTHROPIC_POLICY is pinned (no silent widening)', () => {
    const m = guard.match(/ANTHROPIC_POLICY\s*=\s*\[([^\]]*)\]/)
    expect(m).not.toBeNull()
    expect([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])).toEqual(['https://api.anthropic.com/'])
  })

  it('assertTrustedEndpoint still uses a prefix startsWith check and throws', () => {
    expect(guard).toMatch(/allowedPrefixes\.some\(\s*prefix\s*=>\s*endpoint\.startsWith\(\s*prefix\s*\)\s*\)/)
    expect(guard).toMatch(/throw\s+new\s+Error\(\s*`Untrusted\s+\$\{name\}/)
  })

  it('sources/llm-synthesizer/config.mjs gates ANTHROPIC_ENDPOINT at module load', () => {
    const src = sources.get('sources/llm-synthesizer/config.mjs')
    expect(src).toMatch(/assertTrustedEndpoint\s*\(\s*process\.env\.ANTHROPIC_ENDPOINT/)
    expect(src).not.toMatch(/function\s+assertTrustedEndpoint\s*\(/)
  })
})
