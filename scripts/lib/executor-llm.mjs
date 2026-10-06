/**
 * LLM client for mission-executor.mjs.
 *
 * Extracted from mission-executor.mjs (console-kb#3151): endpoint trust
 * check, token resolution, and the llmChat conversation helper used to
 * drive step extraction, failure diagnosis, and final verification.
 *
 * The SSRF guard (`ALLOWED_ENDPOINT_PREFIXES` / `assertTrustedEndpoint`) is
 * imported from the canonical `lib/llm-endpoint-guard.mjs` and re-exported
 * unchanged (kubestellar/console-kb#3614), so mission-executor.mjs still
 * sees the same symbol names it used before the consolidation.
 */

import { ALLOWED_ENDPOINT_PREFIXES, assertTrustedEndpoint } from './llm-endpoint-guard.mjs'
import { requestLlmChatJson } from './llm-json-request.mjs'

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://models.github.ai/inference/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-4o-mini'

const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)

function getToken() {
  return process.env.LLM_TOKEN || process.env.GITHUB_TOKEN
}

const SYSTEM_PROMPT = `You are a Kubernetes DevOps engineer executing installation missions on a Kind cluster.
You receive mission steps and execute them one at a time. For each step:

1. Extract the shell commands from the step description (they are usually in code blocks).
2. Adapt commands for a Kind cluster if needed (e.g. no LoadBalancer, use NodePort or port-forward).
3. If a command fails, diagnose the error and suggest a fix.
4. After verification steps, confirm whether the installation succeeded.

RULES:
- Only output valid JSON responses.
- Commands must be safe for a test cluster (no production destructive operations).
- If a Helm repo add fails, try without the repo and use OCI or direct URL.
- Wait for pods with: kubectl wait --for=condition=ready pod -l app=X --timeout=120s
- If a namespace doesn't exist, create it.
- Never use 'sudo' or install system packages.
- If you need to adapt a command, explain what you changed and why.

Respond in JSON:
{
  "commands": ["cmd1", "cmd2", ...],
  "reasoning": "why these commands",
  "adaptations": "what was changed for Kind cluster, if anything"
}

When diagnosing failures, respond in JSON:
{
  "diagnosis": "what went wrong",
  "fix_commands": ["fixed_cmd1", ...],
  "skip": false
}
Set "skip": true only if the step is genuinely optional (e.g. external DNS, cloud-specific LB).`

const LLM_TIMEOUT_MS = 30000
const LLM_MAX_RESPONSE_BYTES = 1024 * 1024

async function llmChat(messages) {
  const token = getToken()
  if (!token) throw new Error('No GITHUB_TOKEN set for LLM API')

  const result = await requestLlmChatJson({
    endpoint: TRUSTED_LLM_ENDPOINT,
    model: LLM_MODEL,
    token,
    messages,
    temperature: 0.2,
    maxTokens: 1500,
    timeoutMs: LLM_TIMEOUT_MS,
    maxResponseBytes: LLM_MAX_RESPONSE_BYTES,
    log: console,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  if (result === null) throw new Error('LLM request failed or returned an empty/invalid response')

  return result
}

export {
  LLM_ENDPOINT,
  LLM_MODEL,
  ALLOWED_ENDPOINT_PREFIXES,
  assertTrustedEndpoint,
  TRUSTED_LLM_ENDPOINT,
  getToken,
  SYSTEM_PROMPT,
  llmChat,
}
