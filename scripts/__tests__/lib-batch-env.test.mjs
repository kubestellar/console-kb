/**
 * Unit tests for scripts/lib/batch-env.mjs — the shared read-once
 * constants extracted in kubestellar/console-kb#3500.
 *
 * Because the module captures process.env at load time, each test uses
 * vi.resetModules() + dynamic import to re-read env under the current
 * suite's mutations. This matches the pattern the existing generator
 * tests (mission-executor-composition.test.mjs, ...) already rely on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEYS = ['DRY_RUN', 'BATCH_INDEX', 'BATCH_SIZE']
const ORIGINAL_ENV = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

function restoreEnv() {
  for (const k of KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
}

async function loadModule() {
  vi.resetModules()
  return await import('../lib/batch-env.mjs')
}

describe('scripts/lib/batch-env.mjs — DRY_RUN', () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k]
  })
  afterEach(restoreEnv)

  it('is true only when DRY_RUN is exactly "true"', async () => {
    process.env.DRY_RUN = 'true'
    const mod = await loadModule()
    expect(mod.DRY_RUN).toBe(true)
  })

  it('is false when DRY_RUN is unset', async () => {
    const mod = await loadModule()
    expect(mod.DRY_RUN).toBe(false)
  })

  it('is false for any non-"true" string, including "1", "yes", "TRUE"', async () => {
    for (const truthyish of ['1', 'yes', 'TRUE', 'True', '']) {
      process.env.DRY_RUN = truthyish
      const mod = await loadModule()
      expect(mod.DRY_RUN, `DRY_RUN=${JSON.stringify(truthyish)}`).toBe(false)
    }
  })
})

describe('scripts/lib/batch-env.mjs — BATCH_INDEX', () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k]
  })
  afterEach(restoreEnv)

  it('is null when BATCH_INDEX is unset', async () => {
    const mod = await loadModule()
    expect(mod.BATCH_INDEX).toBeNull()
  })

  it('parses a numeric BATCH_INDEX to an integer', async () => {
    process.env.BATCH_INDEX = '3'
    const mod = await loadModule()
    expect(mod.BATCH_INDEX).toBe(3)
  })

  it('accepts "0" (a valid batch index)', async () => {
    process.env.BATCH_INDEX = '0'
    const mod = await loadModule()
    expect(mod.BATCH_INDEX).toBe(0)
  })
})

describe('scripts/lib/batch-env.mjs — BATCH_SIZE', () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k]
  })
  afterEach(restoreEnv)

  it('defaults to 20 when unset', async () => {
    const mod = await loadModule()
    expect(mod.BATCH_SIZE).toBe(20)
  })

  it('defaults to 20 when set to empty string', async () => {
    process.env.BATCH_SIZE = ''
    const mod = await loadModule()
    expect(mod.BATCH_SIZE).toBe(20)
  })

  it('parses a numeric BATCH_SIZE to an integer', async () => {
    process.env.BATCH_SIZE = '50'
    const mod = await loadModule()
    expect(mod.BATCH_SIZE).toBe(50)
  })
})
