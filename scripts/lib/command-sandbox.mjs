/**
 * Command sandbox for mission-executor.mjs.
 *
 * Extracted from mission-executor.mjs (console-kb#3151) so the allowlist,
 * validation, parsing, and execution primitives can be unit-tested without
 * pulling in the LLM client or env/endpoint setup.
 *
 * Allowlist of permitted base commands for Kubernetes installation missions.
 * Every pipeline segment in LLM-provided commands must start with one of these.
 * NOTE: bash/sh removed to prevent `shell -c` injection bypass.
 * NOTE: `env` removed — `env <binary>` is a known allowlist escape (e.g.
 *   `env bash -c 'evil'` runs bash even though bash is not in this set).
 *   Environment variables should be set via spawnSync's `env:` option instead.
 * NOTE: interpreter-capable tools such as awk/sed/find/xargs are excluded
 *   because they can reintroduce arbitrary command execution via their own DSLs.
 */

import { spawnSync } from 'child_process'

const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || '120000', 10)

const ALLOWED_BASE_COMMANDS = new Set([
  'kubectl', 'helm', 'curl', 'cat', 'echo', 'grep',
  'jq', 'yq', 'kustomize', 'istioctl', 'date', 'ls',
  'sleep', 'timeout', 'base64', 'tr', 'cut', 'wc', 'head', 'tail',
  'printf', 'test', 'true', 'false', 'mkdir', 'rm', 'cp', 'mv',
  'sort', 'uniq', 'which',
])

/**
 * Validates that every pipeline segment in cmd starts with an allowed binary.
 * Returns { safe: true } or { safe: false, reason: string }.
 *
 * Prevents command-line injection when LLM-provided commands are executed
 * without shell interpolation (CWE-078, CWE-088).
 */
function validateCommand(cmd) {
  // Block subshell expansion patterns
  if (/\$\(/.test(cmd)) {
    return { safe: false, reason: 'Subshell expansion $() is not allowed' }
  }
  if (/`/.test(cmd)) {
    return { safe: false, reason: 'Backtick command substitution is not allowed' }
  }

  // Block bash/sh -c invocations
  if (/\b(?:bash|sh)\b.*\s+-c\b/.test(cmd)) {
    return { safe: false, reason: 'Shell -c execution is not allowed' }
  }

  // Block kubectl exec/run/cp with -- separator (argument injection risk)
  if (/\bkubectl\b.*\b(exec|run|cp)\b.*--\s+\S/.test(cmd)) {
    return { safe: false, reason: 'kubectl exec/run/cp with -- is not allowed (argument injection risk)' }
  }

  // Block find/xargs -exec flags
  if (/\b(?:find|xargs)\b.*-exec\b/.test(cmd)) {
    return { safe: false, reason: 'find/xargs -exec is not allowed (arbitrary command execution risk)' }
  }

  // Block curl file-upload / config-file flags — these turn `curl` into a
  // primitive for exfiltrating any locally-readable file to an attacker-
  // controlled URL, and the per-arg sanitiser (`sanitizeArg`) permits `@`,
  // `/`, `.`, `-`, `=`, `:` which are exactly the characters needed to write
  // `-F file=@/home/runner/.docker/config.json`. Because LLM-synthesised
  // missions are seeded from public sources (GitHub Discussions / Reddit /
  // StackOverflow — see scripts/sources/*), an attacker can steer the LLM
  // into emitting such a curl line even without touching this repo.
  //
  // Legitimate install flows use HTTPS-GET-only curl (`curl -fsSL <url>`,
  // `curl -L -o <file> <url>`), so blocking the upload/config surface does
  // not break the install path.
  if (/\bcurl\b/.test(cmd)) {
    const CURL_UNSAFE_FLAGS = [
      /(?:^|\s)-F(?:\b|=|\s)/,          // multipart form (reads @<path>)
      /(?:^|\s)--form(?:\b|=|\s)/,      // long form of -F
      /(?:^|\s)--form-string(?:\b|=|\s)/,
      /(?:^|\s)-T(?:\b|=|\s)/,          // upload-file
      /(?:^|\s)--upload-file(?:\b|=|\s)/,
      /(?:^|\s)-d(?:\b|=|\s)/,          // POST body (reads @<path>)
      /(?:^|\s)--data(?:\b|=|\s)/,
      /(?:^|\s)--data-binary(?:\b|=|\s)/,
      /(?:^|\s)--data-raw(?:\b|=|\s)/,
      /(?:^|\s)--data-urlencode(?:\b|=|\s)/,
      /(?:^|\s)-K(?:\b|=|\s)/,          // read curl-options from file
      /(?:^|\s)--config(?:\b|=|\s)/,    // long form of -K
      /(?:^|\s)--netrc(?:\b|-file|-optional)?(?:\b|=|\s)/,
    ]
    for (const rx of CURL_UNSAFE_FLAGS) {
      if (rx.test(cmd)) {
        return {
          safe: false,
          reason:
            'curl upload/config flags (-F/--form, -T/--upload-file, -d/--data*, -K/--config, --netrc*) are not allowed (data-exfiltration risk)',
        }
      }
    }
  }

  // Block pipes and redirections (require shell, cannot execute safely without shell)
  if (/[|><&]/.test(cmd)) {
    return { safe: false, reason: 'Pipes and redirections (|, >, <, &) are not allowed' }
  }

  // Split on shell delimiters to check each segment individually
  const segments = cmd.split(/\s*(?:;|&&|\|\||\(|\))\s*/).filter(Boolean)
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) continue
    // Strip leading shell-style VAR=value env assignments (e.g. KUBECONFIG=/path kubectl ...)
    const withoutEnv = trimmed.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/i, '')
    const firstWord = withoutEnv.split(/\s+/)[0]
    if (firstWord && !ALLOWED_BASE_COMMANDS.has(firstWord)) {
      return { safe: false, reason: `Disallowed command: '${firstWord}'` }
    }
  }
  return { safe: true }
}

/**
 * Parses a shell command string into an argv array using basic tokenization.
 * Handles quoted strings and escaped characters.
 * Returns an array of strings: [binary, arg1, arg2, ...]
 */
function parseCommand(cmd) {
  const args = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let i = 0

  while (i < cmd.length) {
    const c = cmd[i]

    if (c === '\\' && !inSingle) {
      i++
      if (i < cmd.length) current += cmd[i]
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (c === ' ' && !inSingle && !inDouble) {
      if (current) { args.push(current); current = '' }
    } else {
      current += c
    }
    i++
  }
  if (current) args.push(current)

  return args
}

function sanitizeArg(arg) {
  if (/[\0\r\n]/.test(arg)) {
    throw new Error('Arguments may not contain control characters')
  }
  if (/[$`|><&;]/.test(arg) || arg.includes('$(')) {
    throw new Error(`Unsafe argument rejected: ${arg}`)
  }
  // Defence-in-depth against curl-style file-read arguments: `@/<abs>` and
  // `@./<rel>` are how curl's -F/-d/-T flags reference a local file for
  // upload, and validateCommand already blocks those flags at the command
  // string layer. Rejecting @-prefixed absolute/relative paths here means a
  // future addition to ALLOWED_BASE_COMMANDS (or a bypass in the flag scan)
  // cannot silently reintroduce the exfiltration primitive.
  if (/^@[./]/.test(arg)) {
    throw new Error(`Unsafe argument rejected (file-read @path): ${arg}`)
  }
  return `${arg}`
}

