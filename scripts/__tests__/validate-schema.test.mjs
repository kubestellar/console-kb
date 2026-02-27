import { describe, it, expect } from 'vitest'
import { validateMissionExport } from '../scanner.mjs'

describe('validate-schema logic (via scanner exports)', () => {
  it('rejects non-object input (string)', () => {
    const result = validateMissionExport('not an object')
    expect(result.valid).toBe(false)
  })

  it('rejects empty object', () => {
    const result = validateMissionExport({})
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('accepts valid mission with optional tags array', () => {
    const data = {
      version: 'kc-mission-v1',
      name: 'tagged-mission',
      mission: { title: 'T', steps: [] },
      tags: ['kubernetes', 'demo'],
    }
    expect(validateMissionExport(data).valid).toBe(true)
  })

  it('rejects invalid tags (not array)', () => {
    const data = {
      version: 'kc-mission-v1',
      name: 'bad-tags',
      mission: { title: 'T', steps: [] },
      tags: 'not-an-array',
    }
    const result = validateMissionExport(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('tags'))).toBe(true)
  })

  it('rejects invalid compatibility (not object)', () => {
    const data = {
      version: 'kc-mission-v1',
      name: 'bad-compat',
      mission: { title: 'T', steps: [] },
      compatibility: 'string-not-object',
    }
    const result = validateMissionExport(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('compatibility'))).toBe(true)
  })

  it('rejects mission with non-array steps', () => {
    const data = {
      version: 'kc-mission-v1',
      name: 'bad-steps',
      mission: { title: 'T', steps: 'not-array' },
    }
    const result = validateMissionExport(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('mission.steps'))).toBe(true)
  })
})
