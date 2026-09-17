import { describe, it, expect } from 'vitest'
import {
  filterRecentPRs,
  requiredChecksPassed,
  findMissionFile,
  decodeMissionContent,
} from '../lib/mission-auto-merge.mjs'

describe('filterRecentPRs', () => {
  const now = new Date('2024-06-15T12:00:00Z').getTime()

  it('keeps PRs created within the lookback window', () => {
    const prs = [{ number: 1, createdAt: '2024-06-15T10:00:00Z' }]
    expect(filterRecentPRs(prs, 6, now)).toHaveLength(1)
  })

  it('excludes PRs created before the lookback window', () => {
    const prs = [{ number: 2, createdAt: '2024-06-15T04:00:00Z' }]
    expect(filterRecentPRs(prs, 6, now)).toHaveLength(0)
  })

  it('includes a PR created exactly at the lookback boundary', () => {
    const prs = [{ number: 3, createdAt: '2024-06-15T06:00:00Z' }]
    expect(filterRecentPRs(prs, 6, now)).toHaveLength(1)
  })

  it('returns an empty array for an empty PR list', () => {
    expect(filterRecentPRs([], 6, now)).toEqual([])
  })
})

describe('requiredChecksPassed', () => {
  const REQUIRED = ['Mission Safety Scan', 'Validate Mission Schema']

  it('passes when all required checks have bucket "pass"', () => {
    const json = JSON.stringify([
      { name: 'Mission Safety Scan', state: 'SUCCESS', bucket: 'pass' },
      { name: 'Validate Mission Schema', state: 'SUCCESS', bucket: 'pass' },
    ])
    expect(requiredChecksPassed(json, REQUIRED)).toEqual({ pass: true })
  })

  it('fails and reports the missing check when a required check is absent', () => {
    const json = JSON.stringify([{ name: 'Mission Safety Scan', state: 'SUCCESS', bucket: 'pass' }])
    expect(requiredChecksPassed(json, REQUIRED)).toEqual({
      pass: false,
      name: 'Validate Mission Schema',
      state: 'missing',
    })
  })

  it('fails and reports state when a required check has not passed', () => {
    const json = JSON.stringify([
      { name: 'Mission Safety Scan', state: 'PENDING', bucket: 'pending' },
      { name: 'Validate Mission Schema', state: 'SUCCESS', bucket: 'pass' },
    ])
    expect(requiredChecksPassed(json, REQUIRED)).toEqual({
      pass: false,
      name: 'Mission Safety Scan',
      state: 'PENDING',
    })
  })

  it('treats invalid JSON as no checks present (fails on the first required check)', () => {
    expect(requiredChecksPassed('not json', REQUIRED)).toEqual({
      pass: false,
      name: 'Mission Safety Scan',
      state: 'missing',
    })
  })

  it('treats empty input as no checks present', () => {
    expect(requiredChecksPassed('', REQUIRED)).toEqual({
      pass: false,
      name: 'Mission Safety Scan',
      state: 'missing',
    })
  })
})

describe('findMissionFile', () => {
  it('finds a mission JSON under fixes/ that is not index.json', () => {
    const out = 'fixes/index.json\nfixes/cncf-mission/foo-bar.json\nREADME.md\n'
    expect(findMissionFile(out)).toBe('fixes/cncf-mission/foo-bar.json')
  })

  it('returns undefined when no mission file is present', () => {
    expect(findMissionFile('fixes/index.json\nREADME.md\n')).toBeUndefined()
  })
})

describe('decodeMissionContent', () => {
  it('decodes a base64-encoded JSON payload', () => {
    const payload = { mission: { description: 'test' } }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    expect(decodeMissionContent(encoded)).toEqual(payload)
  })

  it('trims surrounding whitespace before decoding', () => {
    const payload = { a: 1 }
    const encoded = `  ${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}\n`
    expect(decodeMissionContent(encoded)).toEqual(payload)
  })
})
