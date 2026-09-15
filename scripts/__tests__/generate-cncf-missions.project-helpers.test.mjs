import { describe, it, expect } from 'vitest'
import {
  isKubernetesNative,
  getProjectVersionCmd,
  getProjectStatusCmd,
  generatePrerequisites,
  passesQualityGate,
  K8S_NATIVE_CATEGORIES,
  NON_K8S_PROJECTS,
  PROJECT_CLI_MAP,
} from '../generate-cncf-missions.mjs'

// These helpers decide how a generated mission's `prerequisites` block is
// shaped (K8s-native vs. non-K8s CLI-based) and whether a scraped
// issue/PR pair produces a useful mission at all. They are pure and
// small, but they gate every generated card — a silent regression
// here reshapes hundreds of downstream missions. These tests lock the
// current branching so a future refactor cannot flip a category or
// weaken the quality gate without an explicit test change.

describe('isKubernetesNative', () => {
  it('returns false when the project is in the NON_K8S_PROJECTS deny-list, even with a K8s-native category', () => {
    // clickhouse is in NON_K8S_PROJECTS. The deny-list must beat the
    // category allow-list.
    const project = { name: 'clickhouse', category: 'storage' }
    expect(K8S_NATIVE_CATEGORIES.has('storage')).toBe(true)
    expect(NON_K8S_PROJECTS.has('clickhouse')).toBe(true)
    expect(isKubernetesNative(project)).toBe(false)
  })

  it('returns true when the project has a category in K8S_NATIVE_CATEGORIES', () => {
    const project = { name: 'some-orchestrator', category: 'orchestration' }
    expect(isKubernetesNative(project)).toBe(true)
  })

  it('returns true when the project has k8sVersions populated (no category match)', () => {
    const project = { name: 'some-tool', category: 'other', k8sVersions: ['1.28', '1.29'] }
    expect(isKubernetesNative(project)).toBe(true)
  })

  it('returns true for the default fallback (no category, no k8sVersions, not on deny-list)', () => {
    const project = { name: 'some-unmapped-project' }
    expect(isKubernetesNative(project)).toBe(true)
  })

  it('does not treat an empty k8sVersions array as a K8s signal by itself (still true via default fallback)', () => {
    const project = { name: 'some-tool', k8sVersions: [] }
    // Length-0 array is falsy for the `.length > 0` check but the
    // default fallback still returns true. This locks that behavior.
    expect(isKubernetesNative(project)).toBe(true)
  })

  it('returns false for every project in NON_K8S_PROJECTS regardless of category', () => {
    for (const name of NON_K8S_PROJECTS) {
      expect(isKubernetesNative({ name })).toBe(false)
    }
  })
})

describe('getProjectVersionCmd', () => {
  it('returns the mapped versionCmd when the project is in PROJECT_CLI_MAP', () => {
    expect(getProjectVersionCmd({ name: 'helm' })).toBe(PROJECT_CLI_MAP.helm.versionCmd)
    expect(getProjectVersionCmd({ name: 'vault' })).toBe('vault version')
  })

  it('returns null when the mapped project has versionCmd: null (library, no CLI)', () => {
    expect(getProjectVersionCmd({ name: 'grpc' })).toBeNull()
    expect(getProjectVersionCmd({ name: 'cloudevents' })).toBeNull()
  })

  it('falls back to `${name} version` for an unmapped project', () => {
    expect(getProjectVersionCmd({ name: 'kubernetes' })).toBe('kubernetes version')
  })
})

describe('getProjectStatusCmd', () => {
  it('returns the mapped statusCmd when set', () => {
    expect(getProjectStatusCmd({ name: 'vault' })).toBe('vault status')
    expect(getProjectStatusCmd({ name: 'helm' })).toBe('helm repo list')
  })

  it('returns null when the mapped project has statusCmd: null', () => {
    expect(getProjectStatusCmd({ name: 'ko' })).toBeNull()
    expect(getProjectStatusCmd({ name: 'sops' })).toBeNull()
  })

  it('falls back to `${name} status 2>&1 | head -20` for an unmapped project', () => {
    expect(getProjectStatusCmd({ name: 'kubernetes' })).toBe('kubernetes status 2>&1 | head -20')
  })
})

describe('generatePrerequisites', () => {
  it('returns the K8s prerequisites block for a K8s-native project', () => {
    const project = { name: 'argo', category: 'orchestration' }
    const prereqs = generatePrerequisites(project)
    expect(prereqs.kubernetes).toBe('>=1.24')
    expect(prereqs.tools).toEqual(['kubectl'])
    expect(prereqs.description).toContain('argo')
    expect(prereqs.description).toContain('Kubernetes')
  })

  it('uses the mapped tools list for a non-K8s project that has a PROJECT_CLI_MAP entry', () => {
    const project = { name: 'vault' }
    const prereqs = generatePrerequisites(project)
    expect(prereqs.kubernetes).toBeUndefined()
    expect(prereqs.tools).toEqual(['vault'])
    expect(prereqs.description).toContain('vault')
  })

  it('uses the mapped description when the mapping supplies one', () => {
    // grpc is on NON_K8S_PROJECTS and has a description in the map.
    const prereqs = generatePrerequisites({ name: 'grpc' })
    expect(prereqs.description).toBe(PROJECT_CLI_MAP.grpc.description)
    expect(prereqs.tools).toEqual(['protoc'])
  })

  it('falls back to [name] when the mapped tools list is empty', () => {
    // cloudevents has tools: [] in the map — the ternary falls back
    // to [project.name].
    const prereqs = generatePrerequisites({ name: 'cloudevents' })
    expect(prereqs.tools).toEqual(['cloudevents'])
  })

  it('uses a generic non-K8s block for an unmapped non-K8s project', () => {
    // A project on NON_K8S_PROJECTS with no PROJECT_CLI_MAP entry hits
    // the "unmapped non-K8s" fallback.
    const unmapped = [...NON_K8S_PROJECTS].find(n => !PROJECT_CLI_MAP[n])
    // Sanity: the fixture assumes at least one such project exists.
    expect(unmapped).toBeDefined()
    const prereqs = generatePrerequisites({ name: unmapped })
    expect(prereqs.kubernetes).toBeUndefined()
    expect(prereqs.tools).toEqual([unmapped])
    expect(prereqs.description).toBe(`A working ${unmapped} installation or development environment.`)
  })
})

