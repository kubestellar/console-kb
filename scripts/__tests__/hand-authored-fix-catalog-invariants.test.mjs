/**
 * Repo-integrity invariants for the hand-authored fix catalog under
 * `fixes/`. Modelled on scripts/__tests__/runbook-catalog-invariants.test.mjs
 * (which covers `runbooks/*.json`).
 *
 * Scope: every `fixes/**\/*.json` file that is NOT under one of the
 * machine-generated sub-trees (`cncf-generated/`, `cncf-install/`,
 * `platform-install/`) and is not the catalog roll-up (`fixes/index.json`).
 *
 * These files are consumed by the console mission runner (keying off
 * `name` and `mission.type`) and by the fixes/index.json build artifact
 * (keying off filename). A silent drift — wrong `version`, missing
 * `mission.title`, non-kebab `name`, `name` != filename stem, missing
 * `mission.type`, empty `mission.steps` — reaches consumers untouched
 * and only fails at execution time.
 *
 * See tracking issue kubestellar/console-kb#3076.
 *
 * Two entries in KNOWN_BROKEN below pin an existing drift file so the
 * pin self-clears when the fix lands (mirrors the barrel-shim pattern
 * in kubestellar/console-marketplace#494). Removing the file from the
 * allowlist without also fixing the underlying drift will fail the
 * corresponding positive test; fixing the drift without removing the
 * pin will make the `it.fails` guard fail with "expected to fail but
 * passed", flagging the on-ramp for cleanup.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')
const FIXES_DIR = path.join(REPO_ROOT, 'fixes')

// Machine-generated sub-trees; excluded from this hand-authored walk
// because they have their own generation-pipeline guarantees and their
// own dedicated test files (generate-cncf-*, generate-platform-*).
const MACHINE_GENERATED_DIRS = new Set([
  'cncf-generated',
  'cncf-install',
  'platform-install',
])

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// Values observed in the current catalog. Anything outside this set on
// a hand-authored fix indicates either a real drift or a legitimate
// catalog expansion that the reviewer should decide about explicitly.
const KNOWN_MISSION_CLASSES = new Set([
  'install',
  'fixer',
  'orbit',
  'backup',
  'troubleshoot',
])

const KNOWN_MISSION_TYPES = new Set([
  'deploy',
  'repair',
  'maintain',
  'operations',
  'troubleshoot',
])

// Self-clearing on-ramp for the drift discovered when this suite was
// authored (kubestellar/console-kb#3076). The pin points at the RELATIVE
// path from repo root so it survives CI checkouts. The kubevuln file has
// multiple concurrent drift issues (name-vs-filename, missing
// mission.description, missing mission.status, missing mission.type);
// pinning at file granularity keeps the on-ramp readable. When the
// file is fixed, remove the entry AND flip the paired `it.fails`
// guard to plain `it`; the surrounding positive tests will then cover
// it automatically.
const KNOWN_BROKEN_FILES = new Set([
  'fixes/troubleshooting/solution-fix-kubevuln-crash-looping-due-to-ephemeral-storage-eviction.json',
])


function discoverHandAuthoredFixes(dir, relRoot = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const topSegment = rel.split('/')[0]
      if (MACHINE_GENERATED_DIRS.has(topSegment)) continue
      out.push(...discoverHandAuthoredFixes(path.join(dir, entry.name), rel))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      if (entry.name === 'index.json' && relRoot === '') continue
      out.push({
        absPath: path.join(dir, entry.name),
        repoRelPath: `fixes/${rel}`,
        stem: entry.name.replace(/\.json$/, ''),
      })
    }
  }
  return out
}

const FIXES = discoverHandAuthoredFixes(FIXES_DIR).sort((a, b) =>
  a.repoRelPath < b.repoRelPath ? -1 : 1,
)


describe('hand-authored fixes/ catalog', () => {
  it('discovers at least one hand-authored fix file', () => {
    expect(FIXES.length).toBeGreaterThan(0)
  })

  it('every hand-authored fix is valid JSON', () => {
    for (const f of FIXES) {
      const raw = fs.readFileSync(f.absPath, 'utf8')
      expect(() => JSON.parse(raw), f.repoRelPath).not.toThrow()
    }
  })

  it('every hand-authored fix declares version="kc-mission-v1"', () => {
    for (const f of FIXES) {
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      expect(d.version, f.repoRelPath).toBe('kc-mission-v1')
    }
  })

  it('every hand-authored fix has a kebab-case name', () => {
    for (const f of FIXES) {
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      expect(typeof d.name, f.repoRelPath).toBe('string')
      expect(d.name, `${f.repoRelPath}: name=${JSON.stringify(d.name)}`).toMatch(KEBAB_RE)
    }
  })

  it('every hand-authored fix name matches its filename stem', () => {
    const drift = []
    for (const f of FIXES) {
      if (KNOWN_BROKEN_FILES.has(f.repoRelPath)) continue
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      if (d.name !== f.stem) {
        drift.push({ file: f.repoRelPath, name: d.name, stem: f.stem })
      }
    }
    expect(drift).toEqual([])
  })

  it.fails(
    'KNOWN_BROKEN entries still exhibit drift (self-clearing pin for #3076)',
    () => {
      // Runs the positive checks against the pinned files ONLY. While the
      // drift persists these assertions fail; the `it.fails` wrapper flips
      // that expected-failure into a pass. The moment the file is fixed
      // ALL the assertions pass, the wrapper reports "expected to fail
      // but passed", and the reviewer knows to remove the pin.
      for (const rel of KNOWN_BROKEN_FILES) {
        const f = FIXES.find(x => x.repoRelPath === rel)
        if (!f) continue
        const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
        expect(d.name, `${rel}: name`).toBe(f.stem)
        expect(typeof d.mission?.type, `${rel}: mission.type type`).toBe('string')
        expect(KNOWN_MISSION_TYPES.has(d.mission?.type), `${rel}: mission.type value`).toBe(true)
        expect(typeof d.mission?.description, `${rel}: mission.description type`).toBe('string')
        expect(d.mission.description.trim().length, `${rel}: mission.description non-empty`).toBeGreaterThan(0)
        expect(typeof d.mission?.status, `${rel}: mission.status type`).toBe('string')
        expect(d.mission.status.trim().length, `${rel}: mission.status non-empty`).toBeGreaterThan(0)
      }
    },
  )

  it('every hand-authored fix has a non-empty mission object with title/description/status', () => {
    for (const f of FIXES) {
      if (KNOWN_BROKEN_FILES.has(f.repoRelPath)) continue
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      expect(d.mission, f.repoRelPath).toBeTypeOf('object')
      expect(d.mission, f.repoRelPath).not.toBeNull()
      expect(typeof d.mission.title, f.repoRelPath).toBe('string')
      expect(d.mission.title.trim().length, f.repoRelPath).toBeGreaterThan(0)
      expect(typeof d.mission.description, f.repoRelPath).toBe('string')
      expect(d.mission.description.trim().length, f.repoRelPath).toBeGreaterThan(0)
      expect(typeof d.mission.status, f.repoRelPath).toBe('string')
      expect(d.mission.status.trim().length, f.repoRelPath).toBeGreaterThan(0)
    }
  })

  it('every hand-authored fix has a known mission.type (or is KNOWN_BROKEN)', () => {
    const drift = []
    for (const f of FIXES) {
      if (KNOWN_BROKEN_FILES.has(f.repoRelPath)) continue
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      const t = d.mission?.type
      if (typeof t !== 'string' || !KNOWN_MISSION_TYPES.has(t)) {
        drift.push({ file: f.repoRelPath, type: t })
      }
    }
    expect(drift).toEqual([])
  })

  it('every hand-authored fix mission.steps (when present) is a non-empty array with title+description on each step', () => {
    for (const f of FIXES) {
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      const steps = d.mission?.steps
      if (steps === undefined) continue
      expect(Array.isArray(steps), f.repoRelPath).toBe(true)
      expect(steps.length, f.repoRelPath).toBeGreaterThan(0)
      steps.forEach((s, i) => {
        const label = `${f.repoRelPath} step[${i}]`
        expect(typeof s.title, label).toBe('string')
        expect(s.title.trim().length, label).toBeGreaterThan(0)
        expect(typeof s.description, label).toBe('string')
        expect(s.description.trim().length, label).toBeGreaterThan(0)
      })
    }
  })

  it('every hand-authored fix missionClass (when present) is in the known set', () => {
    for (const f of FIXES) {
      const d = JSON.parse(fs.readFileSync(f.absPath, 'utf8'))
      if (d.missionClass === undefined) continue
      expect(
        KNOWN_MISSION_CLASSES.has(d.missionClass),
        `${f.repoRelPath}: missionClass=${JSON.stringify(d.missionClass)} not in ${[...KNOWN_MISSION_CLASSES].join(',')}`,
      ).toBe(true)
    }
  })
})
