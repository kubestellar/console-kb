/**
 * Mission quality gating and classification helpers for the CNCF mission
 * generator.
 *
 * Extracted from generate-cncf-missions.mjs (console-kb#3133 / #3332) so the
 * quality gate and classification heuristics can be unit-tested
 * independently of the GitHub scraping and mission-synthesis concerns that
 * remain in the main script.
 */
import { stripPRTemplate, isLikelyEnglish } from './text-utils.mjs'
import { isKubernetesNative } from './cncf-project-metadata.mjs'

/** Check if a mission has enough quality to be useful */
export function passesQualityGate(resolution, issue) {
  // Must have a real problem description (not just template junk)
  const desc = stripPRTemplate(resolution.problem || issue.body || '')
  if (desc.length < 50) return false

  // Must have either: real steps, a meaningful solution, or code snippets
  const hasSteps = resolution.steps.length >= 2
  const hasSolution = (resolution.solution || '').length > 100
  const hasCode = resolution.yamlSnippets.length > 0

  if (!hasSteps && !hasSolution && !hasCode) return false

  // Reject non-English content (heuristic: check solution and problem text)
  if (!isLikelyEnglish(resolution.solution || '') && (resolution.solution || '').length > 50) return false
  if (!isLikelyEnglish(resolution.problem || '') && (resolution.problem || '').length > 50) return false

  // Reject if solution starts with a lone colon (stripped bold-header artifact)
  const rawSolution = (resolution.solution || '').trim()
  if (rawSolution.startsWith(':')) return false

  // Reject if solution is empty after stripping — means no real fix was found
  const strippedSolution = stripPRTemplate(resolution.solution || '')
  const MIN_SOLUTION_LENGTH = 80
  if (strippedSolution.length < MIN_SOLUTION_LENGTH && resolution.yamlSnippets.length === 0) {
    return false
  }

  // Reject if solution is mostly a commit message (short + contains "Closes:" or "Fixes:")
  if (strippedSolution.length < 150 && /(?:closes?|fixes?|resolves?):?\s*#\d+/i.test(strippedSolution)) {
    return false
  }

  // Reject if solution is mostly questions (not an actual resolution)
  const questionMarks = (strippedSolution.match(/\?/g) || []).length
  const periods = (strippedSolution.match(/\./g) || []).length || 1
  if (questionMarks > periods && strippedSolution.length < 300) {
    return false
  }

  // Reject if solution is just a "me too" or "+1" comment
  const solutionLower = strippedSolution.toLowerCase()
  if (/^(me too|same (?:issue|problem|here)|\+1|i (?:also|too) (?:have|see|get) this)/i.test(solutionLower.trim())) {
    return false
  }

  // Reject conversational tone — discussion comments, not actionable solutions
  if (/^(I think|I'm not sure|Let me explain|Thanks|Before you start|Rereading this)/i.test(strippedSolution.trim())) {
    return false
  }

  // Reject if solution starts with a comma (truncated quote fragment)
  if (strippedSolution.trim().startsWith(',')) {
    return false
  }

  // Reject if solution contains email reply headers
  if (/^On\s+.{10,80}\s+wrote:/m.test(strippedSolution)) {
    return false
  }

  // Actionability check — solution should contain commands, config, or clear instructions.
  // If it has no code blocks, no commands, and no numbered steps, it's likely just discussion.
  const hasCodeBlock = /```/.test(resolution.solution || '')
  const hasCommand = /\b(kubectl|helm|docker|curl|apt|brew|pip|npm|go |make)\b/.test(resolution.solution || '')
  const hasConfig = /\b(apiVersion|kind:|spec:|metadata:)\b/.test(resolution.solution || '')
  const hasStepsInSolution = /(?:^|\n)\s*\d+[\.\)]\s+/.test(resolution.solution || '')
  if (!hasCodeBlock && !hasCommand && !hasConfig && !hasStepsInSolution && resolution.yamlSnippets.length === 0) {
    // Allow through only if the solution is long enough to be a detailed prose explanation
    const PROSE_MIN_LENGTH = 300
    if (strippedSolution.length < PROSE_MIN_LENGTH) return false
  }

  return true
}

export function detectMissionType(issue) {
  const text = `${issue.title} ${(issue.labels || []).map(l => l.name).join(' ')}`.toLowerCase()

  // Label-based classification takes priority — labels are human-curated
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase())
  if (labels.some(l => l.includes('bug') || l === 'type/bug' || l === 'kind/bug')) return 'troubleshoot'
  if (labels.some(l => l.includes('feature') || l === 'enhancement' || l === 'kind/feature')) return 'feature'

  // RFCs and proposals are features, not troubleshoot — check before bug keywords
  // since RFCs may contain words like "fix" or "error" in their descriptions
  if (text.includes('[rfc]') || text.includes('[RFC]') || text.includes('rfc:') || text.includes('RFC:') || text.includes('proposal') || text.includes('design doc')) return 'feature'

  // Bug/error patterns — check first since these override feature keywords
  if (text.includes('bug') || text.includes('crash') || text.includes('error') || text.includes('fix')) return 'troubleshoot'
  // Session/auth issues are troubleshooting, not features
  if (text.includes('logged out') || text.includes('timeout') || text.includes('session expir') || text.includes('stopped working') || text.includes('not working') || text.includes('fails') || text.includes('failing') || text.includes('broken') || text.includes('unable') || text.includes('does not work') || text.includes('doesn\'t work') || text.includes('cannot') || text.includes('can\'t')) return 'troubleshoot'
  if (text.includes('upgrade') || text.includes('migration') || text.includes('breaking') || text.includes('deprecat')) return 'upgrade'
  if (text.includes('deploy') || text.includes('install') || text.includes('setup') || text.includes('helm')) return 'deploy'
  if (text.includes('performance') || text.includes('slow') || text.includes('memory') || text.includes('cpu') || text.includes('leak')) return 'analyze'
  if (text.includes('security') || text.includes('cve') || text.includes('vulnerab')) return 'troubleshoot'
  // Feature/enhancement keywords — default for PRs that add new functionality
  if (text.includes('feat') || text.includes('add') || text.includes('implement') || text.includes('support') || text.includes('new') || text.includes('enhance') || text.includes('introduce')) return 'feature'
  return 'feature'
}

export function extractLabels(issue) {
  return (issue.labels || [])
    .map(l => (typeof l === 'string' ? l : l.name))
    .filter(Boolean)
    .map(l => l.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
    .slice(0, 10)
}

export function extractResourceKinds(issue, project) {
  // Only extract K8s resource kinds for K8s-native projects
  if (project && !isKubernetesNative(project)) return []

  const text = `${issue.title} ${issue.body || ''}`.toLowerCase()
  const kinds = []
  // Use word-boundary matching to avoid false positives (e.g., "role" in "user role")
  const k8sResources = [
    'pod', 'deployment', 'ingress', 'configmap',
    'statefulset', 'daemonset', 'cronjob', 'namespace',
    'persistentvolumeclaim', 'persistentvolume', 'storageclass',
    'serviceaccount', 'clusterrole', 'clusterrolebinding',
    'rolebinding', 'networkpolicy',
    'replicaset', 'horizontalpodautoscaler', 'poddisruptionbudget',
    'customresourcedefinition', 'mutatingwebhookconfiguration',
    'validatingwebhookconfiguration',
  ]
  // Ambiguous words that need explicit K8s context (kubectl/helm/k8s mention) to count
  // "service" matches microservice/web service, "secret" matches client secret,
  // "role" matches user role, "node" matches Node.js
  const AMBIGUOUS_KINDS = new Set(['job', 'role', 'node', 'service', 'secret'])
  const hasK8sContext = /\bkubectl\b|\bkubernetes\b|\bk8s\b|\bhelm\b|\bkubeconfig\b/i.test(text)

  for (const kind of k8sResources) {
    // Use word boundary regex to avoid substring matches
    const regex = new RegExp(`\\b${kind}s?\\b`, 'i')
    if (regex.test(text)) {
      kinds.push(kind.charAt(0).toUpperCase() + kind.slice(1))
    }
  }

  // Only include ambiguous kinds if there's clear K8s context
  if (hasK8sContext) {
    for (const kind of AMBIGUOUS_KINDS) {
      const regex = new RegExp(`\\b${kind}s?\\b`, 'i')
      if (regex.test(text)) {
        kinds.push(kind.charAt(0).toUpperCase() + kind.slice(1))
      }
    }
  }

  const MAX_RESOURCE_KINDS = 3
  return [...new Set(kinds)].slice(0, MAX_RESOURCE_KINDS)
}

export function estimateDifficulty(issue) {
  const body = (issue.body || '').toLowerCase()
  const title = issue.title.toLowerCase()
  const text = `${title} ${body}`
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || '')).join(' ').toLowerCase()
  const commentCount = issue.comments || 0

  let score = 0

  // Long discussion = harder
  if (commentCount > 30) score += 3
  else if (commentCount > 15) score += 2
  else if (commentCount > 5) score += 1

  // Labels hint at complexity
  if (labels.includes('priority/critical') || labels.includes('severity/critical')) score += 2
  if (labels.includes('kind/cleanup') || labels.includes('good first issue')) score -= 2

  // Content complexity
  if (text.includes('race condition') || text.includes('deadlock') || text.includes('data loss')) score += 3
  if (text.includes('upgrade') || text.includes('migration')) score += 2
  if (text.includes('config') || text.includes('flag') || text.includes('env var')) score -= 1
  // Multi-component setups are harder (e.g., EKS + VPC CNI + Cilium chaining)
  if (text.includes('chaining') || text.includes('cni') || text.includes('vpc')) score += 2
  if (text.includes('wireguard') || text.includes('encryption') || text.includes('ipsec')) score += 1
  if (text.includes('bpf') || text.includes('ebpf') || text.includes('datapath')) score += 2
  if (text.includes('kernel') || text.includes('iptables') || text.includes('nftables')) score += 1
  // Integration scenarios with multiple products
  const productMentions = ['eks', 'gke', 'aks', 'openshift', 'rancher', 'aws', 'azure', 'gcp'].filter(p => text.includes(p))
  if (productMentions.length >= 2) score += 2
  else if (productMentions.length >= 1) score += 1

  if (score <= 0) return 'beginner'
  if (score <= 2) return 'intermediate'
  if (score <= 4) return 'advanced'
  return 'expert'
}
