/**
 * Unit tests for scripts/quality-scorer.mjs.
 *
 * Covers the public scoreMission entrypoint plus each private sub-scorer
 * exercised indirectly via crafted mission fixtures. Previously the module
 * had no dedicated test file.
 */
import { describe, test, expect } from 'vitest'
import { scoreMission } from '../quality-scorer.mjs'

const buildMission = (overrides = {}) => ({
  mission: {
    description: '',
    steps: [],
    resolution: { summary: '', steps: [], codeSnippets: [] },
    ...overrides.mission,
  },
  metadata: overrides.metadata || {},
})

describe('scoreMission', () => {
  test('empty mission scores very low and fails default threshold', () => {
    const result = scoreMission(buildMission())
    expect(result.pass).toBe(false)
    expect(result.score).toBeLessThan(30)
    // breakdown must have all six dimensions
    expect(Object.keys(result.breakdown).sort()).toEqual([
      'codePresence',
      'contentUniqueness',
      'descriptionClarity',
      'metadataQuality',
      'resolutionCompleteness',
      'stepsSpecificity',
    ])
  })

  test('threshold override is respected', () => {
    const empty = buildMission()
    const lowBar = scoreMission(empty, 0)
    expect(lowBar.pass).toBe(true)
    const highBar = scoreMission(empty, 200)
    expect(highBar.pass).toBe(false)
  })

  test('high-quality mission passes and hits high score', () => {
    const strong = buildMission({
      mission: {
        description:
          'Pods crash with "CrashLoopBackOff" because the deployment references a missing ConfigMap named app-config in namespace prod. The container image is v1.18.3 of kubernetes/nginx and the pod fails to start.',
        steps: [
          {
            title: 'Update Cloudflare DNS record deletion to use zone ID',
            description:
              '```yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n```\nRun `kubectl apply -f /etc/config/app-config.yaml` in the prod namespace.',
          },
          {
            title: 'Rebuild deployment with helm',
            description: 'Run `helm upgrade nginx charts/nginx --namespace prod`.',
          },
          {
            title: 'Restart the controller',
            description:
              'Run `kubectl rollout restart deploy/nginx -n prod` and monitor `/var/log/pods/nginx.log`.',
          },
          {
            title: 'Confirm pods reach Ready',
            description:
              'Run `kubectl get pods -n prod -l app=nginx` and expect all replicas Ready.',
          },
          {
            title: 'Publish runbook update',
            description:
              'Update `docs/runbooks/crashloop.md` with the ConfigMap requirement.',
          },
        ],
        resolution: {
          summary:
            'The root cause is a missing ConfigMap because the deployment referenced app-config which did not exist in prod. This fix creates the ConfigMap so the pod can mount its configuration, and this ensures the container starts cleanly on subsequent rollouts.',
          steps: [{}, {}, {}],
          codeSnippets: [
            'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config',
            'helm upgrade nginx charts/nginx --namespace prod',
            'kubectl rollout restart deploy/nginx',
          ],
        },
      },
      metadata: {
        tags: ['kubernetes', 'configmap', 'crashloop'],
        targetResourceKinds: ['Deployment', 'ConfigMap'],
        difficulty: 'advanced',
        sourceUrls: { issue: 'https://github.com/example/repo/issues/1' },
        reactions: 42,
        cncfProjects: ['kubernetes'],
      },
    })
    const result = scoreMission(strong, 70)
    expect(result.pass).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(70)
  })
})

describe('scoreSteps dimension', () => {
  test('zero steps -> 0', () => {
    const r = scoreMission(buildMission())
    expect(r.breakdown.stepsSpecificity).toBe(0)
  })

  test('single step -> 3 (short-circuit)', () => {
    const r = scoreMission(buildMission({ mission: { steps: [{ title: 't', description: 'd' }] } }))
    expect(r.breakdown.stepsSpecificity).toBe(3)
  })

  test('rewards commands, code blocks, file paths, and specific titles', () => {
    const r = scoreMission(buildMission({
      mission: {
        steps: [
          { title: 'Restart deployment', description: '```yaml\napiVersion: v1\nkind: Pod\n```\nRun kubectl apply -f /etc/config/pod.yaml' },
          { title: 'Patch service', description: 'Run helm upgrade nginx and edit /etc/nginx/nginx.conf' },
        ],
      },
    }))
    // 2 steps * 1.5 = 3 base
    // command match (+1.5) * 2 = 3
    // code block (+1) * 1 = 1 (only first has ```)
    // apiVersion match (+1) on first = 1
    // file path (+0.5) * 2 = 1
    // specific title (+0.5) * 2 = 1 (neither has understand/verify/review)
    // total ~10
    expect(r.breakdown.stepsSpecificity).toBeGreaterThan(5)
    expect(r.breakdown.stepsSpecificity).toBeLessThanOrEqual(20)
  })

  test('generic step titles do not earn the specificity bonus', () => {
    const generic = scoreMission(buildMission({
      mission: {
        steps: [
          { title: 'Understand the problem', description: 'read the issue' },
          { title: 'Verify the fix', description: 'confirm ok' },
        ],
      },
    }))
    const specific = scoreMission(buildMission({
      mission: {
        steps: [
          { title: 'Restart nginx', description: 'read the issue' },
          { title: 'Rollback deployment', description: 'confirm ok' },
        ],
      },
    }))
    expect(specific.breakdown.stepsSpecificity).toBeGreaterThan(generic.breakdown.stepsSpecificity)
  })

  test('caps at 20 points', () => {
    const steps = Array.from({ length: 10 }, () => ({
      title: 'Restart deployment',
      description:
        'Run kubectl apply -f /etc/config/x.yaml then helm upgrade docker curl git apt pip npm make go run\n```yaml\napiVersion: v1\nkind: Pod\n```',
    }))
    const r = scoreMission(buildMission({ mission: { steps } }))
    expect(r.breakdown.stepsSpecificity).toBe(20)
  })
})

