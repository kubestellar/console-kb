// eslint-disable-next-line no-restricted-imports
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Source-parsing drift-guard for mission-executor.mjs security gates.
//
// mission-executor.mjs executes model-suggested shell commands on a
// Kind cluster. Its safety rests on a fixed set of literal regex
// reject arms and allowlists that are trivially exploitable if
// silently loosened:
//
//   * validateCommand() rejects subshell $(), backtick, `bash|sh -c`,
//     `kubectl exec/run/cp -- <cmd>`, `find|xargs -exec`, and pipe/
//     redirection metacharacters. Each arm blocks a distinct class
//     of shell-based RCE, so a drop of any one is a new exploit.
//   * validateCommand() also splits on shell delimiters `;`, `&&`,
//     `||`, `(`, `)` and enforces the per-segment ALLOWED_BASE_COMMANDS
//     allowlist; a drift removing any delimiter would let a
//     disallowed command hide behind `kubectl get pods; evil-cmd`.
//   * sanitizeArg() rejects control chars (\0 \r \n) and shell
//     metacharacters ($ ` | > < & ;) plus `$(`; used on every argv
//     element passed to spawn.
//   * execCommand() resolves the parsed binary against
//     ALLOWED_BASE_COMMANDS by identity (breaks CodeQL taint flow
//     into spawnSync); the `[BLOCKED] Binary not in allowlist`
//     message is the observable proof this second-stage guard is
//     still wired.
//   * assertTrustedEndpoint() enforces the LLM_ENDPOINT prefix
//     allowlist at module load; a drift here would let LLM traffic
//     be redirected to an attacker-controlled host.
//
// None of these are meaningfully assertable via runtime alone —
// e.g. we cannot enumerate every future novel injection pattern.
// So we anchor the exact source literals here: if a maintainer
// weakens one, this test fails and forces an explicit review.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', 'mission-executor.mjs'), 'utf8')

describe('mission-executor.mjs security-gate literals (drift guard)', () => {
  describe('validateCommand reject arms', () => {
    it('rejects subshell expansion $(', () => {
      expect(SRC).toContain("if (/\\$\\(/.test(cmd)) {")
      expect(SRC).toContain("reason: 'Subshell expansion $() is not allowed'")
    })

    it('rejects backtick command substitution', () => {
      expect(SRC).toContain("if (/`/.test(cmd)) {")
      expect(SRC).toContain("reason: 'Backtick command substitution is not allowed'")
    })

    it('rejects bash|sh -c invocations', () => {
      expect(SRC).toContain("if (/\\b(?:bash|sh)\\b.*\\s+-c\\b/.test(cmd)) {")
      expect(SRC).toContain("reason: 'Shell -c execution is not allowed'")
    })

    it('rejects kubectl exec/run/cp with -- <cmd>', () => {
      expect(SRC).toContain("if (/\\bkubectl\\b.*\\b(exec|run|cp)\\b.*--\\s+\\S/.test(cmd)) {")
      expect(SRC).toContain("reason: 'kubectl exec/run/cp with -- is not allowed (argument injection risk)'")
    })

    it('rejects find|xargs -exec', () => {
      expect(SRC).toContain("if (/\\b(?:find|xargs)\\b.*-exec\\b/.test(cmd)) {")
      expect(SRC).toContain("reason: 'find/xargs -exec is not allowed (arbitrary command execution risk)'")
    })

    it('rejects pipes and redirections', () => {
      expect(SRC).toContain("if (/[|><&]/.test(cmd)) {")
      expect(SRC).toContain("reason: 'Pipes and redirections (|, >, <, &) are not allowed'")
    })

    it('splits on all five shell delimiters ; && || ( )', () => {
      expect(SRC).toContain("const segments = cmd.split(/\\s*(?:;|&&|\\|\\||\\(|\\))\\s*/).filter(Boolean)")
    })

    it('strips leading VAR=value env assignments before allowlist check', () => {
      expect(SRC).toContain("const withoutEnv = trimmed.replace(/^(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*/i, '')")
    })

    it('enforces ALLOWED_BASE_COMMANDS on per-segment first word', () => {
      expect(SRC).toContain("if (firstWord && !ALLOWED_BASE_COMMANDS.has(firstWord)) {")
      expect(SRC).toContain("reason: `Disallowed command: '${firstWord}'`")
    })
  })

  describe('sanitizeArg reject arms', () => {
    it('rejects NUL/CR/LF control characters', () => {
      expect(SRC).toContain("if (/[\\0\\r\\n]/.test(arg)) {")
      expect(SRC).toContain("throw new Error('Arguments may not contain control characters')")
    })

    it('rejects shell metacharacters $ ` | > < & ; and $(', () => {
      expect(SRC).toContain("if (/[$`|><&;]/.test(arg) || arg.includes('$(')) {")
      expect(SRC).toContain("throw new Error(`Unsafe argument rejected: ${arg}`)")
    })
  })

  describe('execCommand allowlist re-check', () => {
    it('resolves binary via identity comparison against ALLOWED_BASE_COMMANDS', () => {
      expect(SRC).toContain('for (const allowed of ALLOWED_BASE_COMMANDS) {')
      expect(SRC).toContain('if (allowed === binary) { safeBinary = allowed; break }')
    })

    it('emits [BLOCKED] Binary not in allowlist when re-check fails', () => {
      expect(SRC).toContain("output: '[BLOCKED] Binary not in allowlist'")
      expect(SRC).toContain("error: 'Security: Binary not in allowed commands'")
    })

    it('cites CWE-078 taint-break rationale so the guard is not "simplified" away', () => {
      expect(SRC).toContain('CWE-078')
    })
  })

  describe('assertTrustedEndpoint LLM prefix allowlist', () => {
    it('rejects endpoints not matching an allowed prefix', () => {
      expect(SRC).toContain("if (!allowedPrefixes.some(prefix => endpoint.startsWith(prefix))) {")
      expect(SRC).toContain('throw new Error(`Untrusted LLM_ENDPOINT: ${endpoint}. Must start with one of: ${allowedPrefixes.join(\', \')}`)')
    })

    it('runs the check at module load against LLM_ENDPOINT', () => {
      expect(SRC).toContain('const TRUSTED_LLM_ENDPOINT = assertTrustedEndpoint(LLM_ENDPOINT)')
    })
  })
})
