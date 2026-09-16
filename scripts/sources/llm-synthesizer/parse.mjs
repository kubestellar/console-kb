/**
 * Response parsing/validation utilities for the LLM synthesizer:
 * JSON extraction from raw model output, mission-shape validation/cleanup,
 * string truncation, and the retry sleep helper.
 * Extracted from scripts/sources/llm-synthesizer.mjs (console-kb#3196).
 */

// --- Response parsing ---

export function extractJSON(text) {
  if (!text) return text
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed
  // Use last closing fence so embedded code blocks inside the JSON don't truncate it
  const openMatch = trimmed.match(/```(?:json)?\s*\n?/)
  if (openMatch) {
    const contentStart = openMatch.index + openMatch[0].length
    const closingFence = trimmed.lastIndexOf('```')
    if (closingFence > contentStart) return trimmed.slice(contentStart, closingFence).trim()
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

// --- Validation ---

const BANNED_STEP_TITLES = [
  'understand the problem', 'review the issue', 'check the documentation',
  'apply the configuration', 'review the fix', 'verify the fix',
  'review the changes', 'confirm the fix', 'apply the fix',
]

export function validateAndClean(parsed) {
  const steps = (parsed.steps || [])
    .filter(s => s.title && s.description)
    .filter(s => !BANNED_STEP_TITLES.includes(s.title.toLowerCase().trim()))
    .map(s => ({ title: s.title.slice(0, 120), description: s.description.slice(0, 3000) }))

  const MIN_STEPS = 3
  if (steps.length < MIN_STEPS) return null

  // Require at least one step with a command or code block
  const hasActionableStep = steps.some(s => {
    const d = s.description
    return d.includes('```') || d.includes('kubectl') || d.includes('helm')
      || d.includes('docker') || d.includes('curl') || /\$ /.test(d)
  })
  if (!hasActionableStep) return null

  const validDifficulties = ['beginner', 'intermediate', 'advanced', 'expert']
  const validTypes = ['troubleshoot', 'deploy', 'upgrade', 'analyze', 'configure', 'feature']

  return {
    description: (parsed.description || '').slice(0, 500),
    steps,
    resolution: (parsed.resolution || '').slice(0, 2000),
    difficulty: validDifficulties.includes(parsed.difficulty) ? parsed.difficulty : 'intermediate',
    type: validTypes.includes(parsed.type) ? parsed.type : 'troubleshoot',
  }
}

// --- Utilities ---

export function truncate(text, max) {
  if (!text) return ''
  if (text.length <= max) return text
  return text.slice(0, max) + '\n... [truncated]'
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
