/**
 * Post-generation quality scorer for CNCF missions.
 * Scores each mission 0-100 across multiple dimensions.
 * Missions below the threshold are dropped.
 */

const DEFAULT_THRESHOLD = parseInt(process.env.QUALITY_THRESHOLD || '70', 10)

/**
 * Score a mission object on quality dimensions.
 * @param {object} mission - Full kc-mission-v1 mission object
 * @returns {{ score: number, breakdown: Record<string, number>, pass: boolean }}
 */
export function scoreMission(mission, threshold = DEFAULT_THRESHOLD) {
  const m = mission.mission || {}
  const meta = mission.metadata || {}
  const breakdown = {}

  // 1. Steps specificity (20 pts)
  breakdown.stepsSpecificity = scoreSteps(m.steps || [])

  // 2. Description clarity (20 pts)
  breakdown.descriptionClarity = scoreDescription(m.description || '')

  // 3. Resolution completeness (20 pts)
  breakdown.resolutionCompleteness = scoreResolution(m.resolution || {})

  // 4. Code/YAML presence (15 pts)
  breakdown.codePresence = scoreCode(m.steps || [], m.resolution?.codeSnippets || [])

  // 5. Metadata quality (10 pts)
  breakdown.metadataQuality = scoreMetadata(meta)

  // 6. Content uniqueness (15 pts) — penalizes generic/template content
  breakdown.contentUniqueness = scoreUniqueness(m)

  const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0)

  return {
    score: Math.round(score),
    breakdown,
    pass: score >= threshold,
  }
}

function scoreSteps(steps) {
  if (!steps.length) return 0
  if (steps.length < 2) return 3

  let score = 0
  const maxPts = 20

  // More steps (up to 6) = better
  score += Math.min(steps.length, 6) * 1.5 // max 9

  for (const step of steps) {
    const desc = step.description || ''
    // Contains a command (kubectl, helm, etc)
    if (/(?:kubectl|helm|docker|curl|git|apt|pip|npm|make|go )\s/.test(desc)) score += 1.5
    // Contains YAML/code block
    if (desc.includes('```') || desc.includes('apiVersion:') || desc.includes('kind:')) score += 1
    // Contains a file path
    if (/\/[\w-]+\/[\w.-]+/.test(desc)) score += 0.5
    // Step title is specific (not generic)
    const title = (step.title || '').toLowerCase()
    if (!title.includes('understand') && !title.includes('verify') && !title.includes('review')) score += 0.5
  }

  return Math.min(score, maxPts)
}

function scoreDescription(desc) {
  if (!desc) return 0

  let score = 0
  const maxPts = 20

  // Length — too short is bad, too long is bad
  if (desc.length >= 50 && desc.length <= 500) score += 6
  else if (desc.length >= 30) score += 3

  // Contains a recognizable error message or symptom
  if (/error|fail|crash|timeout|denied|refused|not found|cannot|unable/i.test(desc)) score += 4

  // Contains specific technical terms (not just generic text)
  if (/\b(?:pod|container|deployment|service|node|cluster|namespace|ingress|configmap|secret)\b/i.test(desc)) score += 3

  // Contains a version number or specific component
  if (/v?\d+\.\d+|kubernetes|k8s|helm|docker/i.test(desc)) score += 2

  // Not PR template junk
  if (!/what this pr does|which issue|release note|special notes/i.test(desc)) score += 3

  // Has sentence structure (starts with capital, has periods)
  if (/^[A-Z]/.test(desc) && desc.includes('.')) score += 2

  return Math.min(score, maxPts)
}

function scoreResolution(resolution) {
  if (!resolution) return 0

  let score = 0
  const maxPts = 20

  const summary = resolution.summary || ''

  // Has a meaningful summary
  if (summary.length > 100) score += 6
  else if (summary.length > 50) score += 3

  // Explains WHY, not just WHAT
  if (/because|since|this works|this fixes|the root cause|this ensures|this prevents/i.test(summary)) score += 5

  // Has resolution steps
  const steps = resolution.steps || []
  if (steps.length >= 3) score += 4
  else if (steps.length >= 1) score += 2

  // Not generic filler
  if (!/see linked pr for|review the issue/i.test(summary)) score += 3

  // Contains code snippets
  if (resolution.codeSnippets?.length > 0) score += 2

  return Math.min(score, maxPts)
}

