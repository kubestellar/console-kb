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
import { isIP } from 'node:net'
import { createLogger } from './logger.mjs'
import { isPrivateOrReservedIp } from './url-fetch-guard.mjs'

const log = createLogger('command-sandbox')

const STEP_TIMEOUT_MS = parseInt(process.env.STEP_TIMEOUT_MS || '120000', 10)

/**
 * Parses `hostname` as an alternate-notation IPv4 literal — decimal
 * (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), or shorthand
 * dotted forms (`127.1`) — the way glibc's `inet_aton` (and therefore
 * curl's own resolver) parses such strings. Returns the equivalent
 * dotted-quad string, or `null` if `hostname` is not such a literal (e.g.
 * a real DNS name).
 *
 * `net.isIP()` only recognises the canonical 4-part decimal-dotted form,
 * so `169.254.169.254` is caught by the literal-IP check below but its
 * decimal (`2852039166`), hex (`0xa9fea9fe`) and octal/shorthand
 * equivalents are not — yet curl resolves all of them to the same cloud
 * metadata address (CWE-918 bypass of the SSRF guard).
 */
function parseAltNotationIPv4(hostname) {
  if (!/^(?:0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)(?:\.(?:0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)){0,3}$/i.test(hostname)) {
    return null
  }
  const parts = hostname.split('.')
  const nums = parts.map(p => {
    if (/^0x/i.test(p)) return parseInt(p, 16)
    if (/^0[0-7]+$/.test(p)) return parseInt(p, 8)
    return parseInt(p, 10)
  })
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null

  let value
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null
    value = nums[0]
  } else if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return null
    value = (nums[0] << 24) | nums[1]
  } else if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null
    value = (nums[0] << 24) | (nums[1] << 16) | nums[2]
  } else {
    if (nums.some(n => n > 0xff)) return null
    value = (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]
  }
  value = value >>> 0
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.')
}

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

    // SSRF (CWE-918): LLM-synthesised missions are seeded from public,
    // unauthenticated sources (scripts/sources/*), so an attacker can steer
    // the LLM into emitting a `curl` call that targets a loopback/private/
    // link-local address or the cloud metadata endpoint
    // (http://169.254.169.254/...) instead of a public install artifact.
    // Unlike the upload/config flags above, a bare GET to such a host can
    // still leak metadata credentials via the command's stdout, which is
    // echoed to CI logs and the mission report. This catches literal IP
    // targets in canonical dotted-decimal form and in curl/glibc's
    // alternate decimal/hex/octal/shorthand notations (see
    // `parseAltNotationIPv4` above); no DNS lookup is done here, so it is
    // not a full defense against a hostname that resolves to a private
    // address at connect time. It reuses the same reserved-range table as
    // `lib/url-fetch-guard.mjs`'s `safeFetch`.
    const urlMatches = cmd.match(/https?:\/\/[^\s'"]+/gi) || []
    for (const urlMatch of urlMatches) {
      let parsed
      try {
        parsed = new URL(urlMatch)
      } catch {
        continue
      }
      const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      const altIp = isIP(hostname) ? null : parseAltNotationIPv4(hostname)
      if (
        hostname === 'localhost' ||
        (isIP(hostname) && isPrivateOrReservedIp(hostname)) ||
        (altIp && isPrivateOrReservedIp(altIp))
      ) {
        return {
          safe: false,
          reason: `curl target rejected (loopback/private/link-local/metadata address): ${urlMatch}`,
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
    log.warn('blocked unsafe command', { reason: check.reason, command_preview: cmd.slice(0, 200) })
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
  parseAltNotationIPv4,
}
