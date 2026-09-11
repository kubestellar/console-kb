import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fuzzJsonFixtures } from '../fuzz-json-fixtures.mjs'

describe('fuzz-json-fixtures.mjs fuzzJsonFixtures (CI observability)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fuzz-json-fixtures-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports scanned/errors as 0 when a configured directory does not exist', () => {
    const result = fuzzJsonFixtures([join(dir, 'missing-dir')])
    expect(result).toEqual({ scanned: 0, errors: 0, errorFiles: [] })
  })

  it('counts valid JSON files as scanned with no errors', () => {
    const sub = join(dir, 'cncf-generated')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(sub, 'b.json'), JSON.stringify({ ok: true }))

    const result = fuzzJsonFixtures([sub])

    expect(result.scanned).toBe(2)
    expect(result.errors).toBe(0)
    expect(result.errorFiles).toEqual([])
  })

  it('counts malformed JSON files as errors and records the file path + message', () => {
    const sub = join(dir, 'cncf-install')
    mkdirSync(sub)
    writeFileSync(join(sub, 'good.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(sub, 'bad.json'), '{not valid json')

    const result = fuzzJsonFixtures([sub])

    expect(result.scanned).toBe(2)
    expect(result.errors).toBe(1)
    expect(result.errorFiles).toHaveLength(1)
    expect(result.errorFiles[0].file).toBe(join(sub, 'bad.json'))
    expect(typeof result.errorFiles[0].message).toBe('string')
  })

  it('ignores non-.json files and aggregates counts across multiple directories', () => {
    const sub1 = join(dir, 'llm-d')
    const sub2 = join(dir, 'platform-install')
    mkdirSync(sub1)
    mkdirSync(sub2)
    writeFileSync(join(sub1, 'a.json'), JSON.stringify({ ok: true }))
    writeFileSync(join(sub1, 'readme.md'), 'not json, not counted')
    writeFileSync(join(sub2, 'b.json'), '{broken')

    const result = fuzzJsonFixtures([sub1, sub2])

    expect(result.scanned).toBe(2)
    expect(result.errors).toBe(1)
  })
})
