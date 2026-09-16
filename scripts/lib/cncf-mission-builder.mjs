/**
 * Mission synthesis helpers for the CNCF mission generator.
 *
 * Extracted from generate-cncf-missions.mjs (console-kb#3133 / #3332) so the
 * pure mission-building functions (description, steps, resolution summary,
 * PR body) can be unit-tested independently of the GitHub scraping and
 * orchestration concerns that remain in the main script.
 */
import {
  truncateAtWordBoundary,
  truncateAtSentenceBoundary,
  stripPRTemplate,
  sanitizeInfraDetails,
  redactCredentials,
  slugify,
} from './text-utils.mjs'
import { detectMissionType, estimateDifficulty, extractResourceKinds } from './cncf-mission-quality.mjs'
import {
  isKubernetesNative,
  PROJECT_CLI_MAP,
  getProjectVersionCmd,
  getProjectStatusCmd,
  generatePrerequisites,
} from './cncf-project-metadata.mjs'

/**
 * Build a description from the issue body, extracting error messages and symptoms.
 * Varies phrasing by mission type — features don't "encounter errors".
 */
export function buildDescription(issue, resolution) {
  const body = truncateAtWordBoundary(issue.body || '', 500)
  const reactions = issue.reactions?.total_count || 0
  const mType = detectMissionType(issue)
  const isFeature = mType === 'feature' || mType === 'deploy'

  // Minimum reactions to include count in description — avoids "0+ users" or "2+ users"
  const MIN_REACTIONS_FOR_DISPLAY = 5

  if (isFeature) {
    const suffix = reactions >= MIN_REACTIONS_FOR_DISPLAY
      ? `Requested by ${reactions}+ users.`
      : `Community-requested feature.`
    return truncateAtWordBoundary(
      `${issue.title}. ${suffix}`,
      300,
    )
  }

  const errorMatch = body.match(/(?:error|ERROR|panic|fatal|FATAL|failed to)[:=]\s*([^\n]{10,100})/)?.[1]
  const suffix = reactions >= MIN_REACTIONS_FOR_DISPLAY
    ? `This issue affects ${reactions}+ users.`
    : `Community-reported issue.`
  const symptom = errorMatch
    ? `${issue.title}. Users encounter: "${errorMatch.trim()}".`
    : `${issue.title}. ${suffix}`
  return truncateAtWordBoundary(symptom, 300)
}

/**
 * Build the full mission JSON object with real pre-filled content.
 */
export function buildMissionJson({ project, issue, resolution, linkedPR, slug, missionType, difficulty }) {
  const cleanDesc = truncateAtWordBoundary(stripPRTemplate(resolution.problem || issue.body || ''), 500)
  const cleanSolution = truncateAtWordBoundary(stripPRTemplate(resolution.solution || ''), 500)

  return {
    version: 'kc-mission-v1',
    name: slug,
    missionClass: 'fixer',
    author: 'KubeStellar Bot',
    authorGithub: 'kubestellar',
    mission: {
      title: `${project.name}: ${issue.title}`,
      description: buildDescription(issue, resolution),
      type: missionType,
      status: 'completed',
      steps: buildDetailedSteps(issue, resolution, project, cleanDesc, cleanSolution),
      resolution: {
        summary: buildResolutionSummary(resolution, cleanSolution, missionType, {
          issue: issue.html_url,
          ...(linkedPR ? { pr: linkedPR.html_url } : {}),
        }),
        codeSnippets: (resolution.yamlSnippets || []).slice(0, 3).map(s => redactCredentials(sanitizeInfraDetails(s.slice(0, 800)))),
      },
    },
    metadata: {
      tags: [project.name, project.maturity, project.category, missionType].filter(Boolean),
      cncfProjects: [project.name],
      targetResourceKinds: extractResourceKinds({ body: (issue.body || '') + ' ' + (resolution.solution || ''), title: issue.title || '' }, project),
      difficulty,
      issueTypes: [missionType],
      maturity: project.maturity,
      sourceUrls: {
        issue: issue.html_url,
        repo: `https://github.com/${project.repo}`,
        ...(linkedPR ? { pr: linkedPR.html_url } : {}),
      },
      reactions: issue.reactions?.total_count || 0,
      comments: issue.comments || 0,
      synthesizedBy: 'copilot',
    },
    prerequisites: generatePrerequisites(project),
    security: {
      scannedAt: new Date().toISOString(),
      scannerVersion: 'cncf-gen-3.0.0',
      sanitized: true,
      findings: [],
    },
  }
}

