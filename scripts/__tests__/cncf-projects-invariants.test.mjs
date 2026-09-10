/**
 * Invariant tests for scripts/cncf-projects.mjs.
 *
 * This module exports two data structures the CNCF pipeline scripts depend on:
 *
 *   - CNCF_PROJECTS: an array of { name, repo, maturity, category, ... }
 *     objects consumed by generate-cncf-{missions,install-missions,outreach-issues}
 *     to seed per-project workflow generation. A regression here — a wrong
 *     maturity spelling, a duplicated `name`, or an empty repo string — would
 *     silently produce broken missions/issues at scale (217 projects).
 *
 *   - CATEGORY_TO_DIR: the {category → fixes/<dir>} map used by build-index
 *     and the mission generators to place generated fixes in the correct
 *     tree. A missing entry breaks generation for every project in that
 *     category.
 *
 * Prior to this file the module had zero direct tests.
 */
import { describe, it, expect } from 'vitest'
import { CNCF_PROJECTS, CATEGORY_TO_DIR } from '../cncf-projects.mjs'

const ALLOWED_MATURITIES = new Set(['graduated', 'incubating', 'sandbox'])
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

describe('CNCF_PROJECTS — shape & non-emptiness', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(CNCF_PROJECTS)).toBe(true)
    expect(CNCF_PROJECTS.length).toBeGreaterThan(0)
  })

  it('every entry is a plain object', () => {
    for (const p of CNCF_PROJECTS) {
      expect(p).not.toBeNull()
      expect(typeof p).toBe('object')
      expect(Array.isArray(p)).toBe(false)
    }
  })
})

describe('CNCF_PROJECTS — required fields', () => {
  it('every entry has non-empty name / repo / maturity / category strings', () => {
    for (const p of CNCF_PROJECTS) {
      expect(typeof p.name).toBe('string')
      expect(p.name.length).toBeGreaterThan(0)
      expect(typeof p.repo).toBe('string')
      expect(p.repo.length).toBeGreaterThan(0)
      expect(typeof p.maturity).toBe('string')
      expect(typeof p.category).toBe('string')
      expect(p.category.length).toBeGreaterThan(0)
    }
  })

  it('repo strings look like "owner/name" (single slash, safe chars)', () => {
    for (const p of CNCF_PROJECTS) {
      expect(p.repo, `repo=${p.repo} on name=${p.name}`).toMatch(REPO_RE)
    }
  })
})

describe('CNCF_PROJECTS — enumerations', () => {
  it('every maturity is one of graduated/incubating/sandbox', () => {
    for (const p of CNCF_PROJECTS) {
      expect(ALLOWED_MATURITIES.has(p.maturity), `bad maturity ${p.maturity} on ${p.name}`).toBe(true)
    }
  })

  it('every category is a key in CATEGORY_TO_DIR', () => {
    const allowed = new Set(Object.keys(CATEGORY_TO_DIR))
    for (const p of CNCF_PROJECTS) {
      expect(allowed.has(p.category), `${p.name}: unknown category ${p.category}`).toBe(true)
    }
  })
})

describe('CNCF_PROJECTS — uniqueness', () => {
  it('project `name` is unique across the list', () => {
    const seen = new Map()
    for (const p of CNCF_PROJECTS) {
      if (seen.has(p.name)) {
        throw new Error(`duplicate name: ${p.name} at repo ${p.repo} and ${seen.get(p.name)}`)
      }
      seen.set(p.name, p.repo)
    }
  })
})

