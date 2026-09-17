import { describe, it, expect } from 'vitest'
import { averageQualityScore } from '../lib/mission-quality-stats.mjs'

describe('averageQualityScore', () => {
  it('returns 0 for an empty list', () => {
    expect(averageQualityScore([])).toBe(0)
  })

  it('averages metadata.qualityScore across missions', () => {
    const missions = [{ metadata: { qualityScore: 80 } }, { metadata: { qualityScore: 60 } }]
    expect(averageQualityScore(missions)).toBe(70)
  })

  it('falls back to a top-level qualityScore when metadata is absent', () => {
    const missions = [{ qualityScore: 50 }, { qualityScore: 90 }]
    expect(averageQualityScore(missions)).toBe(70)
  })

  it('treats missions with no score as 0', () => {
    const missions = [{ metadata: { qualityScore: 100 } }, {}]
    expect(averageQualityScore(missions)).toBe(50)
  })

  it('rounds the average to the nearest integer', () => {
    const missions = [{ metadata: { qualityScore: 1 } }, { metadata: { qualityScore: 2 } }, { metadata: { qualityScore: 2 } }]
    expect(averageQualityScore(missions)).toBe(2)
  })
})
