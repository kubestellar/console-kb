/**
 * CNCF Graduated and Incubating projects with their GitHub repos.
 * Source: https://landscape.cncf.io
 */
export const CNCF_PROJECTS = [
  // Graduated
  { name: 'kubernetes', repo: 'kubernetes/kubernetes', maturity: 'graduated', category: 'orchestration' },
  { name: 'prometheus', repo: 'prometheus/prometheus', maturity: 'graduated', category: 'observability' },
  { name: 'envoy', repo: 'envoyproxy/envoy', maturity: 'graduated', category: 'networking' },
  { name: 'coredns', repo: 'coredns/coredns', maturity: 'graduated', category: 'networking' },
  { name: 'containerd', repo: 'containerd/containerd', maturity: 'graduated', category: 'runtime' },
  { name: 'fluentd', repo: 'fluent/fluentd', maturity: 'graduated', category: 'observability' },
  { name: 'jaeger', repo: 'jaegertracing/jaeger', maturity: 'graduated', category: 'observability' },
  { name: 'helm', repo: 'helm/helm', maturity: 'graduated', category: 'app-definition' },
  { name: 'harbor', repo: 'goharbor/harbor', maturity: 'graduated', category: 'security' },
  { name: 'rook', repo: 'rook/rook', maturity: 'graduated', category: 'storage' },
  { name: 'tikv', repo: 'tikv/tikv', maturity: 'graduated', category: 'storage' },
  { name: 'vitess', repo: 'vitessio/vitess', maturity: 'graduated', category: 'storage' },
  { name: 'istio', repo: 'istio/istio', maturity: 'graduated', category: 'networking' },
  { name: 'linkerd', repo: 'linkerd/linkerd2', maturity: 'graduated', category: 'networking' },
  { name: 'argo', repo: 'argoproj/argo-cd', maturity: 'graduated', category: 'app-definition' },
  { name: 'flux', repo: 'fluxcd/flux2', maturity: 'graduated', category: 'app-definition' },
  { name: 'cilium', repo: 'cilium/cilium', maturity: 'graduated', category: 'networking' },
  { name: 'etcd', repo: 'etcd-io/etcd', maturity: 'graduated', category: 'orchestration' },
  { name: 'open-policy-agent', repo: 'open-policy-agent/opa', maturity: 'graduated', category: 'security' },
  { name: 'falco', repo: 'falcosecurity/falco', maturity: 'graduated', category: 'security' },
  // Incubating
  { name: 'cert-manager', repo: 'cert-manager/cert-manager', maturity: 'incubating', category: 'security' },
  { name: 'kyverno', repo: 'kyverno/kyverno', maturity: 'incubating', category: 'security' },
  { name: 'crossplane', repo: 'crossplane/crossplane', maturity: 'incubating', category: 'app-definition' },
  { name: 'dapr', repo: 'dapr/dapr', maturity: 'incubating', category: 'app-definition' },
  { name: 'keda', repo: 'kedacore/keda', maturity: 'incubating', category: 'orchestration' },
  { name: 'knative', repo: 'knative/serving', maturity: 'incubating', category: 'app-definition' },
  { name: 'thanos', repo: 'thanos-io/thanos', maturity: 'incubating', category: 'observability' },
  { name: 'nats', repo: 'nats-io/nats-server', maturity: 'incubating', category: 'networking' },
  { name: 'tekton', repo: 'tektoncd/pipeline', maturity: 'incubating', category: 'app-definition' },
  { name: 'grpc', repo: 'grpc/grpc', maturity: 'incubating', category: 'networking' },
]

/** Map category to console-kb solutions/ subdirectory */
export const CATEGORY_TO_DIR = {
  'orchestration': 'troubleshooting',
  'observability': 'observability',
  'networking': 'networking',
  'security': 'security',
  'storage': 'troubleshooting',
  'runtime': 'troubleshooting',
  'app-definition': 'workloads',
}
