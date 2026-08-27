/**
 * Repo-integrity invariants for the shipped runbooks/*.json catalog and
 * the fixes/index.json build artifact that indexes them alongside
 * fixes/**\/*.json.
 *
 * The existing scripts/__tests__/catalog-invariants.test.mjs covers the
 * three JS-module catalogs (cncf-projects, k8s-platforms, other-projects),
 * but nothing exercises the runbook JSON catalog under runbooks/ or the
 * fixes/index.json roll-up produced by scripts/build-index.mjs.
 *
 * A silent regression in a shipped runbook — non-conforming mission
 * envelope, duplicate step id, missing step title/description, an
 * off-schema mission.type — reaches consumers (console mission runner,
 * search index) untouched and only fails at execution time.  Likewise a
 * stale fixes/index.json (someone adds/moves a fix file but forgets to
 * regenerate the index) silently ships a broken catalog to the console.
 *
 * Every check here is a pure filesystem read over the checked-in tree;
 * no network, no build.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT   = path.resolve(path.dirname(__filename), '../..')
const RUNBOOKS_DIR = path.join(REPO_ROOT, 'runbooks')
const FIXES_DIR    = path.join(REPO_ROOT, 'fixes')
const FIXES_INDEX  = path.join(FIXES_DIR, 'index.json')

const KEBAB_CASE  = /^[a-z0-9]+(-[a-z0-9]+)*$/
// A step id looks like "step-05-verify-access" or, for inserted guards,
// "step-05b-cluster-stability-guard".  The numeric part may carry a
// single lowercase alpha suffix.
const STEP_ID_RE  = /^step-(\d+)[a-z]?-[a-z0-9]+(-[a-z0-9]+)*$/

const RUNBOOK_MISSION_TYPES = new Set([
  'audit', 'deploy', 'maintain', 'recover', 'restore', 'rollback', 'upgrade',
])

function listRunbookFiles () {
  if (!fs.existsSync(RUNBOOKS_DIR)) return []
  return fs.readdirSync(RUNBOOKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

function readJson (abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf-8'))
}

function walkJsonFiles (root) {
  // Return every `*.json` under `root` except the index.json at the top level.
  const out = []
  function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (path.relative(root, abs) === 'index.json') continue
        out.push(abs)
      }
    }
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------------------
// runbooks/*.json envelope invariants
// ---------------------------------------------------------------------------

describe('runbooks/ catalog envelope', () => {
  const files = listRunbookFiles()

  it('runbooks/ directory contains at least one runbook', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('every runbook is valid JSON', () => {
    for (const f of files) {
      expect(() => readJson(path.join(RUNBOOKS_DIR, f))).not.toThrow()
    }
  })

  it('every runbook declares version="kc-mission-v1" and missionClass="runbook"', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      if (doc.version !== 'kc-mission-v1') {
        offenders.push(`${f}: version=${JSON.stringify(doc.version)}`)
      }
      if (doc.missionClass !== 'runbook') {
        offenders.push(`${f}: missionClass=${JSON.stringify(doc.missionClass)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every runbook has non-empty top-level author fields', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      for (const key of ['author', 'authorGithub']) {
        if (typeof doc[key] !== 'string' || doc[key].length === 0) {
          offenders.push(`${f}: missing/empty ${key}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every runbook `name` is kebab-case and matches "runbook-<file-stem>"', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      if (typeof doc.name !== 'string' || !KEBAB_CASE.test(doc.name)) {
        offenders.push(`${f}: name is not kebab-case: ${JSON.stringify(doc.name)}`)
        continue
      }
      const stem = f.replace(/\.json$/, '')
      if (doc.name !== `runbook-${stem}`) {
        offenders.push(`${f}: name=${JSON.stringify(doc.name)} does not match runbook-${stem}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every runbook `name` is unique across the catalog', () => {
    const seen = new Set()
    const dups = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      if (seen.has(doc.name)) dups.push(doc.name)
      seen.add(doc.name)
    }
    expect(dups).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runbooks/*.json mission body invariants
// ---------------------------------------------------------------------------

describe('runbooks/ mission body', () => {
  const files = listRunbookFiles()

  it('every runbook has a non-empty mission with title, description, type, status', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const m = doc.mission
      if (!m || typeof m !== 'object') {
        offenders.push(`${f}: missing mission object`)
        continue
      }
      for (const key of ['title', 'description', 'type', 'status']) {
        if (typeof m[key] !== 'string' || m[key].length === 0) {
          offenders.push(`${f}: missing/empty mission.${key}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every mission.type is in the known runbook type set', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const t = doc.mission?.type
      if (!RUNBOOK_MISSION_TYPES.has(t)) {
        offenders.push(`${f}: mission.type=${JSON.stringify(t)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every runbook has at least one step', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const steps = doc.mission?.steps
      if (!Array.isArray(steps) || steps.length === 0) {
        offenders.push(`${f}: mission.steps missing or empty`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every step has id, title, description', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const steps = doc.mission?.steps ?? []
      steps.forEach((s, i) => {
        for (const key of ['id', 'title', 'description']) {
          if (typeof s?.[key] !== 'string' || s[key].length === 0) {
            offenders.push(`${f}[step ${i}]: missing/empty ${key}`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('every step id matches step-<NN>[a-z]?-<kebab-slug>', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const steps = doc.mission?.steps ?? []
      for (const s of steps) {
        if (typeof s?.id === 'string' && !STEP_ID_RE.test(s.id)) {
          offenders.push(`${f}: bad step id ${JSON.stringify(s.id)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('step ids are unique within each runbook', () => {
    const offenders = []
    for (const f of files) {
      const doc = readJson(path.join(RUNBOOKS_DIR, f))
      const ids = (doc.mission?.steps ?? []).map((s) => s?.id)
      const seen = new Set()
      for (const id of ids) {
        if (seen.has(id)) offenders.push(`${f}: duplicate step id ${JSON.stringify(id)}`)
        seen.add(id)
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// fixes/index.json ↔ shipped catalog integrity
// ---------------------------------------------------------------------------

describe('fixes/index.json integrity', () => {
  if (!fs.existsSync(FIXES_INDEX)) {
    it.skip('fixes/index.json not present', () => {})
    return
  }

  const idx = readJson(FIXES_INDEX)

  it('has version and generatedAt, and count matches missions length', () => {
    expect(typeof idx.version).toBe('number')
    expect(typeof idx.generatedAt).toBe('string')
    expect(idx.generatedAt.length).toBeGreaterThan(0)
    expect(idx.count).toBe(idx.missions.length)
  })

  it('every indexed mission.path resolves to a file that exists in the repo', () => {
    const missing = []
    for (const m of idx.missions) {
      const abs = path.join(REPO_ROOT, m.path)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        missing.push(m.path)
      }
    }
    expect(missing).toEqual([])
  })

  it('every shipped fixes/**/*.json is registered in the index', () => {
    const shipped = walkJsonFiles(FIXES_DIR).map((abs) => path.relative(REPO_ROOT, abs))
    const registered = new Set(idx.missions.map((m) => m.path))
    const orphaned = shipped.filter((p) => !registered.has(p))
    expect(orphaned).toEqual([])
  })

  it('every shipped runbooks/*.json is registered in the index', () => {
    if (!fs.existsSync(RUNBOOKS_DIR)) return
    const shipped = fs.readdirSync(RUNBOOKS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join('runbooks', f))
    const registered = new Set(idx.missions.map((m) => m.path))
    const orphaned = shipped.filter((p) => !registered.has(p))
    expect(orphaned).toEqual([])
  })

  it('mission paths in the index are unique', () => {
    const seen = new Set()
    const dups = []
    for (const m of idx.missions) {
      if (seen.has(m.path)) dups.push(m.path)
      seen.add(m.path)
    }
    expect(dups).toEqual([])
  })

  it('every indexed mission has title, description, category, missionClass', () => {
    const offenders = []
    for (const m of idx.missions) {
      for (const key of ['title', 'description', 'category', 'missionClass']) {
        if (typeof m[key] !== 'string' || m[key].length === 0) {
          offenders.push(`${m.path}: missing/empty ${key}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Helper regex direct tests — guarantees a helper-parsing regression
// cannot silently make the whole-repo suites vacuous.
// ---------------------------------------------------------------------------

describe('runbook-catalog helper regex', () => {
  it('KEBAB_CASE accepts single-token and multi-hyphen kebab', () => {
    expect(KEBAB_CASE.test('a')).toBe(true)
    expect(KEBAB_CASE.test('runbook-node-drain')).toBe(true)
    expect(KEBAB_CASE.test('cncf-generated-akri-85')).toBe(true)
  })

  it('KEBAB_CASE rejects CamelCase, snake_case, empty and trailing hyphens', () => {
    for (const bad of ['NodeDrain', 'node_drain', '', 'node-', '-node', 'Node-Drain', 'NODE-DRAIN']) {
      expect(KEBAB_CASE.test(bad), `unexpected match: ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('STEP_ID_RE accepts step-01-foo and step-05b-cluster-stability-guard', () => {
    expect(STEP_ID_RE.test('step-01-foo')).toBe(true)
    expect(STEP_ID_RE.test('step-05b-cluster-stability-guard')).toBe(true)
    expect(STEP_ID_RE.test('step-100-verify-access')).toBe(true)
  })

  it('STEP_ID_RE rejects missing prefix, missing slug, uppercase, and multi-letter suffix', () => {
    for (const bad of [
      '01-foo', 'step-foo', 'step-01', 'step-01-', 'Step-01-foo',
      'step-5-Verify', 'step-05ab-foo',
    ]) {
      expect(STEP_ID_RE.test(bad), `unexpected match: ${JSON.stringify(bad)}`).toBe(false)
    }
  })
})
