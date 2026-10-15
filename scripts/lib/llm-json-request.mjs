/**
 * Shared defensive "LLM chat-completion returning JSON" request helper.
 *
 * Extracted from near-identical logic duplicated in
 * enrich-install-missions.mjs::callLLM and
 * generate-cncf-install-missions.mjs::synthesizeInstallMission
 * (kubestellar/console-kb architecture finding). Both call sites built the
 * same OpenAI-style chat/completions request, retried on 429
 * (honoring Retry-After) and on network/timeout errors, and — before
 * parsing any HTTP-derived bytes that get merged into file-backed mission
 * data — validated the response Content-Type and enforced a size ceiling
 * (CWE-434 guard, originally added to fix #2896/#2909). Only the prompt,
 * token budget, and response-size ceiling differed between callers, so
 * those are left as parameters here.
 *
 * Returns the parsed JSON body of `choices[0].message.content`, or `null`
 * if the call failed for any handled per-request reason (rate-limited past
 * the retry budget, HTTP error, oversize body, missing/invalid content).
 * A 2xx response whose Content-Type is not `application/json` throws
 * `LlmResponseError` (from ./llm-proxy-config.mjs) instead: that signature
 * means the endpoint itself is wrong/retired (console-kb#3702, where every
 * call got a 200 `text/plain` "OK"), so callers must fail the run loudly
 * rather than skip item after item. Callers may pass a full multi-turn `messages` array instead of
 * `systemPrompt`/`userPrompt`. Does not perform caller-specific post-parse validation
 * (e.g. required fields) — that remains the caller's responsibility.
 */
import { assertJsonResponse, llmRequestHeaders, LlmResponseError } from './llm-proxy-config.mjs'

export async function requestLlmChatJson({
  endpoint,
  model,
  token,
  systemPrompt,
  userPrompt,
  messages,
  temperature = 0.3,
  maxTokens,
  timeoutMs,
  maxResponseBytes,
  log,
  sleep,
}) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: llmRequestHeaders(token),
        body: JSON.stringify({
          model,
          messages: messages ?? [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (response.status === 429) {
        const wait = parseInt(response.headers.get('retry-after') || '10', 10)
        log.warn(`  [LLM] Rate limited, waiting ${wait}s`)
        await sleep(wait * 1000)
        continue
      }
      if (!response.ok) {
        log.warn(`  [LLM] API error ${response.status}`)
        return null
      }

      try {
        await assertJsonResponse(response)
      } catch (err) {
        log.error(`  [LLM] ${err.message}`)
        throw err
      }
      const rawText = await response.text()
      if (rawText.length > maxResponseBytes) {
        log.warn(`  [LLM] Response too large (${rawText.length} bytes), rejecting`)
        return null
      }
      const data = JSON.parse(rawText)
      const content = data.choices?.[0]?.message?.content
      if (!content) return null

      return JSON.parse(content)
    } catch (err) {
      if (err instanceof LlmResponseError) throw err
      log.warn(`  [LLM] ${err.name === 'AbortError' ? 'Timeout' : err.message} (attempt ${attempt + 1})`)
      if (attempt < 2) await sleep(3000 * (attempt + 1))
    }
  }
  return null
}
