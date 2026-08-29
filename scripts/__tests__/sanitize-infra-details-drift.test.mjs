/**
 * Regression guard for the unified anti-PII `sanitizeInfraDetails()` sanitizer.
 *
 * `generate-platform-missions.mjs` previously defined its own local copy of
 * `sanitizeInfraDetails` that drifted from `lib/text-utils.mjs`, leaking AWS
 * EC2 public hostnames and GCP compute-internal DNS names into LLM traffic and
 * persisted mission JSON. That drift was closed in kubestellar/console-kb#3065:
 *
 *   - `lib/text-utils.mjs::sanitizeInfraDetails` now covers all six PII
 *     pattern classes (public IPv4, AWS internal/public hostnames, GCP
 *     compute-internal, GKE node names, 12-digit account IDs).
 *   - `generate-platform-missions.mjs` imports from `lib/text-utils.mjs`
 *     instead of duplicating the function.
 *
 * These tests lock both invariants so neither can silently regress.
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
 * source text. Returns null if not found.
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

// All six PII pattern classes the shared sanitizer must cover
const ALL_PATTERNS = [
  {
    label: 'public IPv4 (RFC 1918 negative-lookahead)',
    probe: '(?!10\\.|172\\.',
  },
  {
    label: 'AWS EC2 internal hostname (ip-N-N-N-N.*.compute.internal)',
    probe: '\\bip-\\d+-\\d+-\\d+-\\d+',
  },
  {
    label: 'AWS EC2 public hostname (ec2-N-N-N-N.*.compute.amazonaws.com)',
    probe: 'ec2-\\d+-\\d+-\\d+-\\d+',
  },
  {
    label: 'GCP compute internal (*.<region>-<zone>.c.<project>.internal)',
    probe: '\\.c\\.',
  },
  {
    label: 'GKE node names (gke-…-…-…)',
    probe: 'gke-[a-z0-9-]+',
  },
  {
    label: 'cloud account IDs (bare 12-digit)',
    probe: '\\b\\d{12}\\b',
  },
]

describe('sanitizeInfraDetails unified coverage (post #3065)', () => {
  describe('shared sanitizer covers all six PII pattern classes', () => {
    for (const { label, probe } of ALL_PATTERNS) {
      it(`covers: ${label}`, () => {
        const src = readFileSync(join(scriptsDir, SHARED_SANITIZER_FILE), 'utf8')
        const body = extractFunctionBody(src, 'sanitizeInfraDetails')
        expect(body, `sanitizeInfraDetails not found in ${SHARED_SANITIZER_FILE}`).not.toBeNull()
        expect(body).toContain(probe)
      })
    }
  })

  it('generate-platform-missions.mjs imports sanitizeInfraDetails from lib/text-utils.mjs (no local duplicate)', () => {
    const src = readFileSync(join(scriptsDir, LOCAL_SANITIZER_FILE), 'utf8')
    // Must import from the shared module
    expect(src).toMatch(/import\s*\{[^}]*sanitizeInfraDetails[^}]*\}\s*from\s*['"]\.\/lib\/text-utils\.mjs['"]/)
    // Must NOT define its own local copy
    const localBody = extractFunctionBody(src, 'sanitizeInfraDetails')
    expect(localBody).toBeNull()
  })
})

