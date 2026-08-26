/**
 * Catalog invariant tests for the three big untested catalog files:
 *
 *   scripts/cncf-projects.mjs   — 217+ CNCF Graduated/Incubating/Sandbox entries
 *   scripts/k8s-platforms.mjs   — Managed K8s services, distributions, local clusters, operators
 *   scripts/other-projects.mjs  — Non-CNCF popular projects
 *
 * These files are pure data. They are consumed by mission generators
 * (generate-cncf-missions, generate-platform-missions, ...) which trust
 * their shape. A silent regression to a catalog — duplicate name,
 * unknown category, missing required field, malformed repo path, orphaned
 * parentProject reference — silently generates wrong missions or breaks
 * downstream file-writes ("category X not in CATEGORY_TO_DIR" being the
 * classic). This suite catches those before generation runs.
 *
 * Nothing here reaches out to the network; every check is a schema /
 * cross-reference invariant computed from the module exports.
 */
import { describe, it, expect } from 'vitest'
import {
  CNCF_PROJECTS,
  CATEGORY_TO_DIR,
} from '../cncf-projects.mjs'
import {
  K8S_PLATFORMS,
  MANAGED_PLATFORMS,
  DISTRIBUTIONS,
  LOCAL_CLUSTERS,
  OPERATORS,
  getPlatformByName,
  getPlatformNames,
} from '../k8s-platforms.mjs'
import {
  OTHER_PROJECTS,
  getOtherProjectByName,
} from '../other-projects.mjs'

// ---------------------------------------------------------------------------
// Shared invariant helpers
// ---------------------------------------------------------------------------

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const REPO_PATH  = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const HTTPS_URL  = /^https:\/\//

// ---------------------------------------------------------------------------
// CNCF_PROJECTS invariants
// ---------------------------------------------------------------------------

