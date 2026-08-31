import { describe, it, expect } from 'vitest'
import {
  estimateDifficulty,
  extractResourceKinds,
  extractLabels,
  detectMissionType,
} from '../generate-cncf-missions.mjs'

// The existing generate-cncf-missions.test.mjs suite covers only the "advanced"
// arm of estimateDifficulty and a single happy-path assertion for
// extractResourceKinds. This file exercises every branch of those two
// scoring/classification helpers so that a regression in any single scoring
// bump — or in the ambiguous-vs-unambiguous K8s-kind splitter — is caught
// by a targeted test.

// Small helper mirroring the one in generate-cncf-missions.test.mjs.
function mockIssue(overrides = {}) {
  return {
    title: overrides.title || 'Test issue',
    body: overrides.body || 'Some issue body text',
    labels: overrides.labels || [],
    comments: overrides.comments ?? 0,
    reactions: overrides.reactions || { total_count: 0 },
    html_url: 'https://github.com/test/repo/issues/1',
    number: 1,
    ...overrides,
  }
}

const k8sProject = { name: 'kubernetes', category: 'orchestration' }
const nonK8sProject = { name: 'harbor', category: 'security-compliance' }

// ─── estimateDifficulty ───────────────────────────────────────────

describe('estimateDifficulty — comment-count buckets', () => {
  it('returns beginner for a plain issue with zero comments (score ≤ 0)', () => {
    const issue = mockIssue({ title: 'Small tweak', body: '', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('beginner')
  })

  it('adds +1 when comments > 5', () => {
    // 6 comments → +1. No other bumps → score=1 → intermediate.
    const issue = mockIssue({ title: 'question about docs', body: '', comments: 6 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +2 when comments > 15', () => {
    // 16 comments → +2 → score=2 → intermediate.
    const issue = mockIssue({ title: 'question about docs', body: '', comments: 16 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +3 when comments > 30', () => {
    // 31 comments → +3 → score=3 → advanced.
    const issue = mockIssue({ title: 'question about docs', body: '', comments: 31 })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })
})

describe('estimateDifficulty — label bumps', () => {
  it('adds +2 for priority/critical label', () => {
    // No other bumps → score=2 → intermediate.
    const issue = mockIssue({ title: 'x', body: '', labels: [{ name: 'priority/critical' }] })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +2 for severity/critical label', () => {
    const issue = mockIssue({ title: 'x', body: '', labels: [{ name: 'severity/critical' }] })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('subtracts 2 for kind/cleanup label', () => {
    // -2 alone → score=-2 → beginner (the ≤0 arm).
    const issue = mockIssue({ title: 'x', body: '', labels: [{ name: 'kind/cleanup' }] })
    expect(estimateDifficulty(issue)).toBe('beginner')
  })

  it('subtracts 2 for "good first issue" label', () => {
    const issue = mockIssue({ title: 'x', body: '', labels: [{ name: 'good first issue' }] })
    expect(estimateDifficulty(issue)).toBe('beginner')
  })

  it('label strings (not label objects) are accepted', () => {
    // The `.name || ''` fallback and typeof-string branch — label supplied
    // as a bare string, not { name: '…' }.
    const issue = mockIssue({ title: 'x', body: '', labels: ['priority/critical'] })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })
})

describe('estimateDifficulty — content-complexity bumps', () => {
  it('adds +3 for "race condition" in body', () => {
    // +3 alone → score=3 → advanced.
    const issue = mockIssue({ title: 'x', body: 'we hit a race condition here', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })

  it('adds +3 for "deadlock" in body', () => {
    const issue = mockIssue({ title: 'x', body: 'deadlock reproduces reliably', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })

  it('adds +3 for "data loss" in body', () => {
    const issue = mockIssue({ title: 'x', body: 'observed data loss on restart', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })

  it('adds +2 for upgrade keyword', () => {
    // +2 alone → intermediate.
    const issue = mockIssue({ title: 'upgrade path unclear', body: '', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +2 for migration keyword', () => {
    const issue = mockIssue({ title: 'x', body: 'plan the migration carefully', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('subtracts 1 for config/flag/env-var mention', () => {
    // A single "config" mention with 6 comments (+1) and -1 for config
    // → score=0 → beginner. This exercises the negative bump arm.
    const issue = mockIssue({ title: 'x', body: 'change the config setting', comments: 6 })
    expect(estimateDifficulty(issue)).toBe('beginner')
  })

  it('adds +2 for CNI/chaining/vpc keyword group (single bump)', () => {
    // The keyword group is a single `if` that fires at most +2 regardless
    // of how many of the three keywords match.
    const issue = mockIssue({ title: 'x', body: 'cni chaining not working', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +1 for wireguard/encryption/ipsec keyword', () => {
    // +1 alone → intermediate.
    const issue = mockIssue({ title: 'x', body: 'wireguard tunnel drops', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +2 for bpf/ebpf/datapath keyword', () => {
    // +2 alone → intermediate.
    const issue = mockIssue({ title: 'x', body: 'bpf program fails to load', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +1 for kernel/iptables/nftables keyword', () => {
    const issue = mockIssue({ title: 'x', body: 'iptables rules conflict', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })
})

describe('estimateDifficulty — multi-product mentions', () => {
  it('adds +1 when exactly one cloud/platform product is mentioned', () => {
    // "eks" appears once → productMentions.length === 1 → +1 → intermediate.
    const issue = mockIssue({ title: 'x', body: 'affects eks users', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })

  it('adds +2 when two or more cloud/platform products are mentioned', () => {
    // "eks" + "gke" → +2 → intermediate (2 ≤ 2).
    const issue = mockIssue({ title: 'x', body: 'both eks and gke affected', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('intermediate')
  })
})

describe('estimateDifficulty — bucket boundaries', () => {
  it('returns expert when score > 4', () => {
    // race condition (+3) + eks/gke (+2) = 5 → expert.
    const issue = mockIssue({
      title: 'x',
      body: 'race condition affects both eks and gke',
      comments: 0,
    })
    expect(estimateDifficulty(issue)).toBe('expert')
  })

  it('returns advanced at exactly score=3', () => {
    // race condition (+3) alone.
    const issue = mockIssue({ title: 'x', body: 'race condition', comments: 0 })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })

  it('returns advanced at exactly score=4', () => {
    // priority/critical (+2) + upgrade (+2) = 4 → advanced (score ≤ 4).
    const issue = mockIssue({
      title: 'upgrade fails',
      body: '',
      labels: [{ name: 'priority/critical' }],
      comments: 0,
    })
    expect(estimateDifficulty(issue)).toBe('advanced')
  })
})

// ─── extractResourceKinds ─────────────────────────────────────────

describe('extractResourceKinds — K8s-native gate', () => {
  it('returns [] for non-K8s-native projects even with pod mentions', () => {
    const issue = mockIssue({ title: 'pod restart issue', body: '' })
    expect(extractResourceKinds(issue, nonK8sProject)).toEqual([])
  })

  it('works when project argument is omitted (backward compatibility)', () => {
    // The `if (project && !isKubernetesNative(project))` short-circuit
    // means `undefined` project should NOT filter out matches.
    const issue = mockIssue({ title: 'Pod crashes', body: '' })
    const result = extractResourceKinds(issue, undefined)
    expect(result).toContain('Pod')
  })
})

describe('extractResourceKinds — unambiguous kinds', () => {
  it('detects Pod via word-boundary match (not "podcast")', () => {
    const issue = mockIssue({ title: 'podcast integration', body: '' })
    expect(extractResourceKinds(issue, k8sProject)).toEqual([])
  })

  it('extracts multiple unambiguous kinds but caps at 3', () => {
    // Body mentions 5 unambiguous kinds; result must be exactly 3.
    const issue = mockIssue({
      title: 'x',
      body: 'The Deployment created a Pod and a ReplicaSet with an Ingress and a ConfigMap',
    })
    const result = extractResourceKinds(issue, k8sProject)
    expect(result).toHaveLength(3)
  })

  it('deduplicates repeated kinds', () => {
    const issue = mockIssue({
      title: 'pod pod pod',
      body: 'pods keep restarting, pod is unhealthy',
    })
    const result = extractResourceKinds(issue, k8sProject)
    expect(result).toEqual(['Pod'])
  })

  it('handles trailing "s" plurals via the `s?` alternation', () => {
    // The regex is `\b${kind}s?\b`, which matches "pod" or "pods" but NOT
    // "ingresses" (which needs an "es?" tail). Use a kind whose plural is
    // formed by adding a single "s" to confirm the alternation fires.
    const issue = mockIssue({ title: 'x', body: 'multiple pods failing' })
    const result = extractResourceKinds(issue, k8sProject)
    expect(result).toContain('Pod')
  })
})

describe('extractResourceKinds — ambiguous kinds', () => {
  it('does NOT extract "service" without K8s context', () => {
    const issue = mockIssue({ title: 'x', body: 'the service is down' })
    expect(extractResourceKinds(issue, k8sProject)).toEqual([])
  })

  it('does NOT extract "role" without K8s context', () => {
    const issue = mockIssue({ title: 'x', body: 'user role missing' })
    expect(extractResourceKinds(issue, k8sProject)).toEqual([])
  })

  it('DOES extract "service" when body mentions kubectl', () => {
    const issue = mockIssue({ title: 'x', body: 'kubectl says the service is down' })
    expect(extractResourceKinds(issue, k8sProject)).toContain('Service')
  })

  it('DOES extract "node" when body mentions kubernetes', () => {
    const issue = mockIssue({ title: 'x', body: 'kubernetes: a node went NotReady' })
    expect(extractResourceKinds(issue, k8sProject)).toContain('Node')
  })

  it('DOES extract "secret" when body mentions helm', () => {
    const issue = mockIssue({ title: 'x', body: 'helm upgrade failed reading secret' })
    expect(extractResourceKinds(issue, k8sProject)).toContain('Secret')
  })
})

// ─── extractLabels — supplemental coverage ───────────────────────────

describe('extractLabels', () => {
  it('accepts string-form labels and normalizes to lowercase with dashes', () => {
    const issue = mockIssue({ labels: ['Kind/Bug', 'priority/critical'] })
    expect(extractLabels(issue)).toEqual(['kind-bug', 'priority-critical'])
  })

  it('filters out labels whose .name is falsy (empty string)', () => {
    const issue = mockIssue({ labels: [{ name: '' }, { name: 'valid-label' }] })
    const result = extractLabels(issue)
    expect(result).toContain('valid-label')
    expect(result).not.toContain('')
  })

  it('caps at 10 labels', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `label-${i}` }))
    const issue = mockIssue({ labels: many })
    expect(extractLabels(issue)).toHaveLength(10)
  })

  it('returns [] when labels array is missing', () => {
    const issue = { title: 't', body: 'b' }
    expect(extractLabels(issue)).toEqual([])
  })
})

// ─── detectMissionType — arms not covered by existing tests ────────

describe('detectMissionType — additional keyword arms', () => {
  it('returns troubleshoot for "cannot" / "can\'t"', () => {
    expect(detectMissionType(mockIssue({ title: 'cannot connect to db' }))).toBe('troubleshoot')
    expect(detectMissionType(mockIssue({ title: "can't reach api" }))).toBe('troubleshoot')
  })

  it('returns troubleshoot for security/CVE keywords', () => {
    expect(detectMissionType(mockIssue({ title: 'CVE-2024-1234 disclosed' }))).toBe('troubleshoot')
    expect(detectMissionType(mockIssue({ title: 'security concern' }))).toBe('troubleshoot')
  })

  it('label-based bug detection takes priority over feature keywords', () => {
    // Title has "add" (feature) but label is bug → troubleshoot wins.
    const issue = mockIssue({ title: 'add rate limiter', labels: [{ name: 'kind/bug' }] })
    expect(detectMissionType(issue)).toBe('troubleshoot')
  })

  it('returns feature via label even when title has bug keywords', () => {
    const issue = mockIssue({ title: 'error handling', labels: [{ name: 'enhancement' }] })
    expect(detectMissionType(issue)).toBe('feature')
  })

  it('returns feature by default for unclassified titles', () => {
    // Falls all the way through to the final "feature" return.
    // Note: "add" would match the feature-keyword branch, so pick a
    // title with none of the classification keywords.
    const issue = mockIssue({ title: 'refactor xyz', labels: [] })
    expect(detectMissionType(issue)).toBe('feature')
  })
})
