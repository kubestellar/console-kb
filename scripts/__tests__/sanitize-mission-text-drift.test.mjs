import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Policy / shape drift guard for scripts/lib/mission-sanitizer.mjs.
 *
 * The install and platform generators used to inline their own recursive
 * mission-tree walker plus a per-string sanitization policy inside their
 * respective `main()` functions. kubestellar/console-kb#3641 extracted both
 * walkers (byte-identical) and both policies to the shared lib so they live
 * at one declaration site. This suite is the source-parsing equivalent used
 * elsewhere in the repo (see generate-platform-missions-security-drift.test.mjs,
 * sanitize-infra-details-drift.test.mjs, ssrf-allowlist-drift.test.mjs,
 * assert-safe-path-drift.test.mjs) and locks the five things that MUST stay
 * stable for the extracted sanitizer to keep its security guarantees:
 *
 *   1. `walkMissionTree` recurses into exactly the three JS kinds that
 *      appear in a mission JSON tree — string (leaf), array, plain object —
 *      and returns everything else unchanged.
 *   2. `sanitizeStripHtml` runs ALL FOUR of its multi-char strippers through
 *      `replaceUntilStable`, not a single `.replace` (CWE-80/116).
 *   3. The `<script>…</script>` regex matches the loose closing form
 *      `</\s*script[^>]*>` so variants like `</script\t\n foo>` are
 *      stripped (js/bad-tag-filter).
 *   4. `sanitizeEncodeAndRedactInfra` composes `sanitizeInfraDetails` →
 *      `&`-encode → `<`-encode → `>`-encode → control-char strip →
 *      `.slice(0, maxLen)` IN THAT ORDER (CWE-79/434, fixes #2896).
 *   5. The default `maxLen` is 5000 — the historical cap at the single
 *      platform-generator callsite.
 *
 * When any of these locks fails, it means someone edited the sanitizer
 * surface — the reviewer must decide whether the intent was to relax the
 * guard (in which case the corresponding assertion here needs an updated
 * expectation *in the same PR*) or whether the edit was accidental (in
 * which case the code needs restoring).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = join(__dirname, '../lib/mission-sanitizer.mjs')
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

function functionBody(src, header) {
  const idx = src.indexOf(header)
  if (idx === -1) throw new Error(`function header not found: ${header}`)
  // Walk to the closing `)` of the signature, then find the `{` that opens
  // the body (not any `{` inside destructuring/default values).
  let i = idx + header.length
  let parens = 1 // header starts with '(' already consumed in substring assumption; walk from after header
  // Rewind one char: header ends mid-signature, so count parens from idx.
  i = src.indexOf('(', idx)
  if (i === -1) throw new Error(`opening paren not found for ${header}`)
  parens = 0
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') parens++
    else if (ch === ')') {
      parens--
      if (parens === 0) { i++; break }
    }
  }
  const openIdx = src.indexOf('{', i)
  if (openIdx === -1) throw new Error(`opening brace not found for ${header}`)
  let depth = 0
  for (let j = openIdx; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx, j + 1)
    }
  }
  throw new Error(`closing brace not found for ${header}`)
}

describe('mission-sanitizer: walkMissionTree shape', () => {
  const body = functionBody(SOURCE, 'export function walkMissionTree(obj, perString)')

  it('recurses into string leaves', () => {
    expect(body).toMatch(/typeof obj === 'string'/)
    expect(body).toMatch(/return perString\(obj\)/)
  })

  it('recurses into arrays via .map', () => {
    expect(body).toMatch(/Array\.isArray\(obj\)/)
    expect(body).toMatch(/obj\.map\(item => walkMissionTree\(item, perString\)\)/)
  })

  it('recurses into plain objects via Object.entries', () => {
    expect(body).toMatch(/Object\.entries\(obj\)/)
    expect(body).toMatch(/walkMissionTree\(v, perString\)/)
  })

  it('returns non-string/array/object inputs unchanged', () => {
    expect(body).toMatch(/\n\s*return obj\n\s*\}\s*$/)
  })
})

