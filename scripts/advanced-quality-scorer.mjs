/**
 * AI-driven Knowledge Base Quality Scoring System (Architecture)
 * Scores each KB entry (0-100) on clarity, completeness, correctness, structure, and observability.
 * Implements a pluggable architecture for eventual LLM generation of issues and suggestions.
 */

const DEFAULT_THRESHOLD = parseInt(process.env.QUALITY_THRESHOLD || '60', 10);

/**
 * Score a mission object on quality dimensions.
 * @param {object} mission - Full object
 * @param {string} project - The project name
 * @param {string} filepath - Path to the file being scored
 * @returns {object} - Structured ScoreResult
 */
export function scoreMissionAdvanced(missionObj, project = 'unknown', filepath = 'unknown', threshold = DEFAULT_THRESHOLD) {
  const m = missionObj.mission || {};
  const meta = missionObj.metadata || {};

  const issues = [];
  const suggestions = [];

  // 1. Clarity (0-100)
  const clarityScore = evaluateClarity(m, issues, suggestions);

  // 2. Completeness (0-100)
  const completenessScore = evaluateCompleteness(m, issues, suggestions);

  // 3. Correctness (0-100)
  const correctnessScore = evaluateCorrectness(m, issues, suggestions);

  // 4. Structure (0-100)
  const structureScore = evaluateStructure(m, meta, issues, suggestions);

  // 5. Observability (0-100)
  const observabilityScore = evaluateObservability(m, issues, suggestions);

  // Todo: AI-PLUG-IN
  // In the future the issues/suggestions arrays could be overwritten by a real LLM call here:
  // if (process.env.USE_AI_SCORER === 'true') {
  //   const aiResult = callLlm(m);
  //   issues.push(...aiResult.issues);
  //   suggestions.push(...aiResult.suggestions);
  // }

  const breakdown = {
    clarity: clarityScore,
    completeness: completenessScore,
    correctness: correctnessScore,
    structure: structureScore,
    observability: observabilityScore
  };

  // Compute final score with weights
  const weights = {
    clarity: 0.25,
    completeness: 0.20,
    correctness: 0.25,
    structure: 0.15,
    observability: 0.15
  };

  const finalScore = Math.round(
    breakdown.clarity * weights.clarity +
    breakdown.completeness * weights.completeness +
    breakdown.correctness * weights.correctness +
    breakdown.structure * weights.structure +
    breakdown.observability * weights.observability
  );

  return {
    project: typeof meta.cncfProjects !== 'undefined' && meta.cncfProjects.length > 0 ? meta.cncfProjects[0] : project,
    path: filepath,
    score: finalScore,
    breakdown,
    issues: [...new Set(issues)], // Remove duplicates
    suggestions: [...new Set(suggestions)],
    pass: finalScore >= threshold
  };
}

function evaluateClarity(m, issues, suggestions) {
  let score = 100;
  const desc = (m.description || '');

  if (desc.length < 30) {
    score -= 20;
    issues.push("Description is too brief or ambiguous");
    suggestions.push("Provide more context about the problem symptoms in the description");
  }

  // Penalize Codecov/stale bot boilerplates
  const lowerDesc = desc.toLowerCase();
  if (lowerDesc.includes('codecov') || lowerDesc.includes('has been automatically marked as stale')) {
    score -= 40;
    issues.push("Description contains auto-generated bot noise");
    suggestions.push("Remove bot messages from the description");
  }

  // PR template leftovers
  if (lowerDesc.includes('what this pr does') || lowerDesc.includes('special notes for your reviewer')) {
    score -= 20;
    issues.push("Description contains leftover PR template text");
    suggestions.push("Clean up the PR template boilerplate to focus on the KB solution");
  }

  return Math.max(0, score);
}