/**
 * Build a kc-mission-v1 document from a CNCF project, GitHub issue, and extracted resolution.
 *
 * This is the public API surface for mission generation. It is a pure, deterministic
 * function — no network calls, no I/O, no LLM. Suitable for unit testing.
 *
 * Companion PR: kubestellar/console#8148 exposes scored missions via /api/missions/scores.
 * Ensure any changes to the output shape are reflected in the Go indexJsonFormat struct.
 *
 * @param {object} project  - CNCF project descriptor (name, repo, maturity, category)
 * @param {object} issue    - GitHub issue object (title, body, labels, html_url, number, reactions)
 * @param {object} resolution - Extracted resolution (problem, solution, yamlSnippets, steps)
 * @returns {Promise<object>} kc-mission-v1 document (async to allow future LLM enrichment via opt-in hook)
 */
export async function generateMission(project, issue, resolution) {
  const missionType = detectMissionType(issue)
  const difficulty = estimateDifficulty(issue)
  const slug = slugify(`${project.name}-${issue.number}-${issue.title}`)
  const linkedPR = resolution._linkedPR || null

  return buildMissionJson({ project, issue, resolution, linkedPR, slug, missionType, difficulty })
}

/**
 * Build detailed steps from the issue and resolution context.
 * Uses project-aware namespaces and commands instead of hardcoded cert-manager.
 * Non-Kubernetes projects get application-specific steps instead of kubectl commands.
 */