describe('mission-sanitizer: sanitizeStripHtml policy', () => {
  const body = functionBody(SOURCE, 'export function sanitizeStripHtml(input)')

  it('decodes the six core HTML entities before stripping', () => {
    for (const re of [/&lt;/, /&gt;/, /&quot;/, /&#x27;/, /&#x2F;/, /&amp;/]) {
      expect(body).toMatch(re)
    }
  })

  it('runs each multi-character stripper through replaceUntilStable', () => {
    const calls = body.match(/replaceUntilStable\(sanitized,/g) || []
    expect(calls.length).toBe(4)
  })

  it('matches the loose </script> closing form (js/bad-tag-filter)', () => {
    expect(body).toMatch(/<script\[\\s\\S\]\*\?<\\\/\\s\*script\[\^>\]\*>/)
  })

  it('strips inline on*= handlers with control-char-tolerant separators', () => {
    expect(body).toMatch(/\\bon\\w\+/)
    expect(body).toMatch(/\\u0000-\\u001F\\u007F/)
  })

  it('strips javascript: URL schemes with control-char-tolerant separators', () => {
    expect(body).toMatch(/javascript\[\\s\\u0000-\\u001F\\u007F\]\*:/)
  })

  it('ends with a residual-tag sweep', () => {
    expect(body).toMatch(/<\[\^>\]\+>/)
  })
})

describe('mission-sanitizer: sanitizeEncodeAndRedactInfra policy', () => {
  const body = functionBody(SOURCE, 'export function sanitizeEncodeAndRedactInfra(input,')

  it('composes infra-redaction → &-encode → <-encode → >-encode → control-strip → slice IN ORDER', () => {
    const order = [
      body.indexOf('sanitizeInfraDetails(input)'),
      body.indexOf(".replace(/&/g, '&amp;')"),
      body.indexOf(".replace(/</g, '&lt;')"),
      body.indexOf(".replace(/>/g, '&gt;')"),
      body.indexOf('.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, \'\')'),
      body.indexOf('.slice(0, maxLen)'),
    ]
    for (const i of order) expect(i).toBeGreaterThan(-1)
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1])
    }
  })

  it('defaults maxLen to 5000', () => {
    // Signature line lives outside functionBody; grep the source directly.
    expect(SOURCE).toMatch(/sanitizeEncodeAndRedactInfra\(input, \{ maxLen = 5000 \} = \{\}\)/)
  })
})

describe('mission-sanitizer: convenience wrappers', () => {
  it('sanitizeInstallMission composes walkMissionTree + sanitizeStripHtml', () => {
    const body = functionBody(SOURCE, 'export function sanitizeInstallMission(missionBody)')
    expect(body).toMatch(/walkMissionTree\(missionBody, sanitizeStripHtml\)/)
  })

  it('sanitizePlatformMission composes walkMissionTree + sanitizeEncodeAndRedactInfra with maxLen', () => {
    const body = functionBody(SOURCE, 'export function sanitizePlatformMission(missionBody,')
    expect(body).toMatch(/walkMissionTree\(missionBody, s => sanitizeEncodeAndRedactInfra\(s, \{ maxLen \}\)\)/)
  })

  it('sanitizePlatformMission defaults maxLen to 5000 at the wrapper level too', () => {
    expect(SOURCE).toMatch(/sanitizePlatformMission\(missionBody, \{ maxLen = 5000 \} = \{\}\)/)
  })
})

describe('mission-sanitizer: behavioural smoke', () => {
  it('round-trips a benign mission tree through sanitizeInstallMission', async () => {
    const { sanitizeInstallMission } = await import('../lib/mission-sanitizer.mjs')
    const input = { title: 'Install foo', steps: [{ description: 'Run kubectl apply' }] }
    expect(sanitizeInstallMission(input)).toEqual(input)
  })

  it('strips <script> payloads from install missions', async () => {
    const { sanitizeInstallMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizeInstallMission({ x: 'hi<script>evil()</script>bye' })
    expect(out.x).toBe('hibye')
  })

  it('strips entity-encoded <script> payloads from install missions', async () => {
    const { sanitizeInstallMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizeInstallMission({ x: 'a&lt;script&gt;evil()&lt;/script&gt;b' })
    expect(out.x).toBe('ab')
  })

  it('strips inline on*= handlers from install missions', async () => {
    const { sanitizeInstallMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizeInstallMission({ x: '<a href="x" onclick="pwn()">y</a>' })
    expect(out.x).not.toMatch(/onclick/i)
  })

  it('strips javascript: URL schemes from install missions', async () => {
    const { sanitizeInstallMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizeInstallMission({ x: 'link javascript:alert(1)' })
    expect(out.x).not.toMatch(/javascript:/i)
  })

  it('HTML-encodes angle brackets in platform missions', async () => {
    const { sanitizePlatformMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizePlatformMission({ x: 'a<b>c' })
    expect(out.x).toBe('a&lt;b&gt;c')
  })

  it('caps platform mission strings at maxLen', async () => {
    const { sanitizePlatformMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizePlatformMission({ x: 'a'.repeat(20_000) }, { maxLen: 10 })
    expect(out.x.length).toBe(10)
  })

  it('strips C0 control chars from platform missions', async () => {
    const { sanitizePlatformMission } = await import('../lib/mission-sanitizer.mjs')
    const out = sanitizePlatformMission({ x: 'a\x01b\x7Fc' })
    expect(out.x).toBe('abc')
  })
})