// A long, plausible-looking solution that survives every rejection
// branch in passesQualityGate. Kept short-of-the-bar solutions are
// derived from this one by trimming.
const LONG_ACTIONABLE_SOLUTION = [
  'Set the resource limits in your Deployment manifest to reserve enough memory for the workload.',
  'Then run kubectl apply -f deploy.yaml to roll out the change and verify with kubectl get pods.',
  'Adjust the readinessProbe timeout in the same manifest if the container needs longer to start.',
  '```yaml',
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  name: example',
  'spec:',
  '  replicas: 2',
  '```',
].join(' ')

function baseResolution(overrides = {}) {
  return {
    problem: 'The pod fails to start because the readiness probe times out on slow nodes; this is reproducible on any cluster running the v1.4 chart.',
    solution: LONG_ACTIONABLE_SOLUTION,
    steps: ['step one description here', 'step two description here'],
    yamlSnippets: [],
    ...overrides,
  }
}

function baseIssue(overrides = {}) {
  return { body: 'issue body long enough to pass the minimum description length check for real coverage', ...overrides }
}

describe('passesQualityGate', () => {
  it('accepts a resolution with a real problem, actionable solution, and at least two steps', () => {
    expect(passesQualityGate(baseResolution(), baseIssue())).toBe(true)
  })

  it('rejects when the problem description is shorter than 50 characters', () => {
    const r = baseResolution({ problem: 'too short' })
    expect(passesQualityGate(r, baseIssue({ body: 'also short' }))).toBe(false)
  })

  it('rejects when there are no steps, no meaningful solution, and no code snippets', () => {
    const r = baseResolution({ solution: 'short', steps: [], yamlSnippets: [] })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('accepts a resolution that has only YAML snippets (no steps, no solution)', () => {
    const r = baseResolution({
      solution: 'a'.repeat(101),
      steps: [],
      yamlSnippets: ['apiVersion: v1\nkind: Pod'],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(true)
  })

  it('rejects a solution that begins with a lone colon (bold-header artifact)', () => {
    const r = baseResolution({ solution: ': ' + LONG_ACTIONABLE_SOLUTION })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects when the solution is too short after stripPRTemplate and no yaml snippets are attached', () => {
    const r = baseResolution({ solution: 'a'.repeat(79), yamlSnippets: [] })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects a short commit-message-style solution ("Fixes #123")', () => {
    const r = baseResolution({
      solution: 'Fixes #123 - closes the readiness probe race condition in the sidecar container.',
      yamlSnippets: [],
      steps: [],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects a solution that is mostly questions', () => {
    const r = baseResolution({
      solution: 'Have you tried this? What does the log say? Is the pod ready? Does it start? Any errors?',
      yamlSnippets: [],
      steps: [],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects "me too" and "+1" style solutions', () => {
    for (const s of ['me too, seeing the same behaviour on my cluster deployment right now', '+1 same here on latest chart install with the default values applied']) {
      const r = baseResolution({ solution: s, yamlSnippets: [], steps: [] })
      expect(passesQualityGate(r, baseIssue())).toBe(false)
    }
  })

  it('rejects conversational openers ("I think ...")', () => {
    const r = baseResolution({
      solution: 'I think the issue is a race condition between the readiness probe and the container start; not sure yet.',
      yamlSnippets: [],
      steps: [],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects a solution that starts with a comma (truncated quote)', () => {
    const r = baseResolution({
      solution: ', which is why the readiness probe fails on slow nodes when the container has not yet finished starting up.',
      yamlSnippets: [],
      steps: [],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects a solution containing an email reply header', () => {
    const r = baseResolution({
      solution: 'On Mon, Jan 1, 2024 at 10:00 AM Someone wrote:\n> please help me debug this cluster issue with the readiness probe.',
      yamlSnippets: [],
      steps: [],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('rejects short prose with no code block, command, config, numbered steps, or YAML snippets', () => {
    const r = baseResolution({
      solution: 'The problem is that the readiness probe is timing out because of slow node startup and should probably be tuned differently.',
      yamlSnippets: [],
      steps: [],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(false)
  })

  it('accepts long prose (>=300 chars) with no code/commands as a detailed explanation', () => {
    const longProse = ('The problem is that the readiness probe is timing out because of slow node startup and the container needs additional time to warm caches and initialize its persistent volume. '.repeat(3)).trim()
    expect(longProse.length).toBeGreaterThanOrEqual(300)
    const r = baseResolution({ solution: longProse, yamlSnippets: [], steps: ['warm the cache first', 'redeploy the workload'] })
    expect(passesQualityGate(r, baseIssue())).toBe(true)
  })

  it('accepts a solution containing an SDK/CLI command even without a fenced code block', () => {
    const r = baseResolution({
      solution: 'Run kubectl rollout restart deployment/my-app to force a fresh set of pods, then check status with kubectl get pods -w until they report Ready.',
      yamlSnippets: [],
      steps: ['restart the deployment', 'watch the pods report ready'],
    })
    expect(passesQualityGate(r, baseIssue())).toBe(true)
  })
})
