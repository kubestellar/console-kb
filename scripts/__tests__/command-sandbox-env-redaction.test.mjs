import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildSandboxEnv } from '../lib/command-sandbox.mjs'

/**
 * Regression coverage for console-kb#3824 (CWE-200/CWE-522): runBinary()
 * used to spawn every sandboxed command with `{ ...process.env, TERM:
 * 'dumb' }`, exposing CI secrets (GITHUB_TOKEN, LLM_API_KEY, LLM_BASE_URL)
 * to allowlisted-but-path-unrestricted commands such as `cat`/`cp`/`mv`.
 * A mission step reading e.g. `/proc/self/environ` could exfiltrate those
 * secrets to the external LLM proxy via the diagnose_failure error_output.
 *
 * `buildSandboxEnv()` now strips any credential-shaped env var name before
 * the child process environment is built. These tests pin that behavior
 * directly, independent of the real process.env contents.
 */

const SENTINEL_SECRETS = {
  GITHUB_TOKEN: 'ghp_sentinel',
  LLM_API_KEY: 'sk-sentinel',
  LLM_BASE_URL_TOKEN: 'sentinel',
  SOME_SECRET: 'sentinel',
  DB_PASSWORD: 'sentinel',
  AWS_CREDENTIAL_FILE: 'sentinel',
  MY_API_PAT: 'sentinel',
}

const SENTINEL_SAFE = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/runner',
  KUBECONFIG: '/home/runner/.kube/config',
  LANG: 'C.UTF-8',
}

describe('buildSandboxEnv', () => {
  let savedEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    for (const [k, v] of Object.entries({ ...SENTINEL_SECRETS, ...SENTINEL_SAFE })) {
      process.env[k] = v
    }
  })

  afterEach(() => {
    for (const k of Object.keys({ ...SENTINEL_SECRETS, ...SENTINEL_SAFE })) {
      delete process.env[k]
    }
    Object.assign(process.env, savedEnv)
  })

  it('strips every credential-shaped env var name', () => {
    const env = buildSandboxEnv()
    for (const name of Object.keys(SENTINEL_SECRETS)) {
      expect(env).not.toHaveProperty(name)
    }
  })

  it('preserves functional, non-credential-shaped env vars', () => {
    const env = buildSandboxEnv()
    for (const [name, value] of Object.entries(SENTINEL_SAFE)) {
      expect(env[name]).toBe(value)
    }
  })

  it('forces TERM=dumb', () => {
    process.env.TERM = 'xterm-256color'
    const env = buildSandboxEnv()
    expect(env.TERM).toBe('dumb')
  })
})
