/**
 * Further runbook catalog invariants not covered by the existing suites.
 *
 * runbook-catalog-invariants.test.mjs and runbook-step-body-invariants.test.mjs
 * lock the JSON envelope, the top-level author/name/version fields, step
 * id/title/description/commands/validation/failureHandling presence, first-step
 * numeric prefix, and monotonically non-decreasing numeric prefixes. Three
 * further silent-drift risks are not covered by any test today:
 *
 *   1. **mission.title uniqueness across the catalog.** The runbook picker
 *      and fixes/index.json expose the mission title as the human label; two
 *      runbooks sharing a title are indistinguishable in the UI and would
 *      make the "wrong" one addressable only via URL. `name` uniqueness is
 *      locked but titles can drift independently.
 *
 *   2. **Step numeric prefixes have no gaps.** The existing
 *      `step numeric prefixes are monotonically non-decreasing` test accepts
 *      `[1, 2, 4]` and `[1, 2, 5]` — a step was removed but the numbering
 *      wasn't renumbered. Runbooks in the catalog today go `1..N` with
 *      optional duplicate-of-N step-Na/step-Nb interleaves, never a gap.
 *
 *   3. **Step titles are unique within a runbook.** Two steps titled
 *      "Verify" in the same runbook are indistinguishable in a UI that
 *      summarizes a runbook by its step titles (progress list, TOC), and
 *      make failure-mode narration ambiguous ("Verify failed" — which
 *      one?). Step **ids** are checked for uniqueness; **titles** are not.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks')

const STEP_ID_NUMERIC = /^step-(\d{2})/

function loadRunbooks() {
  return fs
    .readdirSync(RUNBOOKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: f,
      data: JSON.parse(fs.readFileSync(path.join(RUNBOOKS_DIR, f), 'utf8')),
    }))
}

const RUNBOOKS = loadRunbooks()

describe('runbooks/ further catalog invariants', () => {
  it('mission.title is unique across the runbook catalog', () => {
    expect(RUNBOOKS.length).toBeGreaterThan(0)
    const seen = new Map()
    const dupes = []
    for (const { file, data } of RUNBOOKS) {
      const title = data?.mission?.title
      if (typeof title !== 'string' || !title.trim()) continue
      const prev = seen.get(title)
      if (prev !== undefined) {
        dupes.push({ title, files: [prev, file] })
      } else {
        seen.set(title, file)
      }
    }
    expect(
      dupes,
      `duplicate mission.title across runbooks (indistinguishable in ` +
        `the picker and fixes/index.json): ${JSON.stringify(dupes)}`,
    ).toEqual([])
  })

  it('step numeric prefixes have no gaps (unique values increment by 1)', () => {
    for (const { file, data } of RUNBOOKS) {
      const steps = data?.mission?.steps ?? []
      const nums = steps
        .map((s) => {
          const m = STEP_ID_NUMERIC.exec(s?.id ?? '')
          return m ? Number.parseInt(m[1], 10) : null
        })
        .filter((n) => n !== null)
      if (nums.length === 0) continue
      // Preserve first-appearance order for the unique list. Because the
      // existing suite already asserts non-decreasing order, this is the
      // same as sorted.
      const unique = [...new Set(nums)]
      for (let i = 0; i < unique.length - 1; i++) {
        expect(
          unique[i + 1] - unique[i],
          `${file}: step numeric prefixes have a gap between ` +
            `${unique[i]} and ${unique[i + 1]} — a step was removed ` +
            `without renumbering. Full sequence: ${nums.join(',')}`,
        ).toBe(1)
      }
    }
  })

  it('step titles are unique within each runbook', () => {
    for (const { file, data } of RUNBOOKS) {
      const steps = data?.mission?.steps ?? []
      const seen = new Map()
      const dupes = []
      for (const s of steps) {
        const t = s?.title
        if (typeof t !== 'string' || !t.trim()) continue
        const prev = seen.get(t)
        if (prev !== undefined) {
          dupes.push({ title: t, ids: [prev, s.id] })
        } else {
          seen.set(t, s.id)
        }
      }
      expect(
        dupes,
        `${file}: duplicate step titles (progress-list / TOC / failure ` +
          `narration become ambiguous): ${JSON.stringify(dupes)}`,
      ).toEqual([])
    }
  })
})
