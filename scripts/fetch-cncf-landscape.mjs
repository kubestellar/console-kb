#!/usr/bin/env node
/**
 * Fetches the CNCF landscape.yml and regenerates cncf-projects.mjs
 * with all graduated, incubating, and sandbox projects.
 *
 * Usage: node scripts/fetch-cncf-landscape.mjs
 */
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LANDSCAPE_URL = 'https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml'
const OUTPUT_PATH = join(__dirname, 'cncf-projects.mjs')

const CATEGORY_PATTERNS = [
  [/prometheus|grafana|jaeger|fluentd|thanos|cortex|opentelemetry|loki|tempo|pixie|skooner|headlamp|trickster|opencost|inspektor|kepler|parseable|perses/i, 'observability'],
  [/envoy|istio|linkerd|cilium|coredns|nats|grpc|contour|emissary|network|service.mesh|meshery|merbridge|aeraki|bfe|easegress|pipy|kuma|nighthawk|submariner|antrea|cni/i, 'networking'],
  [/falco|harbor|opa|spiffe|spire|cert.manager|kyverno|notary|sigstore|keycloak|open.?fga|paralus|confidential|curiefense|dex|guard|athenz|teller|hexa|kubewarden|in-toto|tuf|external.secrets/i, 'security'],
  [/rook|vitess|tikv|longhorn|ceph|cubefs|curve|hwameistor|piraeus|soda|vineyard|xline|openebs|pravega|strimzi/i, 'storage'],
  [/containerd|cri-o|kata|wasmcloud|wasmedge|wasmtime|youki|inclavare|krustlet|virtink|spin/i, 'runtime'],
  [/helm|argo|flux|crossplane|dapr|keda|knative|tekton|backstage|operator|buildpack|cdk8s|devfile|devstream|flagger|keptn|kubevela|kubevirt|kudo|nocalhost|openfunction|porter|sealer|serverless|telepresence|tilt/i, 'app-definition'],
  [/kubernetes|kubestellar|etcd|karmada|clusterpedia|k3s|k0s|minikube|volcano|fluid|litmus|chaos/i, 'orchestration'],
]

function detectCategory(name, repo) {
  const text = `${name} ${repo}`
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category
  }
  return 'app-definition'
}

async function main() {
  console.log(`Fetching CNCF landscape from ${LANDSCAPE_URL}...`)
  const resp = await fetch(LANDSCAPE_URL)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
  const text = await resp.text()

  const projects = []
  const lines = text.split('\n')
  let currentItem = {}

  for (const line of lines) {
    if (/^\s+- item:\s*$/.test(line)) {
      if (currentItem.name && currentItem.repo) {
        projects.push({ ...currentItem })
      }
      currentItem = {}
      continue
    }

    const nm = line.match(/^\s+name:\s*(.+)/)
    if (nm) currentItem.name = nm[1].trim()

    const repo = line.match(/^\s+repo_url:\s*(.+)/)
    if (repo) currentItem.repo = repo[1].trim()

    const proj = line.match(/^\s+project:\s*(.+)/)
    if (proj) currentItem.project = proj[1].trim()
  }
  if (currentItem.name && currentItem.repo) {
    projects.push({ ...currentItem })
  }

  const cncf = projects
    .filter(p => p.project && ['graduated', 'incubating', 'sandbox'].includes(p.project))
    .map(p => {
      const m = p.repo.match(/github\.com\/([^/]+\/[^/]+)/)
      return m ? {
        name: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        repo: m[1],
        maturity: p.project,
        category: detectCategory(p.name, m[1]),
      } : null
    })
    .filter(Boolean)

  // Deduplicate by repo
  const seen = new Set()
  const unique = cncf.filter(p => {
    if (seen.has(p.repo)) return false
    seen.add(p.repo)
    return true
  })

  // Sort by maturity then name
  const order = { graduated: 0, incubating: 1, sandbox: 2 }
  unique.sort((a, b) => (order[a.maturity] - order[b.maturity]) || a.name.localeCompare(b.name))

  // Generate output
  const out = [
    '/**',
    ' * CNCF Graduated, Incubating, and Sandbox projects with their GitHub repos.',
    ' * Auto-generated from https://landscape.cncf.io',
    ` * Total: ${unique.length} projects`,
    ` * Generated: ${new Date().toISOString()}`,
    ' */',
    'export const CNCF_PROJECTS = [',
  ]

  let prevMaturity = ''
  for (const p of unique) {
    if (p.maturity !== prevMaturity) {
      out.push(`  // ${p.maturity.charAt(0).toUpperCase() + p.maturity.slice(1)}`)
      prevMaturity = p.maturity
    }
    out.push(`  { name: ${JSON.stringify(p.name)}, repo: ${JSON.stringify(p.repo)}, maturity: ${JSON.stringify(p.maturity)}, category: ${JSON.stringify(p.category)} },`)
  }

  out.push(']', '')
  out.push('/** Map category to console-kb solutions/ subdirectory */')
  out.push('export const CATEGORY_TO_DIR = {')
  out.push("  'orchestration': 'troubleshooting',")
  out.push("  'observability': 'observability',")
  out.push("  'networking': 'networking',")
  out.push("  'security': 'security',")
  out.push("  'storage': 'troubleshooting',")
  out.push("  'runtime': 'runtime',")
  out.push("  'app-definition': 'workloads',")
  out.push('}')
  out.push('')

  writeFileSync(OUTPUT_PATH, out.join('\n'))
  console.log(`Written ${unique.length} projects to ${OUTPUT_PATH}`)
  console.log(`  Graduated: ${unique.filter(p => p.maturity === 'graduated').length}`)
  console.log(`  Incubating: ${unique.filter(p => p.maturity === 'incubating').length}`)
  console.log(`  Sandbox: ${unique.filter(p => p.maturity === 'sandbox').length}`)
}

main().catch(err => { console.error(err); process.exit(1) })
