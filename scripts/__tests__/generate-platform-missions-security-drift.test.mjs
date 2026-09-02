import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Security / policy drift guards for scripts/generate-platform-missions.mjs.
 *
 * This module is brand-new (~9% executable coverage) and its security-critical
 * gates are all module-internal — not reachable from an exported entry point,
 * so a conventional black-box vitest run cannot lock them. This suite is the
 * source-parsing equivalent used elsewhere in the repo (see
 * generate-platform-missions-verdict-drift.test.mjs, ssrf-allowlist-drift.test.mjs,
 * assert-safe-path-drift.test.mjs, sanitize-infra-details-drift.test.mjs), and
 * catches the exact refactor mistakes that black-box tests could not:
 *
 *   1. `ALLOWED_ENDPOINT_PREFIXES` — the SSRF (CWE-441) allowlist for the LLM
 *      endpoint MUST contain exactly the three approved backends. Silently
 *      appending a fourth (or dropping one) would let an untrusted
 *      `LLM_ENDPOINT` env var be accepted at module load.
 *   2. `assertTrustedEndpoint` — is called at module load time on the resolved
 *      `LLM_ENDPOINT`. A refactor that lazily evaluates the check would let a
 *      malicious endpoint through until first use.
 *   3. `serializeSanitizedMissionForFile` — hard-caps serialized mission size
 *      at 1_000_000 bytes AND refuses any post-sanitize payload that contains
 *      `<script>` tags or `on*=` inline event handlers. This is the last
 *      line of defense before untrusted LLM output is written to a JSON
 *      file that is later shipped as tap content — losing either check
 *      re-opens stored-XSS-in-JSON.
 *   4. `applyQualityGate` — the mission quality gate must (a) require at
 *      least 3 steps, (b) require at least one install command per
 *      `INSTALL_CMD_RE`, (c) require at least one verify command per
 *      `VERIFY_CMD_RE`, (d) require a `resolution.summary`, and (e)
 *      run both `scanForSensitiveData` and `scanForMaliciousContent`.
 *      Any of those checks silently going missing would ship missions
 *      that leak secrets or contain malicious install commands.
 *
 * When any of these locks fails, it means someone edited the security
 * surface — the reviewer must decide whether the intent was to relax
 * the guard (in which case the corresponding assertion here needs an
 * updated expectation *in the same PR*) or whether the edit was
 * accidental (in which case the code needs restoring).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = join(__dirname, '../generate-platform-missions.mjs')
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