describe('CNCF_PROJECTS catalog', () => {
  const VALID_MATURITIES = new Set(['graduated', 'incubating', 'sandbox'])

  it('is non-empty', () => {
    expect(CNCF_PROJECTS.length).toBeGreaterThan(0)
  })

  it('every entry has required fields (name, repo, maturity, category)', () => {
    const missing = []
    for (const p of CNCF_PROJECTS) {
      for (const key of ['name', 'repo', 'maturity', 'category']) {
        if (typeof p[key] !== 'string' || p[key].length === 0) {
          missing.push(`${p.name ?? '<no-name>'}: missing/empty ${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('every name is unique', () => {
    const seen = new Map()
    for (const p of CNCF_PROJECTS) {
      const prev = seen.get(p.name)
      if (prev !== undefined) {
        throw new Error(`duplicate CNCF project name: ${p.name}`)
      }
      seen.set(p.name, true)
    }
    expect(seen.size).toBe(CNCF_PROJECTS.length)
  })

  it('every name is kebab-case (used verbatim in generated file paths)', () => {
    // Existing catalog debt: 5 entries currently have a trailing hyphen
    // because the auto-generator that seeded this file appended a
    // parenthetical (e.g. `Open Policy Agent (OPA)` -> slug ending in
    // '-opa-'). Allowlist locks the debt in place so new entries can
    // never introduce more, and the allowlist can be shrunk as entries
    // are fixed. Filed separately as a data-quality bead.
    const KNOWN_TRAILING_HYPHEN_DEBT = new Set([
      'open-policy-agent-opa-',
      'the-update-framework-tuf-',
      'container-network-interface-cni-',
      'cdk-for-kubernetes-cdk8s-',
      'logging-operator-kube-logging-',
    ])
    const bad = CNCF_PROJECTS
      .filter(p => !KEBAB_CASE.test(p.name))
      .filter(p => !KNOWN_TRAILING_HYPHEN_DEBT.has(p.name))
    expect(bad.map(p => p.name)).toEqual([])
  })

  it('every repo is <owner>/<repo> shaped', () => {
    const bad = CNCF_PROJECTS.filter(p => !REPO_PATH.test(p.repo))
    expect(bad.map(p => `${p.name}=${p.repo}`)).toEqual([])
  })

  it('every maturity is graduated / incubating / sandbox', () => {
    const bad = CNCF_PROJECTS.filter(p => !VALID_MATURITIES.has(p.maturity))
    expect(bad.map(p => `${p.name}=${p.maturity}`)).toEqual([])
  })

  it('every category is present in CATEGORY_TO_DIR (or downstream mission writes will fail)', () => {
    const knownCats = new Set(Object.keys(CATEGORY_TO_DIR))
    const bad = CNCF_PROJECTS.filter(p => !knownCats.has(p.category))
    expect(bad.map(p => `${p.name}=${p.category}`)).toEqual([])
  })

  it('every parentProject (when set) points at another entry in the same catalog', () => {
    const names = new Set(CNCF_PROJECTS.map(p => p.name))
    const orphans = CNCF_PROJECTS
      .filter(p => p.parentProject !== undefined)
      .filter(p => !names.has(p.parentProject))
    expect(orphans.map(p => `${p.name}->${p.parentProject}`)).toEqual([])
  })

  it('no project is its own parent', () => {
    const selfParent = CNCF_PROJECTS.filter(p => p.parentProject === p.name)
    expect(selfParent.map(p => p.name)).toEqual([])
  })

  it('sources.stackoverflow.tags (when present) is a non-empty string[]', () => {
    const bad = []
    for (const p of CNCF_PROJECTS) {
      const tags = p.sources?.stackoverflow?.tags
      if (tags === undefined) continue
      if (!Array.isArray(tags) || tags.length === 0
          || tags.some(t => typeof t !== 'string' || t.length === 0)) {
        bad.push(p.name)
      }
    }
    expect(bad).toEqual([])
  })

  it('sources.reddit.subreddits (when present) is a non-empty string[]', () => {
    const bad = []
    for (const p of CNCF_PROJECTS) {
      const subs = p.sources?.reddit?.subreddits
      if (subs === undefined) continue
      if (!Array.isArray(subs) || subs.length === 0
          || subs.some(s => typeof s !== 'string' || s.length === 0)) {
        bad.push(p.name)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('CATEGORY_TO_DIR', () => {
  it('has string values that are non-empty and slash-free (single directory segment)', () => {
    for (const [cat, dir] of Object.entries(CATEGORY_TO_DIR)) {
      expect(typeof dir).toBe('string')
      expect(dir.length).toBeGreaterThan(0)
      expect(dir).not.toContain('/')
      expect(dir).not.toContain('..')
      expect(dir).not.toContain(cat === 'anything-can-appear' ? '' : ' ')
    }
  })

  it('covers every category used by any CNCF_PROJECTS entry', () => {
    const used = new Set(CNCF_PROJECTS.map(p => p.category))
    const declared = new Set(Object.keys(CATEGORY_TO_DIR))
    const missing = [...used].filter(c => !declared.has(c))
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// K8S_PLATFORMS invariants
// ---------------------------------------------------------------------------

describe('K8S_PLATFORMS catalog', () => {
  const VALID_TYPES = new Set(['managed', 'distribution', 'local', 'operator'])

  it('is non-empty', () => {
    expect(K8S_PLATFORMS.length).toBeGreaterThan(0)
  })

  it('every entry has required fields (name, displayName, repo, type, category, docs)', () => {
    const missing = []
    for (const p of K8S_PLATFORMS) {
      for (const key of ['name', 'displayName', 'repo', 'type', 'category', 'docs']) {
        if (typeof p[key] !== 'string' || p[key].length === 0) {
          missing.push(`${p.name ?? '<no-name>'}: missing/empty ${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('every name is unique', () => {
    const names = K8S_PLATFORMS.map(p => p.name)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dupes).toEqual([])
  })

  it('every name is kebab-case (used verbatim in generated file paths)', () => {
    const bad = K8S_PLATFORMS.filter(p => !KEBAB_CASE.test(p.name))
    expect(bad.map(p => p.name)).toEqual([])
  })

  it('every repo is <owner>/<repo> shaped', () => {
    const bad = K8S_PLATFORMS.filter(p => !REPO_PATH.test(p.repo))
    expect(bad.map(p => `${p.name}=${p.repo}`)).toEqual([])
  })

  it('every type is one of managed/distribution/local/operator', () => {
    const bad = K8S_PLATFORMS.filter(p => !VALID_TYPES.has(p.type))
    expect(bad.map(p => `${p.name}=${p.type}`)).toEqual([])
  })

  it('every docs URL is https', () => {
    const bad = K8S_PLATFORMS.filter(p => !HTTPS_URL.test(p.docs))
    expect(bad.map(p => `${p.name}=${p.docs}`)).toEqual([])
  })

  it('versions and k8sVersions (when present) are non-empty string[]', () => {
    const bad = []
    for (const p of K8S_PLATFORMS) {
      for (const key of ['versions', 'k8sVersions']) {
        const v = p[key]
        if (v === undefined) continue
        if (!Array.isArray(v) || v.length === 0
            || v.some(x => typeof x !== 'string' || x.length === 0)) {
          bad.push(`${p.name}.${key}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('MANAGED_PLATFORMS / DISTRIBUTIONS / LOCAL_CLUSTERS / OPERATORS partition the catalog', () => {
    // Every entry lands in exactly one bucket, and the buckets union to
    // the full catalog. Sanity-check both directions.
    const buckets = [MANAGED_PLATFORMS, DISTRIBUTIONS, LOCAL_CLUSTERS, OPERATORS]
    const union = buckets.flat()
    expect(union.length).toBe(K8S_PLATFORMS.length)
    // Uniqueness across buckets: every name should appear exactly once.
    const names = union.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
    for (const p of K8S_PLATFORMS) {
      expect(union).toContain(p)
    }
  })

  it('MANAGED_PLATFORMS only contains type=managed (and similar for the others)', () => {
    expect(MANAGED_PLATFORMS.every(p => p.type === 'managed')).toBe(true)
    expect(DISTRIBUTIONS.every(p => p.type === 'distribution')).toBe(true)
    expect(LOCAL_CLUSTERS.every(p => p.type === 'local')).toBe(true)
    expect(OPERATORS.every(p => p.type === 'operator')).toBe(true)
  })
})

describe('getPlatformByName / getPlatformNames', () => {
  it('getPlatformNames() returns every name in K8S_PLATFORMS', () => {
    const names = getPlatformNames()
    expect(names).toEqual(K8S_PLATFORMS.map(p => p.name))
  })

  it('getPlatformByName() round-trips every entry', () => {
    for (const p of K8S_PLATFORMS) {
      expect(getPlatformByName(p.name)).toBe(p)
    }
  })

  it('getPlatformByName() returns undefined for an unknown name', () => {
    expect(getPlatformByName('definitely-not-a-platform')).toBeUndefined()
    expect(getPlatformByName('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// OTHER_PROJECTS invariants
// ---------------------------------------------------------------------------

describe('OTHER_PROJECTS catalog', () => {
  it('is non-empty', () => {
    expect(OTHER_PROJECTS.length).toBeGreaterThan(0)
  })

  it('every entry has required fields (name, displayName, repo, type, category)', () => {
    const missing = []
    for (const p of OTHER_PROJECTS) {
      for (const key of ['name', 'displayName', 'repo', 'type', 'category']) {
        if (typeof p[key] !== 'string' || p[key].length === 0) {
          missing.push(`${p.name ?? '<no-name>'}: missing/empty ${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('every name is unique', () => {
    const names = OTHER_PROJECTS.map(p => p.name)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dupes).toEqual([])
  })

  it('every name is kebab-case (used verbatim in generated file paths)', () => {
    const bad = OTHER_PROJECTS.filter(p => !KEBAB_CASE.test(p.name))
    expect(bad.map(p => p.name)).toEqual([])
  })

  it('every repo is <owner>/<repo> shaped', () => {
    const bad = OTHER_PROJECTS.filter(p => !REPO_PATH.test(p.repo))
    expect(bad.map(p => `${p.name}=${p.repo}`)).toEqual([])
  })

  it('every docs URL (when present) is https', () => {
    const bad = OTHER_PROJECTS
      .filter(p => p.docs !== undefined)
      .filter(p => !HTTPS_URL.test(p.docs))
    expect(bad.map(p => `${p.name}=${p.docs}`)).toEqual([])
  })

  it('does not collide with K8S_PLATFORMS names (both catalogs feed the same generator)', () => {
    // generate-platform-missions.mjs processes both catalogs and writes
    // one file per name. A cross-catalog name collision would silently
    // overwrite one mission with the other.
    const k8sNames = new Set(K8S_PLATFORMS.map(p => p.name))
    const collisions = OTHER_PROJECTS.filter(p => k8sNames.has(p.name))
    expect(collisions.map(p => p.name)).toEqual([])
  })
})

describe('getOtherProjectByName', () => {
  it('round-trips every entry', () => {
    for (const p of OTHER_PROJECTS) {
      expect(getOtherProjectByName(p.name)).toBe(p)
    }
  })

  it('returns null for an unknown name (documents current API — differs from getPlatformByName which returns undefined)', () => {
    expect(getOtherProjectByName('definitely-not-a-project')).toBeNull()
    expect(getOtherProjectByName('')).toBeNull()
  })
})