function buildDetailedSteps(issue, resolution, project, cleanDesc, cleanSolution) {
  const steps = []
  const body = issue.body || ''
  const k8sNative = isKubernetesNative(project)

  // Derive project-specific namespace and helm repo (not hardcoded cert-manager)
  const namespace = project.namespace || project.name
  const versionCmd = getProjectVersionCmd(project)
  const statusCmd = getProjectStatusCmd(project)
  const helmRepo = project.helmRepo || project.name
  const mType = detectMissionType(issue)
  const isFeature = mType === 'feature' || mType === 'deploy'

  // Step 1: Context — varies by mission type
  // Only use actual error patterns from the body, never the issue title
  // Require colon/equals after keyword to avoid matching prose like "error output, etc"
  const errorMatch = body.match(/(?:error|ERROR|panic|fatal|FATAL|failed to)[:=]\s*([^\n]{10,120})/)?.[1]

  if (isFeature) {
    // Feature requests: check current state, not "look for errors"
    if (k8sNative) {
      steps.push({
        title: `Check current ${project.name} deployment`,
        description: [
          `Verify your ${project.name} version and configuration:`,
          '```bash',
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
          `helm list -n ${namespace} 2>/dev/null || echo "Not installed via Helm"`,
          '```',
          `This feature requires a working ${project.name} installation.`,
        ].join('\n')
      })
    } else if (versionCmd) {
      steps.push({
        title: `Check current ${project.name} setup`,
        description: [
          `Verify your ${project.name} version and configuration:`,
          '```bash',
          versionCmd,
          '```',
          `This feature requires a working ${project.name} installation.`,
        ].join('\n')
      })
    } else {
      // Library/framework with no CLI — describe how to check the dependency
      const mapped = PROJECT_CLI_MAP[project.name]
      const checkDesc = mapped?.description || `Check your ${project.name} dependency version in your project manifest (package.json, go.mod, Cargo.toml, requirements.txt, etc.).`
      steps.push({
        title: `Check current ${project.name} setup`,
        description: [
          `Verify your ${project.name} version:`,
          checkDesc,
          `This feature requires ${project.name} as a dependency.`,
        ].join('\n')
      })
    }
  } else {
    // Troubleshoot/analyze: look for specific errors
    if (k8sNative) {
      steps.push({
        title: `Identify ${project.name} ${mType} symptoms`,
        description: [
          `Check for the issue in your ${project.name} deployment:`,
          '```bash',
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
          `kubectl logs -l app.kubernetes.io/name=${project.name} -n ${namespace} --tail=100 | grep -i error`,
          '```',
          errorMatch ? `Look for error: \`${errorMatch.trim()}\`` : `Look for errors or warnings in the logs that may indicate the issue.`,
        ].join('\n')
      })
    } else if (versionCmd) {
      const cmdLines = [versionCmd]
      if (statusCmd) cmdLines.push(statusCmd)
      steps.push({
        title: `Identify ${project.name} ${mType} symptoms`,
        description: [
          `Check for the issue in your ${project.name} installation:`,
          '```bash',
          ...cmdLines,
          '```',
          errorMatch ? `Look for error: \`${errorMatch.trim()}\`` : `Look for errors or warnings that may indicate the issue.`,
        ].join('\n')
      })
    } else {
      // Library with no CLI — describe how to reproduce
      const mapped = PROJECT_CLI_MAP[project.name]
      const checkDesc = mapped?.description || `Check your ${project.name} dependency version in your project manifest.`
      steps.push({
        title: `Identify ${project.name} ${mType} symptoms`,
        description: [
          `Check for the issue in your ${project.name} setup:`,
          checkDesc,
          errorMatch ? `Look for error: \`${errorMatch.trim()}\`` : `Check your build output and test logs for errors related to this issue.`,
        ].join('\n')
      })
    }
  }

  // Step 2: Understand the issue context
  // Don't use auto-detected resourceKinds for kubectl commands — they produce
  // false positives (e.g., "service" from "microservice", "role" from "user role").
  // Instead, describe the issue context with the project-specific configuration.
  const descSnippet = truncateAtSentenceBoundary(cleanDesc, 250)
  if (k8sNative) {
    steps.push({
      title: `Review ${project.name} configuration`,
      description: [
        `Inspect the relevant ${project.name} configuration:`,
        '```bash',
        `kubectl get all -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
        `kubectl get configmap -n ${namespace} -l app.kubernetes.io/part-of=${project.name}`,
        '```',
        descSnippet,
      ].join('\n')
    })
  } else {
    steps.push({
      title: `Review ${project.name} configuration`,
      description: [
        `Review the relevant ${project.name} configuration:`,
        descSnippet,
      ].join('\n')
    })
  }

  // Step 3: Apply the fix
  if (resolution.yamlSnippets?.length > 0) {
    steps.push({
      title: `Apply the fix for ${truncateAtWordBoundary(issue.title, 60, { ellipsis: true })}`,
      description: [
        truncateAtWordBoundary(cleanSolution, 300) || `Apply the configuration change to resolve the issue:`,
        '```yaml',
        resolution.yamlSnippets[0].slice(0, 600),
        '```',
      ].join('\n')
    })
  } else if (cleanSolution) {
    steps.push({
      title: `Apply the fix for ${truncateAtWordBoundary(issue.title, 60, { ellipsis: true })}`,
      description: [
        truncateAtWordBoundary(cleanSolution, 500),
        '',
        resolution.prUrl
          ? `See the fix PR for details: ${resolution.prUrl}`
          : `See the source issue for community-verified solutions.`,
      ].join('\n')
    })
  } else {
    steps.push({
      title: `Apply the recommended fix`,
      description: `Apply the fix as described in the source issue. Check ${issue.html_url} for community-verified solutions.`
    })
  }

  // Step 4: Upgrade if there's a version fix (only for K8s-native projects with Helm)
  if (k8sNative && (resolution.prUrl || resolution.solution?.includes('upgrade') || resolution.solution?.includes('version'))) {
    steps.push({
      title: `Upgrade ${project.name} to include the fix`,
      description: [
        `If the fix is included in a newer release, upgrade ${project.name}:`,
        '```bash',
        `helm repo update`,
        `helm upgrade ${project.name} ${helmRepo}/${project.name} --namespace ${namespace}`,
        '```',
        'Verify the upgrade:',
        '```bash',
        `kubectl get pods -n ${namespace}`,
        `helm list -n ${namespace}`,
        '```',
      ].join('\n')
    })
  } else if (!k8sNative && (resolution.prUrl || resolution.solution?.includes('upgrade') || resolution.solution?.includes('version'))) {
    const upgradeLines = [`If the fix is included in a newer release, upgrade ${project.name}:`]
    if (versionCmd) {
      upgradeLines.push('```bash', `# Check current version`, versionCmd)
      upgradeLines.push(`# Follow the project's upgrade guide at https://github.com/${project.repo}`, '```')
    } else {
      upgradeLines.push(`Update the ${project.name} dependency in your project manifest to the latest version.`)
      upgradeLines.push(`See the project's releases: https://github.com/${project.repo}/releases`)
    }
    steps.push({
      title: `Upgrade ${project.name} to include the fix`,
      description: upgradeLines.join('\n')
    })
  }

  // Step 5: Verify — varies by mission type
  if (isFeature) {
    if (k8sNative) {
      steps.push({
        title: `Verify the feature works`,
        description: [
          `Test that the new capability is working as expected:`,
          '```bash',
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/name=${project.name}`,
          `kubectl get events -n ${namespace} --sort-by='.lastTimestamp' | tail -10`,
          '```',
          `Confirm the feature described in "${truncateAtWordBoundary(issue.title, 60, { ellipsis: true })}" is functioning correctly.`,
        ].join('\n')
      })
    } else {
      steps.push({
        title: `Verify the feature works`,
        description: [
          `Test that the new capability is working as expected.`,
          `Confirm the feature described in "${truncateAtWordBoundary(issue.title, 60, { ellipsis: true })}" is functioning correctly.`,
        ].join('\n')
      })
    }
  } else {
    if (k8sNative) {
      steps.push({
        title: `Confirm ${truncateAtWordBoundary(issue.title, 50, { ellipsis: true })} is resolved`,
        description: [
          `Verify the fix by checking that the original error no longer occurs:`,
          '```bash',
          `kubectl logs -l app.kubernetes.io/name=${project.name} -n ${namespace} --tail=50 --since=5m`,
          `kubectl get events -n ${namespace} --sort-by='.lastTimestamp' | tail -10`,
          '```',
          errorMatch ? `Confirm that \`${errorMatch.trim()}\` no longer appears in logs.` : 'Confirm that the issue symptoms are gone.',
        ].join('\n')
      })
    } else {
      steps.push({
        title: `Confirm ${truncateAtWordBoundary(issue.title, 50, { ellipsis: true })} is resolved`,
        description: [
          `Verify the fix by checking that the original error no longer occurs:`,
          `Test ${project.name} to confirm the issue is resolved.`,
          errorMatch ? `Confirm that \`${errorMatch.trim()}\` no longer appears.` : 'Confirm that the issue symptoms are gone.',
        ].join('\n')
      })
    }
  }

  return steps
}

