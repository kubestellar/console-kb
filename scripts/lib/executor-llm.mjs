/**
 * LLM client for mission-executor.mjs.
 *
 * Extracted from mission-executor.mjs (console-kb#3151): the llmChat
 * conversation helper used to drive step extraction, failure diagnosis,
 * and final verification.
 *
 * Endpoint / key / model come from the env-configured LLM proxy
 * (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL), read per-call and validated by
 * ./llm-proxy-config.mjs (console-kb#3702).
 */

import { getLlmProxyConfig } from './llm-proxy-config.mjs'
import { requestLlmChatJson } from './llm-json-request.mjs'

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
  const { endpoint, apiKey, model } = getLlmProxyConfig()

  const result = await requestLlmChatJson({
    endpoint,
    model,
    token: apiKey,
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
  SYSTEM_PROMPT,
  llmChat,
}
