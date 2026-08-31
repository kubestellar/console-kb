import { describe, it, expect } from 'vitest'
import { execCommand } from '../mission-executor.mjs'

/**
 * Closes the three pure error branches of `execCommand` in
 * scripts/mission-executor.mjs. Existing coverage of this file is
 * ~26% because only the exported primitives (validateCommand,
 * parseCommand, sanitizeArg, runBinary, ALLOWED_BASE_COMMANDS) are
 * tested — the composition layer that wires them together is
 * unreached.
 *
 * These three branches are the security-critical portion of that
 * composition and can be exercised without spawning any process:
 *
 *   1. validateCommand returned {safe:false}  -> [BLOCKED] path
 *      (defence-in-depth wrapper around the primitives that already
 *       have their own tests).
 *   2. parseCommand returned []              -> [ERROR] Empty command
 *      (whitespace-only input passes validateCommand's segment loop
 *       because the filter drops empty segments, but parseCommand
 *       returns no args — must not reach spawnSync with `undefined`).
 *   3. Binary not in ALLOWED_BASE_COMMANDS   -> [BLOCKED] Binary not
 *      in allowlist. This is the CodeQL-required allowlist re-lookup
 *      (CWE-078 defence-in-depth): validateCommand strips shell-style
 *      env-var assignments before its allowlist check
 *      (`KUBECONFIG=/x kubectl get pods` -> validated as `kubectl …`),
 *      but parseCommand keeps `KUBECONFIG=/x` as the first token. If a
 *      future refactor drops the re-lookup, `KUBECONFIG=/x` would flow
 *      straight into `spawnSync(binary, …)` — this test would catch
 *      that regression.
 *
 * Filed alongside kubestellar/console-kb#3103. The full 26% -> 70%+
 * lift for this file also needs vi.mock('node:child_process') tests
 * for executeStep/executeMission/llmChat; see the issue for the plan.
 * This PR is the smallest, spawn-free slice that pins the security
 * boundary now.
 */

describe('execCommand — [BLOCKED] validateCommand not safe', () => {
  it('rejects a command that contains a pipe (validateCommand fails)', () => {
    const result = execCommand('kubectl get pods | grep Running')
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.output.startsWith('[BLOCKED]')).toBe(true)
    expect(result.error).toMatch(/^Security:/)
    expect(result.error).toMatch(/Pipes and redirections/i)
  })

  it('rejects a subshell $() expansion', () => {
    const result = execCommand('echo $(whoami)')
    expect(result.success).toBe(false)
    expect(result.output.startsWith('[BLOCKED]')).toBe(true)
    expect(result.error).toMatch(/Subshell expansion/i)
  })

  it('rejects backtick command substitution', () => {
    const result = execCommand('echo `whoami`')
    expect(result.success).toBe(false)
    expect(result.output.startsWith('[BLOCKED]')).toBe(true)
    expect(result.error).toMatch(/Backtick/i)
  })

  it('rejects bash -c', () => {
    const result = execCommand('bash -c "id"')
    expect(result.success).toBe(false)
    expect(result.output.startsWith('[BLOCKED]')).toBe(true)
    expect(result.error).toMatch(/Shell -c/i)
  })
})

describe('execCommand — [ERROR] empty after parseCommand', () => {
  it('returns "Empty command after parsing" for whitespace-only input', () => {
    // validateCommand splits on shell delimiters and filters empty
    // segments, so pure whitespace passes as "safe". parseCommand
    // then returns []. Without the args.length===0 guard this would
    // spawn `undefined` — a nil-deref inside child_process.
    const result = execCommand('   ')
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.output).toBe('[ERROR] Empty command')
    expect(result.error).toBe('Empty command after parsing')
  })

  it('returns "Empty command after parsing" for empty string', () => {
    const result = execCommand('')
    expect(result.success).toBe(false)
    expect(result.output).toBe('[ERROR] Empty command')
    expect(result.error).toBe('Empty command after parsing')
  })
})

describe('execCommand — [BLOCKED] binary not in ALLOWED_BASE_COMMANDS after parse', () => {
  it('blocks an env-prefixed command that passes validateCommand but leaves an env token as argv[0]', () => {
    // validateCommand strips leading shell-style env assignments
    // before the allowlist check, so `KUBECONFIG=/x kubectl get pods`
    // is validated as if it started with `kubectl` (allowed).
    // parseCommand does NOT strip the assignment, so the first token
    // is `KUBECONFIG=/x` — which must be blocked by execCommand's
    // defence-in-depth allowlist re-lookup (the CodeQL-mandated
    // `for (allowed of ALLOWED_BASE_COMMANDS)` loop).
    const result = execCommand('KUBECONFIG=/tmp/x kubectl get pods')
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.output).toBe('[BLOCKED] Binary not in allowlist')
    expect(result.error).toBe('Security: Binary not in allowed commands')
  })

  it('blocks a multi-env-var prefixed command the same way', () => {
    const result = execCommand('FOO=1 BAR=2 kubectl version')
    expect(result.success).toBe(false)
    expect(result.output).toBe('[BLOCKED] Binary not in allowlist')
    expect(result.error).toBe('Security: Binary not in allowed commands')
  })
})
