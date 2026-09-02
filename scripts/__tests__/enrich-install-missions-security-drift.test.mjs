// eslint-disable-next-line no-restricted-imports
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  ALLOWED_ENDPOINT_PREFIXES,
  assertTrustedEndpoint,
} from '../enrich-install-missions.mjs'

// This module locks security-critical gates in enrich-install-missions.mjs
// that live in module-internal functions (assertSafePath) or as
// inline literal constants (filename regex, clamp bounds, LLM
// timeout, redaction patterns). None of those are individually
// export-testable via runtime, but a silent loosening of ANY of them
// enables a distinct class of exploit:
//
//   * The install filename regex is the entry-point allowlist; a
//     drift that admits '../' or upper-case would defeat the
//     assertSafePath check.
//   * The sanitizeMissionForHTTP clamps bound prompt injection size
//     and step count sent to the LLM; a drift removing them opens
//     the door to prompt-injection amplification and outbound
//     bandwidth abuse.
//   * The assertSafePath comparison uses a trailing '/' — dropping
//     it turns '/opt/fixes/cncf-installEVIL/x.json' into a false
//     positive for the '/opt/fixes/cncf-install' prefix.
//   * The redactFileText regexes must strip URL / email / secret
//     tokens; a hole in any of the three leaks contributor content
//     to the LLM API.
//
// Source-parsing drift-guards catch the silent regression at PR
// review time. The alternative (waiting for a scanner to notice
// months later) has real cost.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'enrich-install-missions.mjs'), 'utf-8')