/**
 * Build resolution summary from available context.
 * Strips PR template boilerplate and avoids tautological filler text.
 * Ensures the summary ends at a sentence boundary (period, not mid-word).
 */
export function buildResolutionSummary(resolution, cleanSolution, missionType, sourceUrls) {
  if (cleanSolution && cleanSolution.length > 50) {
    const summary = truncateAtSentenceBoundary(cleanSolution, 400)
    // Skip if after cleaning it's just empty or too short to be useful
    if (summary.length < 30) {
      return sanitizeInfraDetails(redactCredentials(buildResolutionFallback(sourceUrls)))
    }
    return sanitizeInfraDetails(redactCredentials(summary))
  }
  return sanitizeInfraDetails(redactCredentials(buildResolutionFallback(sourceUrls)))
}

/** Build a useful fallback when no clean solution text is available. */
function buildResolutionFallback(sourceUrls) {
  if (sourceUrls?.pr) return `See the fix PR for the community-verified solution: ${sourceUrls.pr}`
  if (sourceUrls?.issue) return `See the source issue for the community-verified solution: ${sourceUrls.issue}`
  return `See the linked issue and PR for the community-verified solution.`
}

/**
 * Build PR body with context for reviewers and Copilot.
 */
export function buildPRBody({ project, issue, resolution, linkedPR, filePath, missionType }) {
  const sections = []
  sections.push(`## 🌱 New Mission: ${project.name} — ${issue.title}`)
  sections.push('')
  sections.push(`**Type:** ${missionType} | **Source:** ${issue.html_url} (${issue.reactions?.total_count || 0} reactions)`)
  if (linkedPR) sections.push(`**Fix PR:** ${linkedPR.html_url}`)
  sections.push(`**File:** \`${filePath}\``)
  sections.push('')
  sections.push('### Copilot: Please enhance this mission')
  sections.push('')
  sections.push('The JSON file has been pre-filled with content from the source issue. Please improve:')
  sections.push('1. Make step descriptions more specific with exact commands for this issue')
  sections.push('2. Add the exact error message to the description if missing')
  sections.push('3. Explain the root cause in the resolution summary')
  sections.push('4. Add relevant YAML/code snippets to codeSnippets if missing')
  sections.push('5. Run `node scripts/scanner.mjs` to validate')
  sections.push('')
  sections.push(`*Auto-generated by CNCF Mission Generator*`)
  return sections.join('\n')
}
