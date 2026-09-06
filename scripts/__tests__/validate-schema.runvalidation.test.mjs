import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runValidation } from '../validate-schema.mjs'

/**
 * Coverage for scripts/validate-schema.mjs.
 *
 * Baseline was 0% (existing __tests__/validate-schema.test.mjs only imports
 * validateMissionExport from scanner.mjs). runValidation is the exported
 * pure-ish function used by the CI workflow to check every mission file;
 * it dispatches JSON vs YAML parsing by extension and aggregates results.
 * These tests exercise every branch of that dispatch and the failure arms.
 */

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ckb-validate-'))
}

// A minimal mission that satisfies validateMissionExport (kc-mission-v1).
const VALID_MISSION = {
  version: 'kc-mission-v1',
  name: 'demo-mission',
  mission: { title: 'T', steps: [] },
}

describe('runValidation', () => {
  let tmp
  let logs
  let errs
  let logSpy
  let errSpy

  beforeEach(() => {
    tmp = makeTmp()
    logs = []
    errs = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
    errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => errs.push(args.join(' ')))
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns hasErrors=false, all-valid counts for a valid JSON mission', () => {
    const p = join(tmp, 'ok.json')
    writeFileSync(p, JSON.stringify(VALID_MISSION))
    const res = runValidation([p])
    expect(res).toEqual({ hasErrors: false, validCount: 1, invalidCount: 0, total: 1 })
    expect(logs.some(l => l.includes('Valid kc-mission-v1'))).toBe(true)
  })

  it('parses .yaml missions via yaml.load (non-JSON dispatch arm)', () => {
    const p = join(tmp, 'ok.yaml')
    writeFileSync(
      p,
      'version: kc-mission-v1\nname: demo\nmission:\n  title: T\n  steps: []\n',
    )
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })

  it('parses .yml missions via yaml.load (non-JSON dispatch arm)', () => {
    const p = join(tmp, 'ok.yml')
    writeFileSync(
      p,
      'version: kc-mission-v1\nname: demo\nmission:\n  title: T\n  steps: []\n',
    )
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })

  it('falls back to YAML parsing for extensionless files', () => {
    // File with no recognized extension → hits the else-branch that tries
    // JSON.parse first and falls through to yaml.load on failure.
    const p = join(tmp, 'ok')
    writeFileSync(
      p,
      'version: kc-mission-v1\nname: demo\nmission:\n  title: T\n  steps: []\n',
    )
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })

  it('reports a read failure and counts the file as invalid', () => {
    const missing = join(tmp, 'does-not-exist.json')
    const res = runValidation([missing])
    expect(res).toEqual({ hasErrors: true, validCount: 0, invalidCount: 1, total: 1 })
    expect(errs.some(e => e.includes('Could not read file'))).toBe(true)
  })

  it('reports a JSON parse error and counts the file as invalid', () => {
    const p = join(tmp, 'bad.json')
    writeFileSync(p, '{not-json')
    const res = runValidation([p])
    expect(res.hasErrors).toBe(true)
    expect(res.invalidCount).toBe(1)
    expect(errs.some(e => e.includes('Parse error'))).toBe(true)
  })

  it('reports a YAML parse error and counts the file as invalid', () => {
    const p = join(tmp, 'bad.yaml')
    // Unclosed flow mapping — reliably rejected by js-yaml.
    writeFileSync(p, ': :\n\t: unbalanced\n{a: [')
    const res = runValidation([p])
    expect(res.hasErrors).toBe(true)
    expect(res.invalidCount).toBe(1)
    expect(errs.some(e => e.includes('Parse error'))).toBe(true)
  })

  it('reports each validateMissionExport error and marks the file invalid', () => {
    const p = join(tmp, 'schema-fail.json')
    // Well-formed JSON but missing required schema fields.
    writeFileSync(p, JSON.stringify({ version: 'kc-mission-v1' }))
    const res = runValidation([p])
    expect(res.hasErrors).toBe(true)
    expect(res.invalidCount).toBe(1)
    // Each error is emitted on its own bulleted stderr line.
    expect(errs.some(e => e.trim().startsWith('-'))).toBe(true)
  })

  it('aggregates counts across a mixed batch (valid + invalid)', () => {
    const good = join(tmp, 'good.json')
    const badParse = join(tmp, 'bad.json')
    const badSchema = join(tmp, 'schema.json')
    writeFileSync(good, JSON.stringify(VALID_MISSION))
    writeFileSync(badParse, '{')
    writeFileSync(badSchema, JSON.stringify({ version: 'kc-mission-v1' }))
    const res = runValidation([good, badParse, badSchema])
    expect(res).toEqual({ hasErrors: true, validCount: 1, invalidCount: 2, total: 3 })
  })

  it('returns zeroed counts for an empty file list', () => {
    const res = runValidation([])
    expect(res).toEqual({ hasErrors: false, validCount: 0, invalidCount: 0, total: 0 })
  })
})