describe('enrich-install-missions security-drift guards', () => {
  describe('ALLOWED_ENDPOINT_PREFIXES', () => {
    it('lists exactly the three approved LLM backends and no more', () => {
      // A silently-added fourth prefix is the exact SSRF pathway
      // this allowlist exists to block. Locking the count + set
      // makes any expansion a review-visible source change.
      expect(ALLOWED_ENDPOINT_PREFIXES).toEqual([
        'https://models.inference.ai.azure.com/',
        'https://api.openai.com/',
        'https://api.githubcopilot.com/',
      ])
    })

    it('every prefix ends with a trailing slash (no substring shadowing)', () => {
      // Without the trailing '/', a prefix like
      // 'https://api.openai.com' would match a hostile
      // 'https://api.openai.com.attacker.example/'.
      for (const p of ALLOWED_ENDPOINT_PREFIXES) {
        expect(p.endsWith('/'), `prefix ${p} lacks trailing slash`).toBe(true)
        expect(p.startsWith('https://'), `prefix ${p} not https`).toBe(true)
      }
    })

    it('assertTrustedEndpoint rejects http:// even on an allowed host', () => {
      expect(() =>
        assertTrustedEndpoint('http://models.inference.ai.azure.com/chat'),
      ).toThrow(/Untrusted LLM_ENDPOINT/)
    })

    it('assertTrustedEndpoint rejects a lookalike suffix host', () => {
      expect(() =>
        assertTrustedEndpoint('https://api.openai.com.attacker.example/x'),
      ).toThrow(/Untrusted LLM_ENDPOINT/)
    })

    it('assertTrustedEndpoint accepts each approved prefix + a path', () => {
      for (const p of ALLOWED_ENDPOINT_PREFIXES) {
        expect(assertTrustedEndpoint(p + 'chat/completions')).toBe(
          p + 'chat/completions',
        )
      }
    })
  })

  describe('install filename allowlist regex (module-internal gate)', () => {
    it('source parses to /^install-[a-z0-9-]+\\.json$/ verbatim', () => {
      // This is the ONLY filename shape allowed into enrichFile.
      // A drift that (a) drops the ^ anchor, (b) drops the \\.json
      // literal escape, (c) admits uppercase, or (d) admits '.' or
      // '/' silently opens the door to a path-traversal payload
      // reaching writeFileSync.
      expect(SRC).toContain(
        "if (!/^install-[a-z0-9-]+\\.json$/.test(safeBasename)) {",
      )
    })

    it('validates basename() is applied BEFORE the regex check', () => {
      // enrichFile threads the fileName through basename() before
      // regex-checking. If the basename call is ever removed, an
      // attacker-controlled TARGET_PROJECTS entry containing '/'
      // could sidestep the allowlist even though the regex forbids
      // '/' — because a raw path never reaches the regex.
      const enrichFileBody = SRC.slice(SRC.indexOf('async function enrichFile'))
      expect(enrichFileBody).toMatch(/const\s+safeBasename\s*=\s*basename\(fileName\)/)
      const basenameIdx = enrichFileBody.indexOf('basename(fileName)')
      const regexIdx = enrichFileBody.indexOf('/^install-')
      expect(basenameIdx).toBeGreaterThan(-1)
      expect(regexIdx).toBeGreaterThan(basenameIdx)
    })
  })

  describe('assertSafePath (module-internal gate)', () => {
    it('requires trailing "/" in the prefix comparison OR exact equality', () => {
      // Without the '/', '/opt/fixes/cncf-installEVIL/x' would pass
      // the startsWith check against '/opt/fixes/cncf-install'.
      // The verbatim source is what a code review can inspect; lock it.
      expect(SRC).toContain(
        "if (!resolvedTarget.startsWith(resolvedAllowedDir + '/') && resolvedTarget !== resolvedAllowedDir) {",
      )
    })

    it('throws with the exact "Path traversal detected" phrasing', () => {
      // Ops runbooks and log-scraping alerts key off this string.
      expect(SRC).toContain('throw new Error(`Path traversal detected:')
    })

    it('is called on both filePath and SOLUTIONS_DIR resolved paths', () => {
      // A refactor that drops the resolve() step before
      // assertSafePath would let a symlink chain sidestep the
      // check.
      const enrichFileBody = SRC.slice(SRC.indexOf('async function enrichFile'))
      expect(enrichFileBody).toMatch(/resolvedSolutionsDir\s*=\s*resolve\(SOLUTIONS_DIR\)/)
      expect(enrichFileBody).toMatch(/resolvedFilePath\s*=\s*resolve\(filePath\)/)
      expect(enrichFileBody).toMatch(
        /assertSafePath\(resolvedFilePath,\s*resolvedSolutionsDir\)/,
      )
    })
  })

  describe('sanitizeMissionForHTTP clamp bounds', () => {
    it('clamps steps[] to 20 elements (prompt-injection amplification bound)', () => {
      expect(SRC).toContain('.slice(0, 20).map(s => ({')
    })

    it('clamps step title to 200 chars and description to 2000 chars', () => {
      expect(SRC).toContain('title: clampStr(s.title, 200),')
      expect(SRC).toContain('description: clampStr(s.description, 2000),')
    })

    it('clamps mission.title to 200 chars and mission.description to 500 chars', () => {
      expect(SRC).toContain('title: clampStr(mission.mission?.title, 200),')
      expect(SRC).toContain('description: clampStr(mission.mission?.description, 500),')
    })

    it('clamps installMethods and cncfProjects to 10 each', () => {
      // .slice(0, 10) appears once per array. If either drifts
      // (e.g. to 100), an attacker-controlled JSON can inflate the
      // prompt.
      const sliceTen = SRC.match(/\.slice\(0,\s*10\)/g) || []
      expect(sliceTen.length).toBeGreaterThanOrEqual(2)
    })

    it('installMethods/cncfProjects regexes are kebab-case bounded', () => {
      // The bound length + charset restrict tags to safe kebab-case
      // identifiers; a drift admitting '/' or spaces reintroduces
      // prompt injection.
      expect(SRC).toContain('/^[a-z][a-z0-9-]{0,30}$/')  // installMethods
      expect(SRC).toContain('/^[a-z][a-z0-9-]{0,60}$/')  // cncfProjects
    })
  })

  describe('redactFileText patterns', () => {
    it('redacts http(s):// and git@ URLs', () => {
      expect(SRC).toContain(
        `.replace(/\\b(?:https?:\\/\\/|git@)[^\\s\`"'<>]+/gi, '[redacted-url]')`,
      )
    })

    it('redacts email addresses', () => {
      expect(SRC).toContain(
        `.replace(/\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z]{2,}\\b/gi, '[redacted-email]')`,
      )
    })

    it('redacts token/password/secret/api_key assignments', () => {
      expect(SRC).toContain(
        `.replace(/\\b(?:token|password|secret|api[_-]?key)\\s*[:=]\\s*[^\\s\`"']+/gi, '[redacted-secret]')`,
      )
    })
  })

  describe('LLM_TIMEOUT_MS bound', () => {
    it('is exactly 60_000 (60 seconds) — a drift lets a slow endpoint stall the worker', () => {
      expect(SRC).toContain('const LLM_TIMEOUT_MS = 60_000')
    })
  })
})
