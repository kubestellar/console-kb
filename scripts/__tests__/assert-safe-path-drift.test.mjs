/**
 * Source-drift invariant for `assertSafePath`, the path-traversal guard
 * that appears verbatim in three mission-generator scripts:
 *
 *   scripts/generate-platform-missions.mjs      (exported, tested)
 *   scripts/generate-cncf-install-missions.mjs  (exported, not directly tested)
 *   scripts/enrich-install-missions.mjs         (module-local, not testable)
 *
 * The three copies MUST stay behaviourally identical. If a future security
 * hardening (symlink check, boundary-comparison tightening, etc.) is applied
 * to only one copy, the other two silently retain the old behaviour — a
 * classic drift regression on a security-critical guard that governs
 * write-to-disk paths for generated missions.
 *
 * This test uses the same static-analysis approach as the sibling drift
 * checks (`sanitize-infra-details-drift.test.mjs`,
 * `ssrf-allowlist-drift.test.mjs`,
 * `generate-platform-missions-verdict-drift.test.mjs`).
 *
 * Follow-up (out of scope here): consolidate the guard into `scripts/lib/`
 * so there is one implementation. When that lands, delete this drift test.
 *
 * See: kubestellar/console-kb#3100
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  assertSafePath as assertSafePathPlatform,
} from '../generate-platform-missions.mjs'
import {
  assertSafePath as assertSafePathCncf,
} from '../generate-cncf-install-missions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = join(HERE, '..')

const COPIES = [
  {
    file: 'generate-platform-missions.mjs',
    expectedExport: true,
  },
  {
    file: 'generate-cncf-install-missions.mjs',
    expectedExport: true,
  },
  {
    file: 'enrich-install-missions.mjs',
    expectedExport: false,
  },
]

// Extract the function body (from the opening `{` after the signature to
// the matching closing `}`). Kept intentionally strict: any drift on the
// body — including whitespace and the exact error message — fails the test.
function extractAssertSafePath(source) {
  const re =
    /(?:export\s+)?function\s+assertSafePath\s*\(\s*resolvedTarget\s*,\s*resolvedAllowedDir\s*\)\s*\{([\s\S]*?)^\}/m
  const m = source.match(re)
  if (!m) return null
  return { header: m[0].split('{')[0].trim(), body: m[1].trim() }
}

describe('assertSafePath drift', () => {
  it('appears exactly once in each of the three known scripts', () => {
    for (const { file } of COPIES) {
      const source = readFileSync(join(SCRIPTS_DIR, file), 'utf8')
      const matches = source.match(
        /function\s+assertSafePath\s*\(/g,
      )
      expect(matches, `${file}`).not.toBeNull()
      expect(matches.length, `${file} should declare assertSafePath exactly once`).toBe(1)
    }
  })

  it('all three copies share the same function body', () => {
    const bodies = COPIES.map(({ file }) => {
      const source = readFileSync(join(SCRIPTS_DIR, file), 'utf8')
      const parsed = extractAssertSafePath(source)
      expect(parsed, `${file} must contain an assertSafePath declaration`).not.toBeNull()
      return { file, body: parsed.body }
    })

    const reference = bodies[0].body
    for (const { file, body } of bodies.slice(1)) {
      expect(
        body,
        `${file} assertSafePath body has drifted from ${bodies[0].file}. ` +
          `Update every copy in lockstep or consolidate into scripts/lib/.`,
      ).toBe(reference)
    }
  })

  it('export vs. module-local status matches the documented inventory', () => {
    for (const { file, expectedExport } of COPIES) {
      const source = readFileSync(join(SCRIPTS_DIR, file), 'utf8')
      const hasExport =
        /^\s*export\s+function\s+assertSafePath\b/m.test(source)
      expect(
        hasExport,
        expectedExport
          ? `${file} is expected to export assertSafePath (change the inventory ` +
              `above and update tests if you intentionally made it module-local)`
          : `${file} is expected to keep assertSafePath module-local (or, better, ` +
              `import it from scripts/lib/ — see #3100)`,
      ).toBe(expectedExport)
    }
  })

  it('rejects a path that only shares a prefix with the allowed dir', () => {
    // e.g. resolvedTarget "/tmp/allowed-evil/x" vs allowedDir "/tmp/allowed"
    // must throw — the `+ '/'` boundary check is the critical part of the guard.
    for (const guard of [assertSafePathPlatform, assertSafePathCncf]) {
      expect(() => guard('/tmp/allowed-evil/x', '/tmp/allowed')).toThrow(
        /Path traversal detected/,
      )
    }
  })

  it('rejects a path escaping via `..`', () => {
    for (const guard of [assertSafePathPlatform, assertSafePathCncf]) {
      // Callers pre-resolve paths, so a `..`-containing target would already
      // have been normalised. Emulate the post-resolve form.
      expect(() => guard('/tmp/other/etc/passwd', '/tmp/allowed')).toThrow(
        /Path traversal detected/,
      )
    }
  })

  it('accepts the allowed dir itself and any path strictly inside it', () => {
    for (const guard of [assertSafePathPlatform, assertSafePathCncf]) {
      expect(() => guard('/tmp/allowed', '/tmp/allowed')).not.toThrow()
      expect(() => guard('/tmp/allowed/child.json', '/tmp/allowed')).not.toThrow()
      expect(() =>
        guard('/tmp/allowed/sub/dir/child.json', '/tmp/allowed'),
      ).not.toThrow()
    }
  })

  it('embeds both the target and the allowed dir in the error message (diagnostic contract)', () => {
    for (const guard of [assertSafePathPlatform, assertSafePathCncf]) {
      try {
        guard('/tmp/other/x', '/tmp/allowed')
        throw new Error('expected guard to throw')
      } catch (err) {
        expect(err.message).toContain('/tmp/other/x')
        expect(err.message).toContain('/tmp/allowed')
      }
    }
  })
})
