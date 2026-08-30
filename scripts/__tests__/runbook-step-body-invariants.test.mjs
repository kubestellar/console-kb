/**
 * Step-body invariants for runbooks/*.json
 *
 * Complements runbook-catalog-invariants.test.mjs (envelope/id/title/description)
 * by exercising the operational fields that the mission runner actually executes:
 * commands, validation, failureHandling, estimatedMinutes, and step ordering.
 *
 * All checks are pure filesystem reads; no network, no build.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks')

// A step id looks like "step-05-verify-access" or "step-05b-cluster-stability-guard".
const STEP_NUM_RE = /^step-(\d+)[a-z]?-/

function listRunbookFiles () {
  if (!fs.existsSync(RUNBOOKS_DIR)) return []
  return fs.readdirSync(RUNBOOKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

function readJson (abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf-8'))
}

function stepsOf (doc) {
  return Array.isArray(doc.mission?.steps) ? doc.mission.steps : []
}

describe('runbooks/ step commands', () => {
  const files = listRunbookFiles()

  it('every step has a commands array with at least one entry', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      stepsOf(doc).forEach((s, i) => {
        if (!Array.isArray(s?.commands) || s.commands.length === 0) {
          offenders.push(`${f}[step ${i} id=${s?.id}]: commands missing or empty`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('every command entry is a non-empty string', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      stepsOf(doc).forEach((s, i) => {
        const cmds = s?.commands ?? []
        cmds.forEach((c, ci) => {
          if (typeof c !== 'string' || c.trim().length === 0) {
            offenders.push(
              `${f}[step ${i} id=${s?.id}][command ${ci}]: not a non-empty string (got ${JSON.stringify(c)})`
            )
          }
        })
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ step validation', () => {
  const files = listRunbookFiles()

  it('every step has a non-empty validation string', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      stepsOf(doc).forEach((s, i) => {
        if (typeof s?.validation !== 'string' || s.validation.trim().length === 0) {
          offenders.push(`${f}[step ${i} id=${s?.id}]: validation missing or empty`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ step failureHandling', () => {
  const files = listRunbookFiles()

  it('every step has a non-empty failureHandling string', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      stepsOf(doc).forEach((s, i) => {
        if (typeof s?.failureHandling !== 'string' || s.failureHandling.trim().length === 0) {
          offenders.push(`${f}[step ${i} id=${s?.id}]: failureHandling missing or empty`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ mission estimatedMinutes', () => {
  const files = listRunbookFiles()

  it('every mission.estimatedMinutes is a positive integer', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const em = doc.mission?.estimatedMinutes
      if (
        typeof em !== 'number' ||
        !Number.isInteger(em) ||
        em <= 0
      ) {
        offenders.push(`${f}: mission.estimatedMinutes=${JSON.stringify(em)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ step numeric ordering', () => {
  const files = listRunbookFiles()

  it("every runbook's first step has numeric prefix 1", () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const steps = stepsOf(doc)
      if (steps.length === 0) continue
      const first = steps[0]
      const m = typeof first?.id === 'string' ? STEP_NUM_RE.exec(first.id) : null
      const num = m ? parseInt(m[1], 10) : null
      if (num !== 1) {
        offenders.push(`${f}: first step id=${JSON.stringify(first?.id)} has numeric prefix ${num}, expected 1`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('step numeric prefixes are monotonically non-decreasing', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const steps = stepsOf(doc)
      let prev = -Infinity
      steps.forEach((s, i) => {
        const m = typeof s?.id === 'string' ? STEP_NUM_RE.exec(s.id) : null
        const num = m ? parseInt(m[1], 10) : null
        if (num === null) return
        if (num < prev) {
          offenders.push(
            `${f}[step ${i} id=${s.id}]: prefix ${num} < previous ${prev} (not non-decreasing)`
          )
        }
        prev = num
      })
    }
    expect(offenders).toEqual([])
  })
})
