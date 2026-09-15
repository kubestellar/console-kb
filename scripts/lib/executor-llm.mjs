/**
 * LLM client for mission-executor.mjs.
 *
 * Extracted from mission-executor.mjs (console-kb#3151): endpoint trust
 * check, token resolution, and the llmChat conversation helper used to
 * drive step extraction, failure diagnosis, and final verification.
 *
 * NOTE: `ALLOWED_ENDPOINT_PREFIXES` / `assertTrustedEndpoint()` are
 * intentionally duplicated (not imported from a shared module) across
 * mission-executor.mjs (here), enrich-install-missions.mjs,
 * generate-cncf-install-missions.mjs, and generate-platform-missions.mjs.
 * See scripts/__tests__/ssrf-allowlist-drift.test.mjs, which enforces that
 * all copies stay byte-identical.
 */

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://models.inference.ai.azure.com/chat/completions'
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini'

const ALLOWED_ENDPOINT_PREFIXES = [
  'https://models.inference.ai.azure.com/',
  'https://api.openai.com/',
  'https://api.githubcopilot.com/',
]

function assertTrustedEndpoint(endpoint, allowedPrefixes = ALLOWED_ENDPOINT_PREFIXES) {
  if (!allowedPrefixes.some(prefix => endpoint.startsWith(prefix))) {
    throw new Error(`Untrusted LLM_ENDPOINT: ${endpoint}. Must start with one of: ${allowedPrefixes.join(', ')}`)
  }
  return endpoint
}

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

async function llmChat(messages) {
  const token = getToken()
  if (!token) throw new Error('No GITHUB_TOKEN set for LLM API')

  const resp = await fetch(TRUSTED_LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`LLM API error ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Empty LLM response')

  return JSON.parse(content)
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
