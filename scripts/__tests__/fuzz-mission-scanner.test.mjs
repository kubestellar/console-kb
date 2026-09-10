import { describe, it, expect } from 'vitest'
import { fuzzMissionScanner, MALFORMED_INPUTS } from '../fuzz-mission-scanner.mjs'

describe('fuzz-mission-scanner.mjs fuzzMissionScanner (CI observability)', () => {
  it('handles every entry in the default malformed-input set without throwing', () => {
    const result = fuzzMissionScanner()
    expect(result).toEqual({ total: MALFORMED_INPUTS.length, handled: MALFORMED_INPUTS.length })
  })

  it('reports total matching the length of a custom input list', () => {
    const inputs = ['{"a":1}', '{"b":2}', 'not json at all']
    const result = fuzzMissionScanner(inputs)
    expect(result.total).toBe(3)
    expect(result.handled).toBe(3)
  })

  it('handles an empty input list', () => {
    const result = fuzzMissionScanner([])
    expect(result).toEqual({ total: 0, handled: 0 })
  })

  it('does not throw for a large repeated-tag payload (guards against catastrophic parsing behavior)', () => {
    const bigInput = `{"metadata":{"tags":["${'a'.repeat(1000)}"]}}`
    expect(() => fuzzMissionScanner([bigInput])).not.toThrow()
  })
})
