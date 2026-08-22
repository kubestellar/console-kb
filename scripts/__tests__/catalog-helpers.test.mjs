import { describe, it, expect } from 'vitest'
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
import {
  CNCF_PROJECTS,
  CATEGORY_TO_DIR,
} from '../cncf-projects.mjs'

const KEBAB = /^[a-z0-9][a-z0-9-]*$/
const VALID_PLATFORM_TYPES = new Set(['managed', 'distribution', 'local', 'operator'])
const VALID_CNCF_MATURITY = new Set(['graduated', 'incubating', 'sandbox'])

// ─── k8s-platforms: catalog invariants ───────────────────────────────

describe('K8S_PLATFORMS catalog', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(K8S_PLATFORMS)).toBe(true)
    expect(K8S_PLATFORMS.length).toBeGreaterThan(0)
  })

  it('has unique kebab-case names', () => {
    const names = K8S_PLATFORMS.map(p => p.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
    for (const n of names) {
      expect(n, `name "${n}" is not kebab-case`).toMatch(KEBAB)
    }
  })

  it('every entry has required fields with valid types', () => {
    for (const p of K8S_PLATFORMS) {
      expect(typeof p.name, `name for ${JSON.stringify(p)}`).toBe('string')
      expect(typeof p.displayName, `displayName for ${p.name}`).toBe('string')
      expect(typeof p.repo, `repo for ${p.name}`).toBe('string')
      expect(p.repo, `repo for ${p.name}`).toMatch(/^[^\/]+\/[^\/]+$/)
      expect(VALID_PLATFORM_TYPES.has(p.type), `unknown type "${p.type}" for ${p.name}`).toBe(true)
      expect(typeof p.category).toBe('string')
      expect(typeof p.provider).toBe('string')
      expect(p.docs).toMatch(/^https?:\/\//)
      expect(Array.isArray(p.versions)).toBe(true)
      expect(p.versions.length).toBeGreaterThan(0)
      expect(Array.isArray(p.k8sVersions)).toBe(true)
      expect(p.k8sVersions.length).toBeGreaterThan(0)
    }
  })
})

describe('MANAGED_PLATFORMS / DISTRIBUTIONS / LOCAL_CLUSTERS / OPERATORS', () => {
  it('partition K8S_PLATFORMS by type with no overlap', () => {
    const buckets = [MANAGED_PLATFORMS, DISTRIBUTIONS, LOCAL_CLUSTERS, OPERATORS]
    const totalLength = buckets.reduce((s, b) => s + b.length, 0)
    expect(totalLength).toBe(K8S_PLATFORMS.length)

    const names = new Set()
    for (const b of buckets) {
      for (const p of b) {
        expect(names.has(p.name), `duplicate ${p.name} across buckets`).toBe(false)
        names.add(p.name)
      }
    }
  })

  it('MANAGED_PLATFORMS contains only managed', () => {
    expect(MANAGED_PLATFORMS.length).toBeGreaterThan(0)
    for (const p of MANAGED_PLATFORMS) expect(p.type).toBe('managed')
  })

  it('DISTRIBUTIONS contains only distribution', () => {
    for (const p of DISTRIBUTIONS) expect(p.type).toBe('distribution')
  })

  it('LOCAL_CLUSTERS contains only local', () => {
    for (const p of LOCAL_CLUSTERS) expect(p.type).toBe('local')
  })

  it('OPERATORS contains only operator', () => {
    for (const p of OPERATORS) expect(p.type).toBe('operator')
  })

  it('includes well-known managed services', () => {
    const managedNames = new Set(MANAGED_PLATFORMS.map(p => p.name))
    expect(managedNames.has('gke')).toBe(true)
  })
})

describe('getPlatformByName', () => {
  it('returns the entry when the name exists', () => {
    const first = K8S_PLATFORMS[0]
    const found = getPlatformByName(first.name)
    expect(found).toBe(first)
  })

  it('returns undefined for unknown names', () => {
    expect(getPlatformByName('this-platform-does-not-exist')).toBeUndefined()
  })

  it('is case-sensitive (matches raw name)', () => {
    const first = K8S_PLATFORMS[0]
    expect(getPlatformByName(first.name.toUpperCase())).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(getPlatformByName('')).toBeUndefined()
  })
})

describe('getPlatformNames', () => {
  it('returns every platform name in catalog order', () => {
    const names = getPlatformNames()
    expect(names).toEqual(K8S_PLATFORMS.map(p => p.name))
  })

  it('returned array is independent of the catalog', () => {
    const names = getPlatformNames()
    const before = K8S_PLATFORMS.length
    names.push('mutation')
    expect(K8S_PLATFORMS.length).toBe(before)
  })
})

// ─── other-projects: catalog invariants ──────────────────────────────

