/**
 * Source-drift invariants for `isMissionStale(filePath, opts)` in
 * `scripts/lib/mission-file.mjs`.
 *
 * Extracted from `generate-cncf-install-missions.mjs` and
 * `generate-platform-missions.mjs` (kubestellar/console-kb#3802), which
 * each carried a byte-identical copy of this function (differing only in
 * the staleness threshold). This suite moves the fail-safe-polarity
 * invariants previously pinned in
 * `generate-platform-missions-report-and-staleness-drift.test.mjs` to
 * follow the implementation to its new home. Three branches must all
 * survive refactors:
 *   (a) `forceRegenerate` short-circuits to `true`
 *   (b) missing or invalid `metadata.generatedAt` treats the mission as
 *       stale (fail-safe: regenerate)
 *   (c) an unreadable / non-JSON file returns `true`
 * Any regression that flips the fail-safe polarity to `false` would let
 * corrupt / unreadable missions be treated as fresh and never
 * regenerated, for BOTH callers of this shared helper.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'mission-file.mjs'), 'utf8')

function functionBody(src, header) {
  const start = src.indexOf(header)
  expect(start, `expected to find "${header}" in source`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}\n', start)
  expect(end, `expected "${header}" to have a top-level closing brace`).toBeGreaterThan(start)
  return src.slice(start, end + 2)
}

describe('isMissionStale source drift', () => {
  const body = functionBody(
    SOURCE,
    "export function isMissionStale(filePath, { forceRegenerate = false, thresholdDays = 14 } = {})",
  )

  it('short-circuits to true when forceRegenerate is set', () => {
    // This must be the FIRST guard — swapping order would parse the
    // file on every call even in a forced-regeneration run.
    expect(body).toMatch(/^\s*if\s*\(forceRegenerate\)\s*return\s*true/m)
    const forceIdx = body.indexOf('forceRegenerate')
    const readIdx = body.indexOf('readFileSync')
    expect(forceIdx).toBeGreaterThan(0)
    expect(readIdx).toBeGreaterThan(forceIdx)
  })

  it('reads and JSON-parses the mission file', () => {
    expect(body).toContain('readFileSync(filePath')
    expect(body).toContain('JSON.parse')
  })

  it('treats a missing metadata.generatedAt as stale (fail-safe)', () => {
    expect(body).toContain('metadata?.generatedAt')
    expect(body).toMatch(/if\s*\(!generatedAt\)\s*return\s*true/)
  })

  it('compares age in days against the thresholdDays parameter', () => {
    expect(body).toContain('thresholdDays')
    // Age computation must be in days: divide by 1000 * 60 * 60 * 24.
    expect(body).toMatch(/1000\s*\*\s*60\s*\*\s*60\s*\*\s*24/)
  })

  it('catches read/parse failures and returns true (fail-safe polarity)', () => {
    // The catch block MUST return true — flipping to false would
    // treat a corrupt / unreadable mission as fresh forever.
    expect(body).toMatch(/catch\s*\{[\s\S]*?return\s+true[\s\S]*?\}/)
    const catchMatch = body.match(/catch\s*\{([\s\S]*?)\}/)
    expect(catchMatch, 'isMissionStale must have a catch block').not.toBeNull()
    expect(catchMatch[1]).not.toMatch(/return\s+false/)
  })

  it('defaults thresholdDays to 14 for callers that pass no options', () => {
    expect(SOURCE).toMatch(/thresholdDays\s*=\s*14/)
  })
})