function scoreCode(steps, codeSnippets) {
  let score = 0
  const maxPts = 15

  // Code snippets in resolution
  score += Math.min(codeSnippets.length, 3) * 2 // max 6

  // Code in step descriptions
  for (const step of steps) {
    const desc = step.description || ''
    if (desc.includes('```')) score += 2
    if (/kubectl|helm|docker/.test(desc)) score += 1
  }

  // YAML with apiVersion/kind = very actionable
  for (const snippet of codeSnippets) {
    if (snippet.includes('apiVersion:') && snippet.includes('kind:')) {
      score += 3
      break
    }
  }

  return Math.min(score, maxPts)
}

function scoreMetadata(meta) {
  let score = 0
  const maxPts = 10

  // Has tags
  if ((meta.tags || []).length >= 3) score += 2
  else if ((meta.tags || []).length >= 1) score += 1

  // Has resource kinds
  if ((meta.targetResourceKinds || []).length > 0) score += 2

  // Has difficulty set (not just default)
  if (meta.difficulty && meta.difficulty !== 'intermediate') score += 1
  else score += 0.5

  // Has source issue link
  if (meta.sourceUrls?.issue || meta.sourceUrls?.source || meta.sourceIssue) score += 2

  // Has reactions (engagement indicator)
  if (meta.reactions > 20) score += 2
  else if (meta.reactions > 5) score += 1

  // Has cncfProjects
  if ((meta.cncfProjects || []).length > 0) score += 1

  return Math.min(score, maxPts)
}

function scoreUniqueness(mission) {
  let score = 15 // Start at max and deduct for generic content
  const maxPts = 15

  const desc = (mission.description || '').toLowerCase()
  const resSum = (mission.resolution?.summary || '').toLowerCase()
  const allText = desc + ' ' + resSum

  // Collect all step/snippet text for garbage detection
  const allSnippets = (mission.resolution?.codeSnippets || []).join('\n').toLowerCase()
  const allStepDescs = (mission.steps || []).map(s => (s.description || '').toLowerCase()).join('\n')

  // Penalize generic filler phrases
  const genericPhrases = [
    'review the issue',
    'check the documentation',
    'see the linked',
    'apply the fix',
    'understand the problem',
    'verify the fix',
    'review the changes',
    'confirm that the issue',
  ]
  for (const phrase of genericPhrases) {
    if (allText.includes(phrase)) score -= 2
  }

  // HEAVY penalty for Codecov/CI bot garbage in content (-10 points)
  if (allSnippets.includes('codecov') || allSnippets.includes('coverage δ') || allStepDescs.includes('codecov')) {
    score -= 10
  }

  // Penalty for CI bot messages in resolution (-5 points)
  if (resSum.includes('invalid pr title') || resSum.includes('has been automatically marked as stale') || resSum.includes('rerun ut')) {
    score -= 5
  }

  // Penalty for git diff in steps (-5 points, not actionable config)
  if (allStepDescs.includes('diff --git') || allStepDescs.includes('index ') && allStepDescs.includes('--- a/')) {
    score -= 5
  }

  // Penalty for "Changelog category" PR template in description (-3 points)
  if (desc.includes('changelog category') || desc.includes('changelog entry')) {
    score -= 3
  }

  // Penalize if steps are all generic titles
  const steps = mission.steps || []
  const genericTitles = steps.filter(s => {
    const t = (s.title || '').toLowerCase()
    return t.includes('understand') || t.includes('verify the fix') || t.includes('review the fix')
  })
  if (genericTitles.length > steps.length * 0.5) score -= 3

  // Bonus for specific project/component names in description
  if (/\b[A-Z][a-zA-Z]+(?:Controller|Manager|Operator|Server|Client|Proxy|Agent|Router)\b/.test(mission.description || '')) {
    score += 2
  }

  return Math.max(0, Math.min(score, maxPts))
}
