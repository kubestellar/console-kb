/**
 * Repo-integrity invariants for the hand-authored fixes/*.json catalog.
 *
 * Covers every fixes/**\/*.json NOT under the machine-generated sub-trees
 * (cncf-generated/, cncf-install/, platform-install/).  The generated
 * sub-trees have their own dedicated invariant coverage.
 *
 * Invariants enforced here mirror runbook-catalog-invariants.test.mjs:
 *
 *   - version === "kc-mission-v1"
 *   - name matches ^[a-z0-9]+(-[a-z0-9]+)*$ (kebab-case)
 *   - name equals the filename stem
 *   - mission is a non-empty object
 *   - mission.title, mission.description, mission.status are non-empty strings
 *   - mission.type is present and non-empty
 *   - mission.steps, when present, is a non-empty array with title+description on each step
 *   - missionClass when present is in the known set
 *
 * Tracked bugs fixed in kubestellar/console-kb#3076.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')
const FIXES_DIR = path.join(REPO_ROOT, 'fixes')

// Sub-trees that are machine-generated and covered by separate invariants.
const EXCLUDED_SUBTREES = new Set(['cncf-generated', 'cncf-install', 'platform-install'])

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const KNOWN_MISSION_CLASSES = new Set(['install', 'fixer', 'orbit', 'backup', 'troubleshoot'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkHandAuthoredFiles(root) {
  const out = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const rel = path.relative(root, abs)
        if (EXCLUDED_SUBTREES.has(rel)) continue
        walk(abs)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (entry.name === 'index.json') continue
        out.push(abs)
      }
    }
  }
  walk(root)
  return out.sort()
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf-8'))
}

// ---------------------------------------------------------------------------
// Invariant suite
// ---------------------------------------------------------------------------

describe('hand-authored fixes/ catalog envelope', () => {
  const files = walkHandAuthoredFiles(FIXES_DIR)

  it('fixes/ hand-authored tree contains at least one file', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('every file has version === "kc-mission-v1"', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      if (doc.version !== 'kc-mission-v1') {
        offenders.push(`${path.relative(REPO_ROOT, abs)}: version=${JSON.stringify(doc.version)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every file has a kebab-case name', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      if (typeof doc.name !== 'string' || !KEBAB_CASE.test(doc.name)) {
        offenders.push(`${path.relative(REPO_ROOT, abs)}: name=${JSON.stringify(doc.name)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every name matches the filename stem', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      const stem = path.basename(abs, '.json')
      if (doc.name !== stem) {
        offenders.push(
          `${path.relative(REPO_ROOT, abs)}: name=${JSON.stringify(doc.name)} ≠ stem=${JSON.stringify(stem)}`,
        )
      }
    }
    expect(offenders).toEqual([])
  })

  it('every file has a non-empty mission object', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      if (typeof doc.mission !== 'object' || doc.mission === null || Array.isArray(doc.mission)) {
        offenders.push(`${path.relative(REPO_ROOT, abs)}: mission is not an object`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every mission has non-empty title, description, status', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      const m = doc.mission ?? {}
      for (const key of ['title', 'description', 'status']) {
        if (typeof m[key] !== 'string' || m[key].trim().length === 0) {
          offenders.push(`${path.relative(REPO_ROOT, abs)}: mission.${key} missing/empty`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every mission has a non-empty type', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      const t = doc.mission?.type
      if (typeof t !== 'string' || t.trim().length === 0) {
        offenders.push(`${path.relative(REPO_ROOT, abs)}: mission.type missing/empty`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('mission.steps, when present, is a non-empty array and every step has title+description', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      const steps = doc.mission?.steps
      if (steps === undefined) continue
      if (!Array.isArray(steps) || steps.length === 0) {
        offenders.push(`${path.relative(REPO_ROOT, abs)}: mission.steps is present but empty/non-array`)
        continue
      }
      steps.forEach((s, i) => {
        for (const key of ['title', 'description']) {
          if (typeof s?.[key] !== 'string' || s[key].trim().length === 0) {
            offenders.push(`${path.relative(REPO_ROOT, abs)}[step ${i}]: missing/empty ${key}`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('missionClass, when present, is a known value', () => {
    const offenders = []
    for (const abs of files) {
      const doc = readJson(abs)
      if (doc.missionClass !== undefined && !KNOWN_MISSION_CLASSES.has(doc.missionClass)) {
        offenders.push(
          `${path.relative(REPO_ROOT, abs)}: unknown missionClass=${JSON.stringify(doc.missionClass)}`,
        )
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Helper direct tests — ensure helper parsing cannot silently vacuate the suite.
// ---------------------------------------------------------------------------

describe('hand-authored-fix helper utilities', () => {
  it('KEBAB_CASE accepts valid kebab slugs', () => {
    for (const good of ['a', 'fix-foo', 'install-llmd-benchmark', 'cve-2026-3864-nfs-csi-path-traversal']) {
      expect(KEBAB_CASE.test(good), `expected match: ${JSON.stringify(good)}`).toBe(true)
    }
  })

  it('KEBAB_CASE rejects CamelCase, snake_case, empty, and trailing hyphens', () => {
    for (const bad of ['CamelCase', 'snake_case', '', 'trailing-', '-leading', 'MiXeD-case']) {
      expect(KEBAB_CASE.test(bad), `unexpected match: ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('walkHandAuthoredFiles excludes cncf-generated, cncf-install, platform-install', () => {
    const files = walkHandAuthoredFiles(FIXES_DIR)
    for (const abs of files) {
      const rel = path.relative(FIXES_DIR, abs)
      const first = rel.split(path.sep)[0]
      expect(EXCLUDED_SUBTREES.has(first), `unexpected file from excluded subtree: ${rel}`).toBe(false)
    }
  })

  it('walkHandAuthoredFiles excludes index.json', () => {
    const files = walkHandAuthoredFiles(FIXES_DIR)
    const names = files.map(f => path.basename(f))
    expect(names).not.toContain('index.json')
  })
})
