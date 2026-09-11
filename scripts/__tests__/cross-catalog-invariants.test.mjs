/**
 * Cross-catalog invariant tests for the three data catalogs consumed by
 * mission generators:
 *
 *   scripts/cncf-projects.mjs   — CNCF Graduated/Incubating/Sandbox
 *   scripts/k8s-platforms.mjs   — K8s services, distros, local clusters, operators
 *   scripts/other-projects.mjs  — Non-CNCF projects
 *
 * `scripts/__tests__/catalog-invariants.test.mjs` covers per-file shape
 * (required fields, kebab-case name, https docs, ...) and a single
 * cross-catalog rule: K8S_PLATFORMS ∩ OTHER_PROJECTS by name = ∅.
 *
 * This suite adds the *remaining* cross-catalog invariants that the
 * mission generators quietly depend on:
 *
 *   generate-cncf-missions.mjs:1441
 *       ALL_PROJECTS = [...CNCF_PROJECTS, ...OTHER_PROJECTS.map(...)]
 *   generate-platform-missions.mjs:508
 *       platforms = [...K8S_PLATFORMS, ...OTHER_PROJECTS]
 *
 * Both merge by .name and downstream write one mission file per name.
 * Both compute `CATEGORY_TO_DIR[category]` to pick a fixes/ subdirectory
 * (undefined key = broken path). A silent regression to any of those
 * invariants would corrupt generated output without failing CI.
 *
 * Each of the current-state violations found on master when this suite
 * was authored is captured in a NAMED KNOWN_*_DEBT allowlist so:
 *   - the tests pass today (they lock the current shape in place)
 *   - every NEW collision or unmapped category is caught immediately
 *   - the allowlists are shrinkable: entries can be deleted as the
 *     underlying catalog debt is fixed
 *
 * Filed as a separate quality issue tracking the underlying data debt:
 * kubestellar/console-kb#3277 (this PR only locks in the current state
 * and catches new regressions — it does NOT curate the catalogs).
 */
import { describe, it, expect } from 'vitest'
import { CNCF_PROJECTS, CATEGORY_TO_DIR } from '../cncf-projects.mjs'
import { K8S_PLATFORMS } from '../k8s-platforms.mjs'
import { OTHER_PROJECTS } from '../other-projects.mjs'

// ---------------------------------------------------------------------------
// Known debt allowlists — captured from master at test-authoring time.
// Shrink these lists as the catalogs are cleaned up; do NOT grow them.
// ---------------------------------------------------------------------------

// Names that appear in BOTH CNCF_PROJECTS and OTHER_PROJECTS. The second
// merge wins in generate-cncf-missions.mjs's ALL_PROJECTS, so today
// OTHER_PROJECTS silently clobbers the CNCF entry for these.
const KNOWN_CNCF_OTHER_NAME_COLLISIONS = new Set([
  'kubeflow',
  'dragonfly',
  'nats',
  'keycloak',
  'backstage',
  'harbor',
])

// Names that appear in BOTH CNCF_PROJECTS and K8S_PLATFORMS. No current
// generator merges these two, but they are conflated frequently enough
// in issues that "new entry with an existing name" is a real risk to
// lock down now, before someone adds a generator that does merge them.
const KNOWN_CNCF_K8S_NAME_COLLISIONS = new Set([
  'k3s',
  'k0s',
  'metallb',
  'kyverno',
])

// Repos that appear twice within CNCF_PROJECTS. fetch-cncf-landscape.mjs
// dedupes by repo when regenerating, but cncf-projects.mjs is committed
// source that accepts curation edits. Today linkerd/linkerd2 backs both
// `linkerd` (top-level) and `linkerd-viz` (sub-project entry).
const KNOWN_CNCF_INTERNAL_REPO_DUPES = new Set([
  'linkerd/linkerd2',
])

// Repos shared between CNCF_PROJECTS and OTHER_PROJECTS. These are the
// same upstream projects with slightly different mission configs, which
// double-crawls the same GitHub repo. Locking in current state.
const KNOWN_CNCF_OTHER_REPO_COLLISIONS = new Set([
  'kubeflow/kubeflow',
  'nats-io/nats-server',
  'keycloak/keycloak',
  'backstage/backstage',
  'goharbor/harbor',
])

