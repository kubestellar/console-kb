import { describe, it, expect } from 'vitest'
import { validateMissionExport } from '../scanner.mjs'

// Regression guards for previously-uncovered branches in
// scripts/scanner.mjs::validateMissionExport (v8 coverage flagged the
// enter-arms of the type-guard branches at lines 32, 37, and 54 as
// unhit — the existing suite only exercises the missing-field and
// wrong-version paths). These are the schema failure modes a user
// would hit when the exported YAML/JSON has the right key shape but
// the WRONG SCALAR type on a field, which is a distinct bug class
// from the fields being absent altogether.

function baseMission(overrides = {}) {
  return {
    version: 'kc-mission-v1',
    name: 'demo-mission',
    mission: {
      title: 'Demo Mission',
      steps: [{ title: 'Step 1', description: 'Do something' }],
    },
    ...overrides,
  }
}

describe('validateMissionExport — type-guard branches', () => {
  it('rejects a numeric name (typeof data.name !== "string" branch)', () => {
    const result = validateMissionExport(baseMission({ name: 123 }))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('"name" must be a string')
  })

  it('rejects a string mission (typeof data.mission !== "object" branch)', () => {
    const result = validateMissionExport({
      version: 'kc-mission-v1',
      name: 'demo',
      mission: 'not-an-object',
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('"mission" must be an object')
    // The inner title/steps checks must NOT run when mission is not an
    // object — otherwise they would crash on the string primitive.
    expect(result.errors.some(e => e.includes('mission.title'))).toBe(false)
    expect(result.errors.some(e => e.includes('mission.steps'))).toBe(false)
  })

  it('rejects a string tags field (Array.isArray(data.tags) === false branch)', () => {
    const result = validateMissionExport(baseMission({ tags: 'k8s,mission' }))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('"tags" must be an array')
  })

  it('accepts an array tags field', () => {
    const result = validateMissionExport(baseMission({ tags: ['k8s', 'mission'] }))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a string compatibility field (typeof compatibility !== "object" branch)', () => {
    const result = validateMissionExport(baseMission({ compatibility: 'v1' }))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('"compatibility" must be an object')
  })

  it('accepts a compatibility object (else arm of the type check)', () => {
    const result = validateMissionExport(
      baseMission({ compatibility: { kubestellar: '>=0.28.0' } }),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('reports mission.steps being a non-array (Array.isArray branch)', () => {
    const result = validateMissionExport({
      version: 'kc-mission-v1',
      name: 'demo',
      mission: { title: 'T', steps: 'do-a-thing' },
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('mission.steps'))).toBe(true)
  })
})
