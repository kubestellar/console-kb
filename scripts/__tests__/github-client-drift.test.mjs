// Drift guard for kubestellar/console-kb#3551.
//
// Three modules used to carry their own GitHub REST client and their own
// `let rateLimitRemaining = 5000` — so one process could burn 3x GitHub's
// real budget and only one copy had a timeout / 5xx backoff / 422 handling.
// The client now lives solely in scripts/lib/cncf-github-client.mjs.
//
// This suite fails CI if a caller re-grows a private copy:
//   1. Reference identity — the platform generator's exported client helpers
//      must be the very same function objects as the lib's.
//   2. Source scan — no non-test module outside the lib may declare its own
//      rate-limit counters, parse x-ratelimit-* headers, or emit the
//      deprecated `application/vnd.github.v3+json` media type.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as lib from '../lib/cncf-github-client.mjs'
import * as platformContext from '../platform/github-context.mjs'
import * as platformGenerator from '../generate-platform-missions.mjs'
import * as cncfGenerator from '../generate-cncf-missions.mjs'

const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url))
const LIB_CLIENT = 'lib/cncf-github-client.mjs'

// Files that are allowed to match the private-client patterns because they
// legitimately own them, or because their consolidation is tracked in a
// separate PR. Remove an entry as soon as its file is migrated.
const ALLOWLIST = new Set([
  LIB_CLIENT,
  // kubestellar/console-kb#3536 / PR #3557: inline githubApi()/counters are
  // being deleted there. Delete this entry once that PR merges.
  'generate-cncf-install-missions.mjs',
])

const PRIVATE_CLIENT_PATTERNS = [
  { name: 'private rate-limit counter', re: /\b(let|var|const)\s+rateLimit(Remaining|Reset)\b/ },
  { name: 'raw x-ratelimit header parsing', re: /x-ratelimit-(remaining|reset)/i },
  { name: 'deprecated GitHub v3 media type', re: /application\/vnd\.github\.v3\+json/ },
]

function listMjsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listMjsFiles(full))
    else if (entry.endsWith('.mjs')) out.push(full)
  }
  return out
}

describe('single GitHub REST client (console-kb#3551)', () => {
  it('platform/github-context.mjs re-exports the lib client by reference', () => {
    expect(platformContext.githubApi).toBe(lib.githubApi)
    expect(platformContext.waitForRateLimit).toBe(lib.waitForRateLimit)
    expect(platformContext.sleep).toBe(lib.sleep)
    expect(platformContext).not.toHaveProperty('githubFetch')
  })

  it('generate-platform-missions.mjs re-exports the same sleep as the lib', () => {
    expect(platformGenerator.sleep).toBe(lib.sleep)
  })

  it('generate-cncf-missions.mjs does not export a competing client', () => {
    expect(cncfGenerator).not.toHaveProperty('githubApi')
    expect(cncfGenerator).not.toHaveProperty('githubFetch')
    expect(cncfGenerator).not.toHaveProperty('waitForRateLimit')
  })

  it('no module outside the lib carries private rate-limit state or the deprecated media type', () => {
    const offenders = []
    for (const file of listMjsFiles(SCRIPTS_DIR)) {
      const rel = relative(SCRIPTS_DIR, file).split(sep).join('/')
      if (ALLOWLIST.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      for (const { name, re } of PRIVATE_CLIENT_PATTERNS) {
        if (re.test(src)) offenders.push(`${rel}: ${name}`)
      }
    }
    expect(offenders, 'import githubApi/githubHeaders from lib/cncf-github-client.mjs instead').toEqual([])
  })

  it('the lib itself still owns the shared header policy', () => {
    const src = readFileSync(join(SCRIPTS_DIR, LIB_CLIENT), 'utf8')
    expect(src).toMatch(/let rateLimitRemaining/)
    expect(lib.GITHUB_ACCEPT_HEADER).toBe('application/vnd.github+json')
    expect(lib.GITHUB_API_VERSION).toBe('2022-11-28')
    expect(src).not.toMatch(/vnd\.github\.v3\+json/)
  })
})