// OTHER_PROJECTS category values that are NOT keys in CATEGORY_TO_DIR.
// generate-cncf-missions.mjs merges OTHER_PROJECTS with the CNCF pipeline,
// and downstream `dir = CATEGORY_TO_DIR[category]` returns undefined for
// each of these, so any code that then does `join(FIXES_DIR, dir, ...)`
// gets a broken path. Locking in current state; grow CATEGORY_TO_DIR (or
// remap these to an existing key) to shrink the list.
const KNOWN_UNMAPPED_OTHER_CATEGORIES = new Set([
  'ai-agents', 'llm-serving', 'llm-gateway', 'ml-platform', 'ai-app',
  'analytics-db', 'vector-db', 'cache', 'multi-model-db', 'streaming',
  'messaging', 'api-gateway', 'ingress', 'web-server', 'git-hosting',
  'ci-cd', 'apm', 'monitoring', 'identity', 'secrets', 'service-mesh',
  'runtime-security', 'object-storage', 'distributed-storage', 'workflow',
  'workflow-engine', 'developer-portal', 'container-registry',
])

// ---------------------------------------------------------------------------
// Name collisions across catalogs merged by generate-cncf-missions.mjs
// ---------------------------------------------------------------------------

describe('cross-catalog name collisions (generate-cncf-missions.mjs merge)', () => {
  it('CNCF_PROJECTS ∩ OTHER_PROJECTS by name has no NEW collisions', () => {
    const cncfNames = new Set(CNCF_PROJECTS.map(p => p.name))
    const collisions = OTHER_PROJECTS
      .map(p => p.name)
      .filter(n => cncfNames.has(n))
      .filter(n => !KNOWN_CNCF_OTHER_NAME_COLLISIONS.has(n))
    expect(collisions).toEqual([])
  })

  it('KNOWN_CNCF_OTHER_NAME_COLLISIONS allowlist stays honest (every listed name is still a collision)', () => {
    // Guard against the allowlist bit-rotting: if a name is fixed in one
    // of the catalogs, drop it from the allowlist so we don't silently
    // permit re-introduction later.
    const cncfNames = new Set(CNCF_PROJECTS.map(p => p.name))
    const otherNames = new Set(OTHER_PROJECTS.map(p => p.name))
    const stale = [...KNOWN_CNCF_OTHER_NAME_COLLISIONS]
      .filter(n => !(cncfNames.has(n) && otherNames.has(n)))
    expect(stale).toEqual([])
  })

  it('CNCF_PROJECTS ∩ K8S_PLATFORMS by name has no NEW collisions', () => {
    // No current generator merges these two, but the projects overlap
    // in the wild ('k3s' is both a CNCF-adjacent project and a K8s
    // distribution here). Locking "no NEW collision" in now means any
    // future generator that merges them won't reintroduce the same
    // silent-clobber problem this test file exists to prevent.
    const cncfNames = new Set(CNCF_PROJECTS.map(p => p.name))
    const collisions = K8S_PLATFORMS
      .map(p => p.name)
      .filter(n => cncfNames.has(n))
      .filter(n => !KNOWN_CNCF_K8S_NAME_COLLISIONS.has(n))
    expect(collisions).toEqual([])
  })

  it('KNOWN_CNCF_K8S_NAME_COLLISIONS allowlist stays honest', () => {
    const cncfNames = new Set(CNCF_PROJECTS.map(p => p.name))
    const k8sNames = new Set(K8S_PLATFORMS.map(p => p.name))
    const stale = [...KNOWN_CNCF_K8S_NAME_COLLISIONS]
      .filter(n => !(cncfNames.has(n) && k8sNames.has(n)))
    expect(stale).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Repo collisions — any generator keying on repo would double-count,
// and any GitHub-crawl step would double-fetch the same upstream.
// ---------------------------------------------------------------------------

describe('cross-catalog repo collisions', () => {
  it('CNCF_PROJECTS has no NEW internal repo duplicates', () => {
    const seen = new Map()
    const dupes = []
    for (const p of CNCF_PROJECTS) {
      if (seen.has(p.repo)) {
        if (!KNOWN_CNCF_INTERNAL_REPO_DUPES.has(p.repo)) {
          dupes.push(`${p.name}=${p.repo} (also ${seen.get(p.repo)})`)
        }
      } else {
        seen.set(p.repo, p.name)
      }
    }
    expect(dupes).toEqual([])
  })

  it('CNCF_PROJECTS ∩ OTHER_PROJECTS by repo has no NEW collisions', () => {
    const cncfRepos = new Map(CNCF_PROJECTS.map(p => [p.repo, p.name]))
    const collisions = OTHER_PROJECTS
      .filter(p => cncfRepos.has(p.repo))
      .filter(p => !KNOWN_CNCF_OTHER_REPO_COLLISIONS.has(p.repo))
      .map(p => `${p.name}=${p.repo} (also ${cncfRepos.get(p.repo)})`)
    expect(collisions).toEqual([])
  })

  it('KNOWN_CNCF_OTHER_REPO_COLLISIONS allowlist stays honest', () => {
    const cncfRepos = new Set(CNCF_PROJECTS.map(p => p.repo))
    const otherRepos = new Set(OTHER_PROJECTS.map(p => p.repo))
    const stale = [...KNOWN_CNCF_OTHER_REPO_COLLISIONS]
      .filter(r => !(cncfRepos.has(r) && otherRepos.has(r)))
    expect(stale).toEqual([])
  })

  it('K8S_PLATFORMS ∩ OTHER_PROJECTS by repo is empty (no known debt)', () => {
    // Already clean on master; no allowlist. If this ever fires, add a
    // KNOWN_K8S_OTHER_REPO_COLLISIONS allowlist and file a bead.
    const k8sRepos = new Map(K8S_PLATFORMS.map(p => [p.repo, p.name]))
    const collisions = OTHER_PROJECTS
      .filter(p => k8sRepos.has(p.repo))
      .map(p => `${p.name}=${p.repo} (also ${k8sRepos.get(p.repo)})`)
    expect(collisions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// OTHER_PROJECTS shape guarantees needed by the CNCF-side pipeline
// ---------------------------------------------------------------------------

describe('OTHER_PROJECTS pipeline compatibility', () => {
  it('has no NEW category values that are missing from CATEGORY_TO_DIR', () => {
    // generate-cncf-missions.mjs merges OTHER_PROJECTS into ALL_PROJECTS,
    // and downstream `dir = CATEGORY_TO_DIR[category]` returns undefined
    // for any category that isn't a key. Locking in current state; any
    // NEW OTHER_PROJECTS category not in either CATEGORY_TO_DIR or the
    // known-debt allowlist will fail this test.
    const knownCats = new Set(Object.keys(CATEGORY_TO_DIR))
    const bad = OTHER_PROJECTS
      .filter(p => !knownCats.has(p.category))
      .filter(p => !KNOWN_UNMAPPED_OTHER_CATEGORIES.has(p.category))
      .map(p => `${p.name}=${p.category}`)
    expect(bad).toEqual([])
  })

  it('KNOWN_UNMAPPED_OTHER_CATEGORIES allowlist stays honest', () => {
    // Every category in the allowlist must still (a) be missing from
    // CATEGORY_TO_DIR and (b) be used by at least one OTHER_PROJECTS
    // entry. If someone maps a category or removes its last consumer,
    // the entry must be dropped from the allowlist in the same PR.
    const knownCats = new Set(Object.keys(CATEGORY_TO_DIR))
    const usedByOther = new Set(OTHER_PROJECTS.map(p => p.category))
    const stale = [...KNOWN_UNMAPPED_OTHER_CATEGORIES]
      .filter(c => knownCats.has(c) || !usedByOther.has(c))
    expect(stale).toEqual([])
  })

  it('sources.stackoverflow.tags (when present) is a non-empty string[]', () => {
    // Existing catalog-invariants suite already runs this check on
    // CNCF_PROJECTS; the CNCF pipeline receives OTHER_PROJECTS with
    // `sources: p.sources || {}`, so bad shape here reaches the same
    // consumers.
    const bad = []
    for (const p of OTHER_PROJECTS) {
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
    for (const p of OTHER_PROJECTS) {
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