describe('scoreDescription dimension', () => {
  test('empty description -> 0', () => {
    const r = scoreMission(buildMission())
    expect(r.breakdown.descriptionClarity).toBe(0)
  })

  test('ideal-length description with error keywords and technical terms scores high', () => {
    const desc =
      'The pod fails to start because the deployment cannot mount the configmap and returns error "not found". Kubernetes v1.29 rejects the deployment during admission.'
    const r = scoreMission(buildMission({ mission: { description: desc } }))
    // length band (>=50, <=500): 6
    // error keyword: 4
    // pod/deployment/configmap: 3
    // v1.29/kubernetes: 2
    // no PR template junk: 3
    // Capital + period: 2 -> total 20 (capped)
    expect(r.breakdown.descriptionClarity).toBe(20)
  })

  test('mid-length description gets the smaller length bucket', () => {
    // 30-49 chars, no capital+period, minimal signals
    const desc = 'small blurb about a kubernetes issue thing'
    const r = scoreMission(buildMission({ mission: { description: desc } }))
    expect(r.breakdown.descriptionClarity).toBeGreaterThan(0)
    expect(r.breakdown.descriptionClarity).toBeLessThan(15)
  })

  test('PR template junk suppresses the "no PR template" bonus', () => {
    const junk = scoreMission(buildMission({
      mission: {
        description:
          'What this PR does: describe. Which issue does it fix? Release note: none. Special notes: none. Kubernetes pod deployment.',
      },
    }))
    const clean = scoreMission(buildMission({
      mission: {
        description:
          'A concrete description of a pod deployment error with configmap. Kubernetes v1.29 rejects the change.',
      },
    }))
    expect(clean.breakdown.descriptionClarity).toBeGreaterThan(junk.breakdown.descriptionClarity)
  })
})

describe('scoreResolution dimension', () => {
  test('missing/undefined resolution still earns the not-generic default (3)', () => {
    // scoreMission normalizes missing resolution to {} before passing
    // to scoreResolution, so the "not generic filler" bonus still fires.
    const r = scoreMission({ mission: {}, metadata: {} })
    expect(r.breakdown.resolutionCompleteness).toBe(3)
  })

  test('long why-explaining summary with steps and code snippets caps at 20', () => {
    const summary =
      'The root cause is because the deployment references a missing configmap and this fixes the mount error. This ensures the container has its config and this prevents CrashLoopBackOff on restart. The mount now works reliably across rollouts.'
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary,
          steps: [{}, {}, {}],
          codeSnippets: ['apiVersion: v1'],
        },
      },
    }))
    // >100 chars: 6, "because/root cause/this ensures/this prevents": 5,
    // steps>=3: 4, not generic: 3, snippets: 2 -> 20
    expect(r.breakdown.resolutionCompleteness).toBe(20)
  })

  test('generic "see linked pr" summary loses the not-generic bonus', () => {
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary:
            'See linked PR for the fix — the root cause was misconfiguration. See linked PR for details on the resolution steps taken.',
          steps: [{}],
        },
      },
    }))
    // Contains "see linked pr" -> no +3 bonus
    // >100 chars: 6, "root cause": 5, steps>=1: 2 -> 13
    expect(r.breakdown.resolutionCompleteness).toBe(13)
  })
})

describe('scoreCode dimension', () => {
  test('no code anywhere -> 0', () => {
    const r = scoreMission(buildMission())
    expect(r.breakdown.codePresence).toBe(0)
  })

  test('YAML snippet with apiVersion+kind gives the manifest bonus', () => {
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          summary: '',
          codeSnippets: ['apiVersion: v1\nkind: ConfigMap'],
        },
      },
    }))
    // codeSnippets: 1 * 2 = 2, apiVersion+kind bonus: +3 -> 5
    expect(r.breakdown.codePresence).toBe(5)
  })

  test('caps at 15 points', () => {
    const r = scoreMission(buildMission({
      mission: {
        steps: [
          { description: '```\nkubectl apply -f x\n```' },
          { description: '```\nhelm upgrade\n```' },
          { description: '```\ndocker run\n```' },
          { description: '```\nkubectl get pods\n```' },
          { description: '```\nkubectl logs\n```' },
        ],
        resolution: {
          codeSnippets: [
            'apiVersion: v1\nkind: Pod',
            'apiVersion: v1\nkind: Service',
            'apiVersion: v1\nkind: Deployment',
            'apiVersion: v1\nkind: Ingress',
          ],
        },
      },
    }))
    expect(r.breakdown.codePresence).toBe(15)
  })
})

