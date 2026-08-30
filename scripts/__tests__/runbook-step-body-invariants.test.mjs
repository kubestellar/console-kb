/**
 * Step-body invariants for the shipped runbooks/*.json catalog.
 *
 * scripts/__tests__/runbook-catalog-invariants.test.mjs already covers
 * envelope-shape (version/name/missionClass/author), mission-level
 * fields, and step id/title/description. It does not cover the payload
 * of each step — the fields the mission runner actually executes.
 *
 * A silent regression that reaches consumers (Console mission runner)
 * even with the envelope suite green:
 *   - a step with `commands: []` (runner runs nothing)
 *   - a step with `commands: [""]` or a non-string command (runner
 *     tries to shell-out a whitespace or a `null`)
 *   - a step with `validation` or `failureHandling` blanked out during
 *     an edit (runner can't tell success from failure; operator has no
 *     recovery guidance)
 *   - `mission.estimatedMinutes` shipped as a string, a float, zero, or
 *     negative (UI truncates or renders "NaN minutes")
 *   - step numeric prefixes going backwards ("step-03" listed after
 *     "step-05") — runner still executes in array order, but the
 *     rendered checklist reads out-of-order and reviewers miss it
 *
 * Every check here is a pure filesystem read; no network, no build.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT    = path.resolve(path.dirname(__filename), '../..')
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks')

function listRunbookFiles () {
  if (!fs.existsSync(RUNBOOKS_DIR)) return []
  return fs.readdirSync(RUNBOOKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

function readJson (abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf-8'))
}

function stepNumericPrefix (id) {
  // "step-05-foo" -> 5 ; "step-05b-guard" -> 5. Guarded by
  // runbook-catalog-invariants' STEP_ID_RE upstream; if that test is
  // green, this parse succeeds.
  const m = /^step-(\d+)[a-z]?-/.exec(id)
  return m ? Number.parseInt(m[1], 10) : Number.NaN
}

describe('runbooks/ step body — commands', () => {
  const files = listRunbookFiles()

  it('every step has a `commands` array with at least one entry', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      for (const step of doc.mission.steps) {
        if (!Array.isArray(step.commands) || step.commands.length === 0) {
          offenders.push(`${f}#${step.id}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every command is a non-empty string with non-whitespace content', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      for (const step of doc.mission.steps) {
        const cmds = Array.isArray(step.commands) ? step.commands : []
        cmds.forEach((c, i) => {
          if (typeof c !== 'string' || c.trim().length === 0) {
            offenders.push(`${f}#${step.id}[${i}]=${JSON.stringify(c)}`)
          }
        })
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ step body — validation and failure handling', () => {
  const files = listRunbookFiles()

  it('every step has non-empty `validation` string', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      for (const step of doc.mission.steps) {
        if (typeof step.validation !== 'string' || step.validation.trim().length === 0) {
          offenders.push(`${f}#${step.id}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every step has non-empty `failureHandling` string', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      for (const step of doc.mission.steps) {
        if (typeof step.failureHandling !== 'string' || step.failureHandling.trim().length === 0) {
          offenders.push(`${f}#${step.id}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ mission — estimatedMinutes', () => {
  const files = listRunbookFiles()

  it('every runbook mission.estimatedMinutes is a positive integer', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const em = doc.mission.estimatedMinutes
      if (typeof em !== 'number' || !Number.isInteger(em) || em <= 0) {
        offenders.push(`${f}: ${JSON.stringify(em)} (${typeof em})`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('runbooks/ step ordering', () => {
  const files = listRunbookFiles()

  it('step numeric prefixes start at 1 within each runbook', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const first = doc.mission.steps[0]
      if (!first || stepNumericPrefix(first.id) !== 1) {
        offenders.push(`${f}: first step id = ${first ? first.id : '<none>'}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('step numeric prefixes are monotonically non-decreasing in array order', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const nums = doc.mission.steps.map((s) => stepNumericPrefix(s.id))
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] < nums[i - 1]) {
          offenders.push(`${f}: step ${doc.mission.steps[i].id} (${nums[i]}) after ${doc.mission.steps[i - 1].id} (${nums[i - 1]})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
