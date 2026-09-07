import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runValidation } from '../validate-schema.mjs'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Coverage for the exported runValidation() in scripts/validate-schema.mjs.
 * The existing __tests__/validate-schema.test.mjs only exercises
 * scanner.mjs's validateMissionExport() — so runValidation() itself and
 * all of its branches (JSON vs YAML parse arms, unknown-extension
 * fallback, read errors, parse errors, valid-vs-invalid tally) are
 * untested. That leaves validate-schema.mjs at 44.77% stmt / 19.35%
 * branch coverage even though the file is 152 lines.
 *
 * These tests raise the exported-surface coverage by driving
 * runValidation() with a mix of tmp fixture files. They do not touch
 * main() / process.exit / process.argv, so no CLI mocking is needed.
 */

let workdir
const validMission = {
  version: 'kc-mission-v1',
  name: 'valid-mission',
  mission: { title: 'T', steps: [] },
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'validate-schema-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

function write(filename, content) {
  const path = join(workdir, filename)
  writeFileSync(path, content, 'utf8')
  return path
}

describe('runValidation — valid mission across file types', () => {
  it('accepts a valid mission written as .json', () => {
    const p = write('m.json', JSON.stringify(validMission))
    const res = runValidation([p])
    expect(res).toEqual({ hasErrors: false, validCount: 1, invalidCount: 0, total: 1 })
  })

  it('accepts a valid mission written as .yaml', () => {
    const yaml =
      'version: kc-mission-v1\n' +
      'name: valid-mission\n' +
      'mission:\n  title: T\n  steps: []\n'
    const p = write('m.yaml', yaml)
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })

  it('accepts a valid mission written as .yml', () => {
    const yaml =
      'version: kc-mission-v1\n' +
      'name: valid-mission\n' +
      'mission:\n  title: T\n  steps: []\n'
    const p = write('m.yml', yaml)
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })

  it('accepts a valid mission written as an unknown extension (JSON-first fallback path)', () => {
    // The unknown-extension arm tries JSON.parse first, then falls back
    // to yaml.load. JSON content covers the JSON-succeeds branch of
    // that inner try/catch.
    const p = write('m.mission', JSON.stringify(validMission))
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })

  it('accepts a valid mission on unknown extension via the YAML fallback', () => {
    // Not-valid-JSON so the inner try{JSON.parse} catches, then
    // yaml.load succeeds — the second arm of the unknown-ext branch.
    const yaml =
      'version: kc-mission-v1\n' +
      'name: valid-mission\n' +
      'mission:\n  title: T\n  steps: []\n'
    const p = write('m.txt', yaml)
    const res = runValidation([p])
    expect(res.hasErrors).toBe(false)
    expect(res.validCount).toBe(1)
  })
})

describe('runValidation — parse errors', () => {
  it('reports a JSON parse error and counts the file as invalid', () => {
    const p = write('bad.json', '{ not valid json')
    const res = runValidation([p])
    expect(res).toEqual({ hasErrors: true, validCount: 0, invalidCount: 1, total: 1 })
  })

  it('reports a YAML parse error and counts the file as invalid', () => {
    // Tab-indented block is a hard YAML syntax error.
    const p = write('bad.yaml', 'version: kc-mission-v1\n\tname: x\n')
    const res = runValidation([p])
    expect(res.hasErrors).toBe(true)
    expect(res.invalidCount).toBe(1)
  })
})

describe('runValidation — schema errors', () => {
  it('reports a schema-invalid mission as invalid but still readable', () => {
    // Parses fine but fails validateMissionExport (missing required fields).
    const p = write('empty.json', JSON.stringify({ version: 'kc-mission-v1' }))
    const res = runValidation([p])
    expect(res.hasErrors).toBe(true)
    expect(res.validCount).toBe(0)
    expect(res.invalidCount).toBe(1)
    expect(res.total).toBe(1)
  })
})

describe('runValidation — file-read errors', () => {
  it('reports a missing file as unreadable rather than throwing', () => {
    const missing = join(workdir, 'does-not-exist.json')
    const res = runValidation([missing])
    expect(res).toEqual({ hasErrors: true, validCount: 0, invalidCount: 1, total: 1 })
  })
})

describe('runValidation — tallies across a mixed batch', () => {
  it('accumulates valid and invalid counts and preserves total = length', () => {
    const files = [
      write('a.json', JSON.stringify(validMission)),
      write('b.json', JSON.stringify(validMission)),
      write('bad.json', '{'),
      write('missing.json', JSON.stringify({ version: 'kc-mission-v1' })),
    ]
    // Also include a truly missing file so the read-error arm participates.
    files.push(join(workdir, 'gone.json'))

    const res = runValidation(files)
    expect(res.total).toBe(5)
    expect(res.validCount).toBe(2)
    expect(res.invalidCount).toBe(3)
    expect(res.hasErrors).toBe(true)
  })

  it('reports no errors and total=0 for an empty batch', () => {
    const res = runValidation([])
    expect(res).toEqual({ hasErrors: false, validCount: 0, invalidCount: 0, total: 0 })
  })
})