describe('scoreMetadata dimension', () => {
  test('empty metadata still awards the default-difficulty half-point', () => {
    const r = scoreMission(buildMission())
    expect(r.breakdown.metadataQuality).toBe(0.5)
  })

  test('rich metadata caps at 10', () => {
    const r = scoreMission(buildMission({
      metadata: {
        tags: ['a', 'b', 'c', 'd'],
        targetResourceKinds: ['Pod'],
        difficulty: 'expert',
        sourceUrls: { issue: 'https://x/y' },
        reactions: 100,
        cncfProjects: ['kubernetes'],
      },
    }))
    // tags>=3: 2, kinds: 2, non-default difficulty: 1, source: 2, reactions>20: 2, cncf: 1 -> 10
    expect(r.breakdown.metadataQuality).toBe(10)
  })

  test('sourceIssue field also counts as source', () => {
    const r = scoreMission(buildMission({
      metadata: { sourceIssue: 'https://github.com/example/repo/issues/1' },
    }))
    expect(r.breakdown.metadataQuality).toBeGreaterThan(0.5)
  })

  test('mid-range reactions grants the smaller engagement bonus', () => {
    const low = scoreMission(buildMission({ metadata: { reactions: 10 } }))
    const high = scoreMission(buildMission({ metadata: { reactions: 100 } }))
    expect(high.breakdown.metadataQuality).toBeGreaterThan(low.breakdown.metadataQuality)
  })
})

describe('scoreUniqueness dimension', () => {
  test('empty mission starts at max (15)', () => {
    const r = scoreMission(buildMission())
    expect(r.breakdown.contentUniqueness).toBe(15)
  })

  test('Codecov garbage in snippets triggers the -10 penalty', () => {
    const r = scoreMission(buildMission({
      mission: {
        resolution: {
          codeSnippets: ['Codecov Report — Coverage δ +5%'],
        },
      },
    }))
    expect(r.breakdown.contentUniqueness).toBeLessThanOrEqual(5)
  })

  test('generic filler phrases each deduct 2', () => {
    const r = scoreMission(buildMission({
      mission: {
        description: 'Review the issue and check the documentation to apply the fix.',
        resolution: { summary: 'Verify the fix and review the changes.' },
      },
    }))
    // 5 generic phrases found -> 15 - 10 = 5
    expect(r.breakdown.contentUniqueness).toBeLessThanOrEqual(5)
  })

  test('CI-bot resolution text triggers the -5 penalty', () => {
    const r = scoreMission(buildMission({
      mission: {
        resolution: { summary: 'invalid PR title detected — rerun ut required.' },
      },
    }))
    expect(r.breakdown.contentUniqueness).toBeLessThanOrEqual(10)
  })

  test('git-diff in step descriptions triggers -5', () => {
    const r = scoreMission(buildMission({
      mission: {
        steps: [{ title: 't', description: 'diff --git a/foo b/foo\n--- a/foo\nindex 123' }],
      },
    }))
    expect(r.breakdown.contentUniqueness).toBeLessThanOrEqual(10)
  })

  test('specific component name in description grants +2 bonus', () => {
    // Add a mild filler penalty first so we can observe the +2 bonus
    // (uniqueness caps at 15; without a deduction the bonus is hidden).
    const desc = 'apply the fix. ' // triggers -2 generic-phrase penalty
    const withComponent = scoreMission(buildMission({
      mission: { description: desc + 'The IngressController rejects the request.' },
    }))
    const without = scoreMission(buildMission({
      mission: { description: desc + 'The gateway rejects the request.' },
    }))
    expect(withComponent.breakdown.contentUniqueness).toBeGreaterThan(without.breakdown.contentUniqueness)
  })

  test('score is clamped to [0, 15]', () => {
    // Stack every possible penalty to ensure the floor is 0, not negative.
    const r = scoreMission(buildMission({
      mission: {
        description:
          'review the issue check the documentation see the linked apply the fix understand the problem verify the fix review the changes confirm that the issue changelog category',
        resolution: {
          summary:
            'invalid PR title rerun ut review the issue check the documentation see the linked',
          codeSnippets: ['Codecov report coverage δ 100%'],
        },
        steps: [
          { title: 'understand', description: 'diff --git a/x b/x\n--- a/x\nindex 1' },
        ],
      },
    }))
    expect(r.breakdown.contentUniqueness).toBeGreaterThanOrEqual(0)
    expect(r.breakdown.contentUniqueness).toBeLessThanOrEqual(15)
  })
})