function functionBody(src, header) {
  const idx = src.indexOf(header)
  if (idx === -1) throw new Error(`function header not found: ${header}`)
  // Naive brace-match walk starting at first '{' after the header.
  const start = src.indexOf('{', idx)
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated function body for ${header}`)
}

describe('generate-platform-missions.mjs — SSRF endpoint allowlist', () => {
  it('ALLOWED_ENDPOINT_PREFIXES contains exactly the three approved backends', () => {
    const m = SOURCE.match(
      /const ALLOWED_ENDPOINT_PREFIXES\s*=\s*\[([\s\S]*?)\]/
    )
    expect(m, 'ALLOWED_ENDPOINT_PREFIXES declaration must exist').toBeTruthy()
    const prefixes = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    expect([...prefixes].sort()).toEqual([
      'https://api.githubcopilot.com/',
      'https://api.openai.com/',
      'https://models.inference.ai.azure.com/',
    ])
  })

  it('every allowed prefix uses https and ends with a trailing slash', () => {
    // Prevents "prefix minus trailing slash" bypass:
    //   allowed:  https://api.openai.com
    //   attacker: https://api.openai.com.evil.example/
    // startsWith would accept the attacker URL without the "/".
    const m = SOURCE.match(
      /const ALLOWED_ENDPOINT_PREFIXES\s*=\s*\[([\s\S]*?)\]/
    )
    const prefixes = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    for (const p of prefixes) {
      expect(p.startsWith('https://'), `prefix must be https: ${p}`).toBe(true)
      expect(p.endsWith('/'), `prefix must end with '/': ${p}`).toBe(true)
    }
  })

  it('assertTrustedEndpoint is called at module load time on LLM_ENDPOINT', () => {
    // A refactor that defers this to first-use would let an untrusted
    // endpoint sit in a module-scope constant until a request goes out.
    expect(
      /const\s+TRUSTED_LLM_ENDPOINT\s*=\s*assertTrustedEndpoint\s*\(\s*LLM_ENDPOINT\s*\)/.test(
        SOURCE
      ),
      'assertTrustedEndpoint(LLM_ENDPOINT) must run at module load'
    ).toBe(true)
  })

  it('assertTrustedEndpoint throws (not warns) on a non-allowlisted endpoint', () => {
    const body = functionBody(SOURCE, 'function assertTrustedEndpoint')
    // The failure mode of this gate MUST be a thrown Error — silently
    // downgrading to console.warn / console.error would let an
    // untrusted URL through at module load.
    expect(/throw\s+new\s+Error/.test(body)).toBe(true)
  })
})

describe('generate-platform-missions.mjs — serializeSanitizedMissionForFile guards', () => {
  const body = functionBody(SOURCE, 'function serializeSanitizedMissionForFile')

  it('enforces a 1_000_000-byte hard cap on serialized JSON', () => {
    // Guards against a runaway LLM emitting an oversized payload that
    // could balloon repo size or wedge downstream consumers.
    expect(body).toContain('1_000_000')
    expect(/missionJson\.length\s*>\s*1_000_000/.test(body)).toBe(true)
    expect(/throw\s+new\s+Error/.test(body)).toBe(true)
  })

  it('rejects payloads containing <script> tags after sanitization', () => {
    // Stored-XSS-in-JSON: even after upstream sanitizers, the last
    // line of defense before write must reject any <script sequence.
    expect(/\/<\\s\*\s*script\\b\/i/.test(body)).toBe(true)
  })

  it('rejects payloads containing inline on*= event handlers', () => {
    // The companion "onload=", "onclick=", "onerror=" guard.
    expect(/\/\\bon\\w\+\\s\*=\/i/.test(body)).toBe(true)
  })
})

describe('generate-platform-missions.mjs — applyQualityGate policy locks', () => {
  const body = functionBody(SOURCE, 'function applyQualityGate')

  it('requires at least 3 mission steps', () => {
    // A 1-step "install" mission is almost always LLM garbage. The
    // MIN_STEPS === 3 policy is the cheapest signal that the LLM
    // actually produced a real procedure.
    expect(/steps\.length\s*<\s*3/.test(body)).toBe(true)
  })

  it('requires at least one install command per INSTALL_CMD_RE', () => {
    expect(body).toContain('INSTALL_CMD_RE')
    expect(body).toContain('No install command found')
  })

  it('requires at least one verify command per VERIFY_CMD_RE', () => {
    expect(body).toContain('VERIFY_CMD_RE')
    expect(body).toContain('No verification step found')
  })

  it('requires a resolution.summary field', () => {
    expect(/mission\.mission\?\.resolution\?\.summary/.test(body)).toBe(true)
    expect(body).toContain('No resolution summary')
  })

  it('runs BOTH scanForSensitiveData and scanForMaliciousContent', () => {
    // A refactor that keeps only one scan silently ships either
    // secrets-in-JSON or an unvetted install command.
    expect(body).toContain('scanForSensitiveData')
    expect(body).toContain('scanForMaliciousContent')
  })

  it('sensitive-data findings block the mission (added to issues)', () => {
    expect(/issues\.push\([^)]*Sensitive data detected/.test(body)).toBe(true)
  })

  it('malicious-content findings block the mission (added to issues)', () => {
    expect(/issues\.push\([^)]*Malicious content detected/.test(body)).toBe(
      true
    )
  })

  it('INSTALL_CMD_RE covers helm / kubectl / docker / operator-sdk / kustomize', () => {
    // Locks the "any install cmd" heuristic; dropping any of these
    // families would misclassify legitimate missions as "no install
    // command found" and reject them.
    const m = SOURCE.match(/const INSTALL_CMD_RE\s*=\s*\/([^/]+)\/i/)
    expect(m, 'INSTALL_CMD_RE must exist').toBeTruthy()
    const pattern = m[1]
    for (const kw of [
      'helm install',
      'helm upgrade',
      'kubectl apply',
      'kubectl create',
      'docker run',
      'operator-sdk',
      'kustomize',
    ]) {
      expect(pattern).toContain(kw)
    }
  })

  it('VERIFY_CMD_RE covers kubectl get / describe / logs / rollout / curl health', () => {
    const m = SOURCE.match(/const VERIFY_CMD_RE\s*=\s*\/([^/]+)\/i/)
    expect(m, 'VERIFY_CMD_RE must exist').toBeTruthy()
    const pattern = m[1]
    for (const kw of [
      'kubectl get',
      'kubectl describe',
      'kubectl logs',
      'kubectl rollout status',
      'curl',
    ]) {
      expect(pattern).toContain(kw)
    }
  })
})
