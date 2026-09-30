import { describe, it, expect, afterEach } from 'vitest'
import {
  defaultCheckUrl,
  defaultCheckImage,
} from '../mission-content-validation.mjs'

// The `runCli`/`runContentValidation` helpers accept `checkUrl` and
// `checkImage` injectables so the CLI test can avoid real network I/O.
// That leaves the *defaults* — thin `execFileSync` wrappers around
// `curl` and `crane digest` — uncovered by the existing suite. These
// tests exercise their `catch → '000' / false` fallback branch
// deterministically by pointing PATH at an empty directory so the
// binary lookup fails synchronously (no sockets opened, no registry
// contacted).

const ORIGINAL_PATH = process.env.PATH

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH
})

describe("mission-content-validation defaultCheckUrl", () => {
  it("returns '000' when curl cannot be resolved on PATH (fallback branch)", () => {
    process.env.PATH = '/var/empty'
    expect(defaultCheckUrl('https://example.invalid/nope')).toBe('000')
  })
})

describe("mission-content-validation defaultCheckImage", () => {
  it('returns false when crane cannot be resolved on PATH (fallback branch)', () => {
    process.env.PATH = '/var/empty'
    expect(defaultCheckImage('example.invalid/nope:v0')).toBe(false)
  })
})
