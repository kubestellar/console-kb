import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runValidation } from '../validate-schema.mjs'

/**
 * Covers the previously-uncovered YAML/YML/unknown-extension parse branches
 * in scripts/validate-schema.mjs (lines 66-77). Existing runValidation
 * tests only exercised .json files, so the yaml.load arms and the
 * unknown-extension "try JSON first, then YAML" fallback were never
 * executed.
 */
describe('validate-schema.mjs runValidation — YAML/unknown-extension parse arms', () => {
  let dir

  const VALID = {
    version: 'kc-mission-v1',
    name: 'ok',
    mission: { title: 'T', steps: [] },
  }

  const validYaml = `version: kc-mission-v1
name: ok
mission:
  title: T
  steps: []
`

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'validate-schema-yaml-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses a .yaml mission via js-yaml', () => {
    const f = join(dir, 'ok.yaml')
    writeFileSync(f, validYaml)
    const result = runValidation([f])
    expect(result).toEqual({
      hasErrors: false,
      validCount: 1,
      invalidCount: 0,
      total: 1,
    })
  })

  it('parses a .yml mission via js-yaml', () => {
    const f = join(dir, 'ok.yml')
    writeFileSync(f, validYaml)
    const result = runValidation([f])
    expect(result).toEqual({
      hasErrors: false,
      validCount: 1,
      invalidCount: 0,
      total: 1,
    })
  })

  it('reports invalid .yaml parse errors as invalid', () => {
    const f = join(dir, 'bad.yaml')
    // Unclosed flow mapping — js-yaml will throw.
    writeFileSync(f, 'mission: {name: T\n')
    const result = runValidation([f])
    expect(result).toEqual({
      hasErrors: true,
      validCount: 0,
      invalidCount: 1,
      total: 1,
    })
  })

  it('accepts JSON content in a file with an unknown extension (JSON-first fallback)', () => {
    // Non-.json/.yaml/.yml file — exercises the "try JSON first, then YAML"
    // else-branch. JSON.parse succeeds so yaml.load is not called.
    const f = join(dir, 'mission.txt')
    writeFileSync(f, JSON.stringify(VALID))
    const result = runValidation([f])
    expect(result).toEqual({
      hasErrors: false,
      validCount: 1,
      invalidCount: 0,
      total: 1,
    })
  })

  it('falls back to YAML for unknown-extension files whose content is not JSON', () => {
    // Unknown extension, YAML content — JSON.parse throws, yaml.load succeeds.
    const f = join(dir, 'mission.data')
    writeFileSync(f, validYaml)
    const result = runValidation([f])
    expect(result).toEqual({
      hasErrors: false,
      validCount: 1,
      invalidCount: 0,
      total: 1,
    })
  })

  it('reports invalid unknown-extension content (neither JSON nor YAML) as invalid', () => {
    const f = join(dir, 'mission.data')
    // ':::' is invalid JSON AND invalid YAML (block mapping with empty key + weird
    // syntax makes js-yaml throw).
    writeFileSync(f, ':::\n\t: [')
    const result = runValidation([f])
    expect(result.hasErrors).toBe(true)
    expect(result.invalidCount).toBe(1)
    expect(result.validCount).toBe(0)
  })
})
