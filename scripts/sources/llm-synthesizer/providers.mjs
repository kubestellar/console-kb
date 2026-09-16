/**
 * Provider HTTP clients (Anthropic, OpenAI-compatible / Copilot / GitHub
 * Models) for the LLM synthesizer, plus the shared system prompt.
 * Extracted from scripts/sources/llm-synthesizer.mjs (console-kb#3196).
 */

import { ANTHROPIC_VERSION, LLM_TIMEOUT_MS, LLM_MAX_TOKENS } from './config.mjs'

// --- API callers ---

export async function callAnthropic(config, userPrompt) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': config.token,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: LLM_MAX_TOKENS,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })

  if (response.status === 429) {
    return { rateLimited: true, retryAfterSec: parseInt(response.headers.get('retry-after') || '10', 10) }
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return { error: `${response.status}: ${body.slice(0, 200)}` }
  }
  const data = await response.json()
  const textBlock = (data.content || []).find(b => b.type === 'text')
  return { content: textBlock?.text || null }
}

export async function callOpenAICompatible(config, userPrompt) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: LLM_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })

  if (response.status === 429) {
    return { rateLimited: true, retryAfterSec: parseInt(response.headers.get('retry-after') || '5', 10) }
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return { error: `${response.status}: ${body.slice(0, 200)}` }
  }
  const data = await response.json()
  return { content: data.choices?.[0]?.message?.content || null }
}

// --- System prompt ---

const SYSTEM_PROMPT = `You are an expert cloud-native infrastructure engineer creating troubleshooting missions for the KubeStellar Console knowledge base. A "mission" teaches a Kubernetes operator how to diagnose and fix a real-world problem.

Your output MUST be a JSON object with these fields:
{
  "description": "1-3 sentences describing the problem. Include the exact error message or symptom the operator sees.",
  "steps": [
    {
      "title": "Short imperative verb phrase (e.g., 'Check pod resource limits')",
      "description": "Detailed instructions with exact commands. Include kubectl commands, YAML patches, helm value overrides, or config file edits. Every step must be copy-pasteable."
    }
  ],
  "resolution": "2-4 sentences explaining WHY this fix works — the root cause, not just the remedy.",
  "difficulty": "beginner|intermediate|advanced|expert",
  "type": "troubleshoot|deploy|upgrade|analyze|configure|feature",
  "skip": false
}

QUALITY REQUIREMENTS — your output will be scored and rejected if it fails these:

1. STEPS must be SPECIFIC and ACTIONABLE:
   - GOOD: "Check pod resource limits:\\n\`\`\`bash\\nkubectl describe pod <name> -n <ns> | grep -A5 Limits\\n\`\`\`"
   - BAD: "Review the issue", "Understand the problem", "Verify the fix"
   - Each step title must start with an imperative verb: Check, Configure, Apply, Update, Patch, Create, Delete, Scale, Restart, Enable, Disable, Set, Add, Remove, Inspect, Debug, Validate
   - Each step description MUST contain at least one of: a command, a YAML block, a file path, or a config snippet
   - NEVER use these generic titles: "Understand the problem", "Apply the configuration", "Review the fix", "Verify the fix", "Check the documentation"

2. DESCRIPTION must include SYMPTOMS:
   - Include the exact error message, log line, or observable behavior
   - Be specific: "Pods stuck in CrashLoopBackOff with exit code 137" not "Pods are crashing"

3. RESOLUTION must explain ROOT CAUSE:
   - GOOD: "The OOMKilled exit code 137 indicates the container exceeded its memory limit. Increasing the limit to 512Mi allows the JVM heap to fit within the allocation."
   - BAD: "The fix resolves the issue by applying the correct configuration."

4. CODE SNIPPETS must be REAL:
   - Use actual resource names, actual kubectl flags, actual YAML fields
   - Include apiVersion and kind in YAML blocks
   - Show both the "before" state (how to diagnose) and "after" state (the fix)

5. SKIP non-actionable content:
   - Feature requests with no implementation → {"skip": true}
   - No clear solution or resolution → {"skip": true}
   - PR template boilerplate, CI bot output, changelog entries → {"skip": true}
   - WIP/draft with no conclusion → {"skip": true}

6. TYPE must match the content:
   - troubleshoot: fixing bugs, errors, crashes, misconfigurations
   - deploy: installing or setting up a component
   - upgrade: version migration, breaking changes
   - analyze: performance, resource usage, capacity
   - configure: tuning settings, enabling features
   - feature: implementing a new capability

7. STRIP all noise: Ignore Codecov reports, CI status, bot comments, PR templates, git diffs.`