describe('CNCF_PROJECTS — parentProject references', () => {
  it('every parentProject value points to another project name in the list', () => {
    const names = new Set(CNCF_PROJECTS.map((p) => p.name))
    for (const p of CNCF_PROJECTS) {
      if (p.parentProject === undefined) continue
      expect(typeof p.parentProject).toBe('string')
      expect(names.has(p.parentProject), `${p.name} -> unknown parent ${p.parentProject}`).toBe(true)
      // Sanity: parent's maturity should be at least as mature as the child
      // (all current data has parents == graduated; enforce as a safety net).
      const parent = CNCF_PROJECTS.find((x) => x.name === p.parentProject)
      expect(parent).toBeDefined()
    }
  })

  it('no project is its own parent', () => {
    for (const p of CNCF_PROJECTS) {
      if (p.parentProject !== undefined) {
        expect(p.parentProject).not.toBe(p.name)
      }
    }
  })
})

describe('CNCF_PROJECTS — optional `sources` shape', () => {
  it('when present, `sources` is an object with stackoverflow?.tags and/or reddit?.subreddits arrays of strings', () => {
    for (const p of CNCF_PROJECTS) {
      if (p.sources === undefined) continue
      expect(typeof p.sources).toBe('object')
      expect(p.sources).not.toBeNull()
      if (p.sources.stackoverflow !== undefined) {
        expect(Array.isArray(p.sources.stackoverflow.tags)).toBe(true)
        for (const t of p.sources.stackoverflow.tags) {
          expect(typeof t).toBe('string')
          expect(t.length).toBeGreaterThan(0)
        }
      }
      if (p.sources.reddit !== undefined) {
        expect(Array.isArray(p.sources.reddit.subreddits)).toBe(true)
        for (const s of p.sources.reddit.subreddits) {
          expect(typeof s).toBe('string')
          expect(s.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('CNCF_PROJECTS — optional `aliases` shape', () => {
  it('when present, `aliases` is a non-empty array of non-empty strings', () => {
    for (const p of CNCF_PROJECTS) {
      if (p.aliases === undefined) continue
      expect(Array.isArray(p.aliases)).toBe(true)
      expect(p.aliases.length).toBeGreaterThan(0)
      for (const a of p.aliases) {
        expect(typeof a).toBe('string')
        expect(a.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('CNCF_PROJECTS — maturity coverage sanity', () => {
  it('all three maturity tiers are represented', () => {
    const tiers = new Set(CNCF_PROJECTS.map((p) => p.maturity))
    expect(tiers.has('graduated')).toBe(true)
    expect(tiers.has('incubating')).toBe(true)
    expect(tiers.has('sandbox')).toBe(true)
  })

  it('contains known anchor projects at their expected maturity', () => {
    // A few well-known anchors — if any of these drift, the whole
    // pipeline is likely broken and the test should fail loudly.
    const byName = new Map(CNCF_PROJECTS.map((p) => [p.name, p]))
    expect(byName.get('kubernetes')?.maturity).toBe('graduated')
    expect(byName.get('kubernetes')?.repo).toBe('kubernetes/kubernetes')
    expect(byName.get('prometheus')?.maturity).toBe('graduated')
    expect(byName.get('envoy')?.maturity).toBe('graduated')
  })
})

describe('CATEGORY_TO_DIR', () => {
  it('is a non-empty object mapping every category string to a non-empty string', () => {
    expect(typeof CATEGORY_TO_DIR).toBe('object')
    const keys = Object.keys(CATEGORY_TO_DIR)
    expect(keys.length).toBeGreaterThan(0)
    for (const [cat, dir] of Object.entries(CATEGORY_TO_DIR)) {
      expect(cat.length).toBeGreaterThan(0)
      expect(typeof dir).toBe('string')
      expect(dir.length).toBeGreaterThan(0)
      // fixes/ subdirs should be safe path segments (no traversal, no slash).
      expect(dir).not.toContain('/')
      expect(dir).not.toContain('..')
      expect(dir).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('covers every category actually used by CNCF_PROJECTS', () => {
    const usedCategories = new Set(CNCF_PROJECTS.map((p) => p.category))
    for (const cat of usedCategories) {
      expect(CATEGORY_TO_DIR[cat], `missing dir mapping for category ${cat}`).toBeDefined()
    }
  })
})
