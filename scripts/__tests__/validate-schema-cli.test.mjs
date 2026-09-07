import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { runValidation } from '../validate-schema.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', 'validate-schema.mjs')

describe('validate-schema.mjs runValidation (CI observability)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'validate-schema-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports total/validCount/invalidCount for a mix of valid and invalid files', () => {
    const validFile = join(dir, 'valid.json')
    const invalidFile = join(dir, 'invalid.json')
    writeFileSync(
      validFile,
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'ok',
        mission: { title: 'T', steps: [] },
      })
    )
    writeFileSync(invalidFile, JSON.stringify({ name: 'missing-fields' }))

    const result = runValidation([validFile, invalidFile])

    expect(result).toEqual({
      hasErrors: true,
      validCount: 1,
      invalidCount: 1,
      total: 2,
    })
  })

  it('reports no errors when all files are valid', () => {
    const validFile = join(dir, 'valid.json')
    writeFileSync(
      validFile,
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'ok',
        mission: { title: 'T', steps: [] },
      })
    )

    const result = runValidation([validFile])

    expect(result).toEqual({
      hasErrors: false,
      validCount: 1,
      invalidCount: 0,
      total: 1,
    })
  })

  it('counts unreadable files as invalid', () => {
    const missingFile = join(dir, 'does-not-exist.json')

    const result = runValidation([missingFile])

    expect(result).toEqual({
      hasErrors: true,
      validCount: 0,
      invalidCount: 1,
      total: 1,
    })
  })

  it('counts unparsable content as invalid', () => {
    const badFile = join(dir, 'bad.json')
    writeFileSync(badFile, '{ not valid json')

    const result = runValidation([badFile])

    expect(result).toEqual({
      hasErrors: true,
      validCount: 0,
      invalidCount: 1,
      total: 1,
    })
  })

  it('CLI emits a single-line structured JSON summary event to stdout', () => {
    const validFile = join(dir, 'valid.json')
    writeFileSync(
      validFile,
      JSON.stringify({
        version: 'kc-mission-v1',
        name: 'ok',
        mission: { title: 'T', steps: [] },
      })
    )

    const stdout = execFileSync('node', [SCRIPT_PATH, validFile], { encoding: 'utf8' })
    const summaryLine = stdout
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .find(parsed => parsed && parsed.event === 'schema-validation-summary')

    expect(summaryLine).toMatchObject({
      event: 'schema-validation-summary',
      level: 'info',
      trigger: 'changed-files',
      total: 1,
      validCount: 1,
      invalidCount: 0,
    })
    expect(typeof summaryLine.durationMs).toBe('number')
  })

  it('CLI exits non-zero and logs an error-level summary when a file is invalid', () => {
    const invalidFile = join(dir, 'invalid.json')
    writeFileSync(invalidFile, JSON.stringify({ name: 'missing-fields' }))

    let stdout = ''
    let exitCode = 0
    try {
      execFileSync('node', [SCRIPT_PATH, invalidFile], { encoding: 'utf8' })
    } catch (err) {
      stdout = err.stdout
      exitCode = err.status
    }

    expect(exitCode).toBe(1)
    const summaryLine = stdout
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .find(parsed => parsed && parsed.event === 'schema-validation-summary')

    expect(summaryLine).toMatchObject({
      event: 'schema-validation-summary',
      level: 'error',
      total: 1,
      validCount: 0,
      invalidCount: 1,
    })
  })
})
