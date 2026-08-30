/**
 * Documentation-drift invariants for docs/fixer-schema.yaml.
 *
 * docs/fixer-schema.yaml is the user-facing reference every contributor
 * copy-pastes when hand-authoring a new fix. It documents the
 * kc-mission-v1 envelope: which top-level fields are required, what a
 * mission block looks like, what optional sections are allowed. When
 * this file drifts from the code that actually enforces the schema
 * (validateMissionExport in scripts/scanner.mjs), contributors follow
 * the doc, produce a file that looks correct to a human, and only find
 * out at scan time that CI rejects it — or worse, the file passes scan
 * because the doc quietly excluded a field the scanner actually
 * requires.
 *
 * There is no test in this repo that ties the doc to the code:
 *   * scripts/__tests__/validate-schema.test.mjs covers validateMissionExport
 *     with synthetic inputs but never reads the reference document.
 *   * scripts/__tests__/hand-authored-fix-catalog-invariants.test.mjs
 *     covers shipped fixes/**\/*.json entries but not the docs example.
 *   * scripts/__tests__/runbook-catalog-invariants.test.mjs covers runbooks/
 *     but not the docs example.
 *
 * This suite closes that loop end-to-end:
 *
 *   1. The YAML body of docs/fixer-schema.yaml (below the human-facing
 *      comment header) parses cleanly as YAML.
 *   2. Every field REQUIRED_FIELDS forces validateMissionExport to require
 *      is present in the doc example.
 *   3. Feeding the parsed example to validateMissionExport returns
 *      { valid: true }.
 *   4. The doc lists a version string that VALID_VERSIONS accepts.
 *   5. Optional sections named in the doc (metadata, prerequisites,
 *      security) are shapes the scanner won't reject.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

import { validateMissionExport } from '../scanner.mjs'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')
const SCHEMA_DOC = path.join(REPO_ROOT, 'docs', 'fixer-schema.yaml')

// Fields the code enforces. Kept in sync with scripts/scanner.mjs's
// REQUIRED_FIELDS / VALID_VERSIONS constants. If the code adds a new
// required field, this list must be updated too — that's the whole point
// of the drift guard.
const CODE_REQUIRED_FIELDS = ['version', 'name', 'mission']
const CODE_VALID_VERSIONS = ['kc-mission-v1']

describe('docs/fixer-schema.yaml (contributor reference)', () => {
  const raw = fs.readFileSync(SCHEMA_DOC, 'utf-8')

  it('exists and is non-empty', () => {
    expect(raw.length).toBeGreaterThan(0)
  })

  const parsed = yaml.load(raw)

  it('parses cleanly as YAML (no partial fenced snippets, no tab indentation)', () => {
    expect(parsed).not.toBeNull()
    expect(typeof parsed).toBe('object')
    expect(Array.isArray(parsed)).toBe(false)
  })

  it('declares every field validateMissionExport requires', () => {
    for (const field of CODE_REQUIRED_FIELDS) {
      expect(parsed, `docs/fixer-schema.yaml missing top-level "${field}"`).toHaveProperty(field)
    }
  })

  it('uses a version string that scripts/scanner.mjs accepts', () => {
    expect(CODE_VALID_VERSIONS).toContain(parsed.version)
  })

  it('mission.title and mission.steps have the shapes the scanner enforces', () => {
    // Sanity-check the doc against the same rules validateMissionExport
    // uses, so a reader can't be misled by an example that shows the
    // wrong type.
    expect(typeof parsed.mission).toBe('object')
    expect(typeof parsed.mission.title).toBe('string')
    expect(parsed.mission.title.length).toBeGreaterThan(0)
    expect(Array.isArray(parsed.mission.steps)).toBe(true)
    // The example should demonstrate the "steps carry work" shape, not
    // an empty array — otherwise a contributor could reasonably conclude
    // an empty steps array is idiomatic.
    expect(parsed.mission.steps.length).toBeGreaterThan(0)
  })

  it('the example round-trips validateMissionExport with valid=true', () => {
    const result = validateMissionExport(parsed)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('optional tags/compatibility fields, when present, use scanner-acceptable shapes', () => {
    // The scanner rejects tags that are not an array and compatibility
    // values that are not an object. If the doc example ever demos a
    // wrong shape for these, catch it here.
    if ('tags' in parsed) {
      expect(Array.isArray(parsed.tags)).toBe(true)
    }
    if ('compatibility' in parsed) {
      expect(typeof parsed.compatibility).toBe('object')
      expect(Array.isArray(parsed.compatibility)).toBe(false)
    }
  })

  it('documented optional sections (metadata, prerequisites, security) do not break validation', () => {
    // Prove the union of documented top-level sections still validates.
    // A future doc edit that introduces an invalid section (e.g. mission
    // as an array, or security as a string) would fail this.
    const sections = ['metadata', 'prerequisites', 'security']
    for (const s of sections) {
      if (s in parsed) {
        // Every documented optional section is currently object-shaped.
        expect(typeof parsed[s]).toBe('object')
        expect(parsed[s]).not.toBeNull()
      }
    }
    // And validating the whole document (with those sections attached)
    // still passes.
    expect(validateMissionExport(parsed).valid).toBe(true)
  })

  it('name is kebab-case (matches the contributor convention the doc states)', () => {
    // The doc explicitly instructs contributors: "Keep `name` in kebab-case
    // and match it to the filename without the extension." A doc example
    // that violated its own instruction would mislead every reader.
    expect(parsed.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })
})

// -----------------------------------------------------------------------------
// Negative-space guard: catch code-side drift too.
//
// If scripts/scanner.mjs adds a NEW required field but nobody updates the
// docs example, the first test group above will fail loudly (because the
// doc example now lacks the field and validateMissionExport reports
// `Missing required field: "X"`). The following case flips the mirror:
// simulate stripping each documented required field one at a time and
// assert the scanner does reject it. This catches the opposite drift —
// a doc that promises a field is required, but the scanner silently
// tolerates its absence.
// -----------------------------------------------------------------------------

describe('docs/fixer-schema.yaml required-field enforcement mirror', () => {
  const parsed = yaml.load(fs.readFileSync(SCHEMA_DOC, 'utf-8'))

  for (const field of CODE_REQUIRED_FIELDS) {
    it(`removing "${field}" causes validateMissionExport to fail`, () => {
      const stripped = { ...parsed }
      delete stripped[field]
      const result = validateMissionExport(stripped)
      expect(result.valid).toBe(false)
      expect(result.errors.join('\n')).toMatch(
        new RegExp(`Missing required field: "${field}"`),
      )
    })
  }
})
