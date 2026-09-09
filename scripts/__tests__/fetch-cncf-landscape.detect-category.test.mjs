/**
 * Tests for scripts/fetch-cncf-landscape.mjs `detectCategory` — the pure
 * classifier that maps a landscape entry's (name, repo) tuple onto one of
 * the seven CATEGORY_TO_DIR-compatible categories (observability,
 * networking, security, storage, runtime, app-definition, orchestration).
 *
 * detectCategory returns the FIRST matching pattern in CATEGORY_PATTERNS,
 * so pattern ordering is load-bearing: a name that matches both an
 * observability regex and the general app-definition regex must resolve
 * to observability (the earlier pattern). We lock:
 *
 *   1. every one of the seven categories is reachable via at least one
 *      real CNCF landscape entry (observability/prometheus, networking/envoy,
 *      security/falco, storage/rook, runtime/containerd, app-definition/helm,
 *      orchestration/kubernetes), so the fallback path is only for
 *      genuinely unclassified entries;
 *   2. the fallback returns 'app-definition' for a name that no pattern
 *      matches, guaranteeing detectCategory never returns undefined —
 *      the callers write `CATEGORY_TO_DIR[category]` and would otherwise
 *      emit `undefined` into the regenerated cncf-projects.mjs;
 *   3. matching is case-insensitive (patterns use /.../i) — a landscape
 *      entry with capitalised name/repo still classifies correctly;
 *   4. earlier categories win over later ones for ambiguous names (e.g.
 *      "prometheus-operator" matches both /prometheus/ (observability)
 *      and /operator/ (app-definition); it must resolve to observability).
 *
 * Every returned category MUST be a key of CATEGORY_TO_DIR from
 * cncf-projects.mjs, otherwise the regenerated file would emit projects
 * that downstream mission writes cannot place. This test file is the
 * only unit test guarding fetch-cncf-landscape.mjs — before this file
 * it had zero test coverage.
 */

import { describe, it, expect } from 'vitest'
import {
  detectCategory,
  CATEGORY_PATTERNS,
} from '../fetch-cncf-landscape.mjs'
import { CATEGORY_TO_DIR } from '../cncf-projects.mjs'

const KNOWN_CATEGORIES = new Set(Object.keys(CATEGORY_TO_DIR))

