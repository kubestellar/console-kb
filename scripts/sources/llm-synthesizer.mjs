/**
 * LLM-powered mission synthesizer supporting multiple backends:
 *   1. GitHub Copilot API (Claude Opus/Sonnet) — preferred, included with Copilot subscription
 *   2. Anthropic API (direct) — if ANTHROPIC_API_KEY is set
 *   3. GitHub Models API (GPT-4o) — free fallback for GitHub Actions
 *
 * This file is a thin re-export shim over ./llm-synthesizer/ (console-kb#3196)
 * kept so existing imports (base-source.mjs and tests) don't break.
 * See scripts/sources/llm-synthesizer/index.mjs for the implementation.
 */

export * from './llm-synthesizer/index.mjs';