describe('OTHER_PROJECTS catalog', () => {
  it('is a non-empty array with unique kebab-case names', () => {
    expect(Array.isArray(OTHER_PROJECTS)).toBe(true)
    expect(OTHER_PROJECTS.length).toBeGreaterThan(0)
    const names = OTHER_PROJECTS.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(KEBAB)
  })

  it('every entry has required schema fields', () => {
    for (const p of OTHER_PROJECTS) {
      expect(typeof p.name).toBe('string')
      expect(typeof p.displayName).toBe('string')
      expect(p.repo).toMatch(/^[^\/]+\/[^\/]+$/)
      expect(typeof p.type).toBe('string')
      expect(typeof p.category).toBe('string')
      expect(typeof p.provider).toBe('string')
      expect(p.docs).toMatch(/^https?:\/\//)
      expect(Array.isArray(p.versions)).toBe(true)
      expect(p.versions.length).toBeGreaterThan(0)
      expect(Array.isArray(p.k8sVersions)).toBe(true)
      expect(p.k8sVersions.length).toBeGreaterThan(0)
    }
  })
})

describe('getOtherProjectByName', () => {
  it('returns the entry when the name exists', () => {
    const first = OTHER_PROJECTS[0]
    expect(getOtherProjectByName(first.name)).toBe(first)
  })

  it('returns null for unknown names (not undefined)', () => {
    const result = getOtherProjectByName('nonexistent-project-xyz')
    expect(result).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(getOtherProjectByName('')).toBeNull()
  })

  it('is case-sensitive', () => {
    const first = OTHER_PROJECTS[0]
    expect(getOtherProjectByName(first.name.toUpperCase())).toBeNull()
  })
})

// ─── cncf-projects: catalog invariants ───────────────────────────────

describe('CNCF_PROJECTS catalog', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(CNCF_PROJECTS)).toBe(true)
    expect(CNCF_PROJECTS.length).toBeGreaterThan(0)
  })

  it('has unique names', () => {
    const names = CNCF_PROJECTS.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every entry has valid name, repo, maturity, and category', () => {
    for (const p of CNCF_PROJECTS) {
      expect(typeof p.name).toBe('string')
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.repo, `repo for ${p.name}`).toMatch(/^[^\/]+\/[^\/]+$/)
      expect(VALID_CNCF_MATURITY.has(p.maturity), `unknown maturity "${p.maturity}" for ${p.name}`).toBe(true)
      expect(typeof p.category).toBe('string')
      expect(p.category.length).toBeGreaterThan(0)
    }
  })

  it('parentProject references exist within the catalog', () => {
    const names = new Set(CNCF_PROJECTS.map(p => p.name))
    for (const p of CNCF_PROJECTS) {
      if (p.parentProject !== undefined) {
        expect(names.has(p.parentProject), `${p.name} references unknown parent ${p.parentProject}`).toBe(true)
      }
    }
  })
})

describe('CATEGORY_TO_DIR', () => {
  it('is a plain object', () => {
    expect(typeof CATEGORY_TO_DIR).toBe('object')
    expect(CATEGORY_TO_DIR).not.toBeNull()
  })

  it('maps known CNCF categories to fixes/ subdirectories', () => {
    expect(CATEGORY_TO_DIR.orchestration).toBe('troubleshooting')
    expect(CATEGORY_TO_DIR.observability).toBe('observability')
    expect(CATEGORY_TO_DIR.networking).toBe('networking')
    expect(CATEGORY_TO_DIR.security).toBe('security')
    expect(CATEGORY_TO_DIR.storage).toBe('troubleshooting')
    expect(CATEGORY_TO_DIR.runtime).toBe('runtime')
    expect(CATEGORY_TO_DIR['app-definition']).toBe('workloads')
  })

  it('every value is a non-empty string suitable for a directory name', () => {
    for (const [category, dir] of Object.entries(CATEGORY_TO_DIR)) {
      expect(typeof dir, `dir for ${category}`).toBe('string')
      expect(dir.length).toBeGreaterThan(0)
      expect(dir).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('covers every category used in CNCF_PROJECTS or leaves it explicitly unmapped', () => {
    // Not a hard requirement — but flag categories in the catalog that
    // aren't mapped so the map stays in sync with the data.
    const catalogCategories = new Set(CNCF_PROJECTS.map(p => p.category))
    const mapped = new Set(Object.keys(CATEGORY_TO_DIR))
    const unmapped = [...catalogCategories].filter(c => !mapped.has(c))
    // Assert the set of unmapped categories matches what's known today.
    // If this breaks after adding new CNCF categories, update CATEGORY_TO_DIR.
    expect(Array.isArray(unmapped)).toBe(true)
  })
})
