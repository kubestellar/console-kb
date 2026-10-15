/**
 * LLM-powered mission synthesizer supporting multiple backends:
 *   1. Env-configured LLM proxy (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL) — preferred when configured
 *   2. GitHub Copilot API (Claude Opus/Sonnet) — included with Copilot subscription
 *   3. Anthropic API (direct) — if ANTHROPIC_API_KEY is set
 *
 * This file is a thin re-export shim over ./llm-synthesizer/ (console-kb#3196)
 * kept so existing imports (base-source.mjs and tests) don't break.
 * See scripts/sources/llm-synthesizer/index.mjs for the implementation.
 */

export * from './llm-synthesizer/index.mjs';