function evaluateCompleteness(m, issues, suggestions) {
  let score = 100;
  const steps = m.steps || [];
  const resolution = m.resolution || {};

  if (steps.length === 0) {
    score -= 50;
    issues.push("Missing actionable steps");
    suggestions.push("Add detailed, step-by-step instructions to reproduce or fix the issue");
  } else if (steps.length < 2) {
    score -= 20;
    issues.push("Insufficient steps to fully cover problem and resolution");
    suggestions.push("Break down the fix into multiple steps covering prerequisites, application, and verification");
  }

  if (!resolution.summary || resolution.summary.length < 20) {
    score -= 30;
    issues.push("Missing or inadequate resolution summary");
    suggestions.push("Add a detailed summary of why this change resolves the issue");
  }

  return Math.max(0, score);
}

function evaluateCorrectness(m, issues, suggestions) {
  let score = 100;
  const steps = m.steps || [];
  const snippets = m.resolution?.codeSnippets || [];

  let hasValidCode = false;

  for (const step of steps) {
    const desc = step.description || '';
    if (desc.includes('```')) hasValidCode = true;

    // Penalize git diffs as they are not actionable config changes
    if (desc.includes('diff --git') && desc.includes('--- a/')) {
      score -= 25;
      issues.push("Includes raw git diff output instead of actionable commands or YAML");
      suggestions.push("Refactor git diffs into actual kubectl commands, complete YAML objects, or script changes");
    }
  }

  if (snippets.length > 0) hasValidCode = true;

  if (!hasValidCode) {
    score -= 30;
    issues.push("Instruction logic missing required configuration fragments or commands");
    suggestions.push("Include complete YAML manifests or CLI commands (e.g., using fenced code blocks)");
  }

  return Math.max(0, score);
}

function evaluateStructure(m, meta, issues, suggestions) {
  let score = 100;
  const tags = meta.tags || [];
  const difficulty = meta.difficulty || '';

  if (tags.length === 0) {
    score -= 20;
    issues.push("Missing categorization tags");
    suggestions.push("Add relevant tags to help users discover this KB entry");
  }

  if (!difficulty || difficulty.trim() === '') {
    score -= 10;
    issues.push("Difficulty level not set");
    suggestions.push("Define the difficulty (e.g., beginner, intermediate, advanced)");
  }

  const stepsLength = (m.steps || []).length;
  let genericTitles = 0;
  for (const step of m.steps || []) {
    const title = (step.title || '').toLowerCase();
    if (title.includes('understand') || title.includes('verify the fix') || title.includes('apply the fix')) {
      genericTitles++;
    }
  }

  if (stepsLength > 0 && genericTitles >= stepsLength) {
    score -= 30;
    issues.push("Step titles are completely generic");
    suggestions.push("Use more descriptive step titles indicating the action (e.g., 'Deploy valid configuration map' instead of 'Apply the fix')");
  }

  return Math.max(0, score);
}

function evaluateObservability(m, issues, suggestions) {
  let score = 100;
  const steps = m.steps || [];
  let hasVerification = false;
  let hasLogsOrEvents = false;

  for (const step of steps) {
    const title = (step.title || '').toLowerCase();
    const desc = (step.description || '').toLowerCase();

    if (title.includes('verify') || title.includes('check') || title.includes('validate') || title.includes('test')) {
      hasVerification = true;
    }

    if (desc.match(/kubectl(\s+-[nN]\s+\S+)?\s+(get|describe|logs|top)\s+/)) {
      hasVerification = true;
      hasLogsOrEvents = true;
    }

    if (desc.includes('helm test') || desc.includes('curl ') || desc.includes('grep ')) {
      hasVerification = true;
    }

    if (desc.includes('success') || desc.includes('failed') || desc.includes('error:')) {
      hasLogsOrEvents = true; // Output expectation shown
    }
  }

  if (!hasVerification) {
    score -= 40;
    issues.push("No verification step or command found");
    suggestions.push("Add a final step to verify that the fix was successfully applied (e.g., checking pod status)");
  }

  if (!hasLogsOrEvents) {
    score -= 30;
    issues.push("Missing expected output or log checks");
    suggestions.push("Include command outputs or log tailing instructions (e.g., kubectl get events/logs) to help users confirm success");
  }

  return Math.max(0, score);
}
