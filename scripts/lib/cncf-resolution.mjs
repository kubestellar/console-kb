/**
 * Resolution extraction helpers for the CNCF mission generator.
 *
 * Extracted from generate-cncf-missions.mjs (console-kb#3133 / #3332) so the
 * problem/solution mining from issues, linked PRs, and comments can be
 * unit-tested independently of the GitHub scraping and mission-synthesis
 * concerns that remain in the main script.
 */
import {
  cleanText,
  isGarbageSnippet,
  truncateAtWordBoundary,
  extractFromNumberedTemplate,
  extractFromBoldTemplate,
} from './text-utils.mjs'

export function extractResolutionFromIssue(issue, comments, linkedPR) {
  const resolution = {
    problem: '',
    solution: '',
    yamlSnippets: [],
    steps: [],
  }

  // Extract problem from issue body using flexible header matching
  const body = issue.body || ''
  const problemMatch = body.match(/#{1,4}\s*(?:problem|description|bug\s*report|issue|context|summary|background)\s*\n([\s\S]*?)(?=\n#{1,4}\s|\n---|\Z)/i)
  resolution.problem = problemMatch
    ? truncateAtWordBoundary(cleanText(problemMatch[1]), 1000)
    : truncateAtWordBoundary(cleanText(body), 1000)

  // Extract solution from linked PR body first, then fallback to comments
  if (linkedPR?.body) {
    const prBody = linkedPR.body
    const solutionMatch = prBody.match(/#{1,4}\s*(?:solution|fix|changes|description|approach|implementation|what\s+this\s+pr\s+does)\s*\n([\s\S]*?)(?=\n#{1,4}\s|\n---|\Z)/i)
    if (solutionMatch) {
      resolution.solution = truncateAtWordBoundary(cleanText(solutionMatch[1]), 1500)
    } else {
      // Try extracting from numbered template format (### 1. Why is this PR needed?)
      let extracted = extractFromNumberedTemplate(prBody)
      // Try extracting from bold-header template (**What type of PR is this?**)
      if (extracted === prBody) {
        extracted = extractFromBoldTemplate(prBody)
      }
      resolution.solution = truncateAtWordBoundary(cleanText(extracted), 1500)
    }
  }

  // Filter out low-quality resolution patterns
  const LOW_QUALITY_PATTERNS = [
    /hereby agree to the terms of the CLA/i,
    /Pre-Submission checklist/i,
    /What is the problem you're trying to solve/i,
    /Does this PR introduce a user-facing change/i,
    /I (had|have) the same (issue|problem|error)/i,
    /me too/i,
    /same here/i,
    /\+1$/,
    /WIP|work in progress/i,
    // Conversational tone — discussion, not a solution
    /^I think\b/i,
    /^I'm not (?:quite )?sure/i,
    /^Let me explain/i,
    /^Thanks[.,!]?\s/i,
    /^Thanks for/i,
    /^Before you start/i,
    /^I'd like to ensure/i,
    /^Rereading this thread/i,
    /^I can't reproduce/i,
    // Email reply headers
    /^On .{10,80} wrote:$/m,
    // Meeting/scheduling content
    /\bmeeting time\b/i,
    /\bgoogle docs?\b.*\blink\b/i,
    // PR template debris
    /\*\*What type of PR is this\?\*\*/i,
    /Pre-submission checklist/i,
    /Make sure you include information that can help us debug/i,
  ]

  function isLowQualityComment(text) {
    return LOW_QUALITY_PATTERNS.some(pattern => pattern.test(text))
  }

  // If no PR-based solution, score comments and pick the best resolution
  if (!resolution.solution && comments.length > 0) {
    const MIN_COMMENT_LENGTH = 50
    const scoredComments = comments
      .filter(c => c.body && c.body.length > MIN_COMMENT_LENGTH && !isLowQualityComment(c.body))
      .map(c => {
        let score = 0
        const bodyLower = (c.body || '').toLowerCase()
        const bodyTrimmed = c.body.trim()
        // Author authority
        if (c.author_association === 'OWNER') score += 10
        else if (c.author_association === 'MEMBER') score += 8
        else if (c.author_association === 'COLLABORATOR') score += 6
        else if (c.author_association === 'CONTRIBUTOR') score += 3
        // Resolution keywords
        if (bodyLower.includes('fixed in')) score += 5
        if (bodyLower.includes('resolved by')) score += 5
        if (bodyLower.includes('the fix')) score += 4
        if (bodyLower.includes('solution')) score += 3
        if (bodyLower.includes('workaround')) score += 3
        // Contains code = more actionable
        if (c.body.includes('```')) score += 4
        // Length bonus (more detail = better)
        if (c.body.length > 200) score += 2
        if (c.body.length > 500) score += 2
        // NEGATIVE: question-heavy comments are not solutions
        const questionMarks = (bodyTrimmed.match(/\?/g) || []).length
        const sentences = (bodyTrimmed.match(/[.!?]/g) || []).length || 1
        if (questionMarks / sentences > 0.5) score -= 5
        // NEGATIVE: short comments that are just reactions/greetings
        if (bodyLower.match(/^(thanks|thank you|yay|great|lgtm|nice|awesome|👍|🎉|\+1)/)) score -= 8
        // NEGATIVE: "me too" / "same issue" comments
        if (bodyLower.match(/^(me too|same (?:issue|problem|here)|i (?:also|too) (?:have|see|get))/)) score -= 6
        // NEGATIVE: bot-generated comments (codecov, stale bot, CI bots)
        if (c.user?.type === 'Bot' || bodyLower.includes('codecov') || bodyLower.includes('stale bot')) score -= 10
        // NEGATIVE: conversational/discussion tone (not solutions)
        if (/^(I think|I'm not sure|Let me explain|Thanks|Before you start|Rereading)/i.test(bodyTrimmed)) score -= 6
        // NEGATIVE: email reply headers
        if (/^On\s+.{10,80}\s+wrote:/m.test(bodyTrimmed)) score -= 8
        // NEGATIVE: embedded HTML images (raw GitHub comment screenshots)
        if (/<img\s+/i.test(bodyTrimmed)) score -= 5
        return { comment: c, score }
      })
      .sort((a, b) => b.score - a.score)

    const MIN_COMMENT_SCORE = 8
    if (scoredComments.length > 0 && scoredComments[0].score >= MIN_COMMENT_SCORE) {
      resolution.solution = truncateAtWordBoundary(cleanText(scoredComments[0].comment.body), 1500)
    }
  }

  // Extract YAML/code blocks from all sources, filtering out CI/bot garbage
  const allText = [body, linkedPR?.body || '', ...comments.map(c => c.body || '')].join('\n')
  const codeBlocks = allText.matchAll(/```(?:ya?ml|json|bash|shell|sh)?\s*\n([\s\S]*?)```/g)
  for (const match of codeBlocks) {
    const snippet = match[1].trim().replace(/\r\n/g, '\n')
    if (snippet.length > 10 && snippet.length < 5000 && !isGarbageSnippet(snippet)) {
      resolution.yamlSnippets.push(snippet)
    }
    if (resolution.yamlSnippets.length >= 5) break
  }

  // Extract numbered steps from resolution text
  const stepsSource = resolution.solution || resolution.problem
  const stepsMatch = stepsSource.match(/(?:^|\n)\s*\d+[\.\)]\s+.+/g)
  if (stepsMatch) {
    resolution.steps = stepsMatch
      .map(s => s.replace(/^\s*\d+[\.\)]\s+/, '').trim())
      .filter(s => s.length > 5)
      .slice(0, 10)
  }

  return resolution
}