function runBinary(binary, cmdArgs, { timeoutMs = STEP_TIMEOUT_MS, input } = {}) {
  if (!ALLOWED_BASE_COMMANDS.has(binary)) {
    return {
      success: false,
      output: `[BLOCKED] Disallowed command: ${binary}`,
      exitCode: 1,
      error: `Security: Disallowed command: ${binary}`,
    }
  }

  try {
    const safeArgs = cmdArgs.map(sanitizeArg)
    const result = spawnSync(binary, safeArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      shell: false,
      env: { ...process.env, TERM: 'dumb' },
      input,
    })

    if (result.error) {
      return {
        success: false,
        output: result.error.message,
        exitCode: 1,
        error: result.error.message,
      }
    }

    const output = (result.stdout || '') + (result.stderr || '')

    if (result.status === 0) {
      return { success: true, output: output.trim(), exitCode: 0 }
    }

    return {
      success: false,
      output: output.trim(),
      exitCode: result.status || 1,
      error: `Command exited with code ${result.status}`,
    }
  } catch (err) {
    return {
      success: false,
      output: err.message,
      exitCode: 1,
      error: err.message,
    }
  }
}

function execCommand(cmd, timeoutMs = STEP_TIMEOUT_MS) {
  const check = validateCommand(cmd)
  if (!check.safe) {
    console.warn(`  ⚠️  [sec] Blocked unsafe command: ${check.reason}`)
    console.warn(`  ⚠️  [sec] Command: ${cmd.slice(0, 200)}`)
    return {
      success: false,
      output: `[BLOCKED] ${check.reason}`,
      exitCode: 1,
      error: `Security: ${check.reason}`,
    }
  }

  try {
    // Parse command into [binary, ...args] and execute without shell
    const args = parseCommand(cmd)
    if (args.length === 0) {
      return {
        success: false,
        output: '[ERROR] Empty command',
        exitCode: 1,
        error: 'Empty command after parsing',
      }
    }

    const [binary, ...cmdArgs] = args

    // Resolve binary from ALLOWED_BASE_COMMANDS constant to break CodeQL taint flow
    // (CWE-078: prevents user-controlled string from flowing directly to spawnSync)
    let safeBinary = null
    for (const allowed of ALLOWED_BASE_COMMANDS) {
      if (allowed === binary) { safeBinary = allowed; break }
    }
    if (safeBinary === null) {
      return {
        success: false,
        output: '[BLOCKED] Binary not in allowlist',
        exitCode: 1,
        error: 'Security: Binary not in allowed commands',
      }
    }

    return runBinary(safeBinary, cmdArgs, { timeoutMs })
  } catch (err) {
    return {
      success: false,
      output: err.message,
      exitCode: 1,
      error: err.message,
    }
  }
}

export {
  STEP_TIMEOUT_MS,
  ALLOWED_BASE_COMMANDS,
  validateCommand,
  parseCommand,
  sanitizeArg,
  runBinary,
  execCommand,
}