describe('fetch-cncf-landscape / detectCategory', () => {
  it('classifies observability projects via the observability pattern', () => {
    expect(detectCategory('prometheus', 'prometheus/prometheus')).toBe('observability')
    expect(detectCategory('grafana', 'grafana/grafana')).toBe('observability')
    expect(detectCategory('jaeger', 'jaegertracing/jaeger')).toBe('observability')
    expect(detectCategory('fluentd', 'fluent/fluentd')).toBe('observability')
    expect(detectCategory('opentelemetry', 'open-telemetry/opentelemetry')).toBe('observability')
  })

  it('classifies networking projects via the networking pattern', () => {
    expect(detectCategory('envoy', 'envoyproxy/envoy')).toBe('networking')
    expect(detectCategory('istio', 'istio/istio')).toBe('networking')
    expect(detectCategory('linkerd', 'linkerd/linkerd2')).toBe('networking')
    expect(detectCategory('cilium', 'cilium/cilium')).toBe('networking')
    expect(detectCategory('coredns', 'coredns/coredns')).toBe('networking')
    expect(detectCategory('grpc', 'grpc/grpc')).toBe('networking')
  })

  it('classifies security projects via the security pattern', () => {
    expect(detectCategory('falco', 'falcosecurity/falco')).toBe('security')
    expect(detectCategory('open-policy-agent', 'open-policy-agent/opa')).toBe('security')
    expect(detectCategory('spiffe', 'spiffe/spiffe')).toBe('security')
    expect(detectCategory('cert-manager', 'cert-manager/cert-manager')).toBe('security')
    expect(detectCategory('kyverno', 'kyverno/kyverno')).toBe('security')
  })

  it('classifies storage projects via the storage pattern', () => {
    expect(detectCategory('rook', 'rook/rook')).toBe('storage')
    expect(detectCategory('vitess', 'vitessio/vitess')).toBe('storage')
    expect(detectCategory('tikv', 'tikv/tikv')).toBe('storage')
    expect(detectCategory('longhorn', 'longhorn/longhorn')).toBe('storage')
  })

  it('classifies runtime projects via the runtime pattern', () => {
    expect(detectCategory('containerd', 'containerd/containerd')).toBe('runtime')
    expect(detectCategory('cri-o', 'cri-o/cri-o')).toBe('runtime')
    expect(detectCategory('wasmedge', 'WasmEdge/WasmEdge')).toBe('runtime')
    expect(detectCategory('spin', 'spinframework/spin')).toBe('runtime')
  })

  it('classifies app-definition projects via the app-definition pattern', () => {
    expect(detectCategory('helm', 'helm/helm')).toBe('app-definition')
    expect(detectCategory('argo', 'argoproj/argo-cd')).toBe('app-definition')
    expect(detectCategory('flux', 'fluxcd/flux2')).toBe('app-definition')
    expect(detectCategory('backstage', 'backstage/backstage')).toBe('app-definition')
    expect(detectCategory('kubevirt', 'kubevirt/kubevirt')).toBe('app-definition')
  })

  it('classifies orchestration projects via the orchestration pattern', () => {
    expect(detectCategory('kubernetes', 'kubernetes/kubernetes')).toBe('orchestration')
    expect(detectCategory('etcd', 'etcd-io/etcd')).toBe('orchestration')
    expect(detectCategory('karmada', 'karmada-io/karmada')).toBe('orchestration')
    expect(detectCategory('k3s', 'k3s-io/k3s')).toBe('orchestration')
  })

  it("falls back to 'app-definition' for names that match no pattern", () => {
    // These names contain no substring from any CATEGORY_PATTERNS regex.
    expect(detectCategory('zzz-mystery-project', 'someorg/zzz-mystery-project')).toBe('app-definition')
    expect(detectCategory('foobar', 'someorg/foobar')).toBe('app-definition')
    // The point: even the fallback returns a key of CATEGORY_TO_DIR so the
    // regenerated cncf-projects.mjs never emits an unknown category.
    expect(KNOWN_CATEGORIES.has(detectCategory('foobar', 'someorg/foobar'))).toBe(true)
  })

  it('never returns a category outside CATEGORY_TO_DIR', () => {
    // The regex categories on the LHS of CATEGORY_PATTERNS must all
    // map to a key of CATEGORY_TO_DIR — otherwise the generator writes
    // entries the mission writer cannot place.
    for (const [, category] of CATEGORY_PATTERNS) {
      expect(KNOWN_CATEGORIES.has(category)).toBe(true)
    }
    // And the fallback also must be a known key.
    expect(KNOWN_CATEGORIES.has('app-definition')).toBe(true)
  })

  it('is case-insensitive (patterns use the /i flag)', () => {
    expect(detectCategory('Prometheus', 'PROMETHEUS/prometheus')).toBe('observability')
    expect(detectCategory('ENVOY', 'EnvoyProxy/Envoy')).toBe('networking')
    expect(detectCategory('Falco', 'FalcoSecurity/Falco')).toBe('security')
  })

  it('prefers the earlier CATEGORY_PATTERNS entry on ambiguous matches', () => {
    // 'prometheus-operator' matches both /prometheus/ (observability, index 0)
    // and /operator/ (app-definition, index 5). Observability wins because
    // the loop returns on the first match.
    expect(detectCategory('prometheus-operator', 'prometheus-operator/prometheus-operator'))
      .toBe('observability')
    // 'cert-manager' matches both /cert.manager/ (security, index 2) and
    // /operator/ would not fire here, but if a repo path included both
    // security and networking triggers, security (index 2) should still
    // win over the later app-definition catch-all. Use a synthesized
    // name to prove earlier-wins is deterministic.
    expect(detectCategory('falco-operator', 'someorg/falco-helm-operator'))
      .toBe('security')
  })
})
