/**
 * Keeps the solutions/ tree clean under the PR-mode scan so the blocking
 * mission-safety-scan / scan-missions gates stay green (console-kb#3752).
 */
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { runScan, MALICIOUS_ALLOWLIST } from '../scan-pr.mjs'
import { discoverMissionFiles } from '../lib/mission-discovery.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

describe('scan-pr over solutions/', () => {
  it('reports zero failures and zero findings (PR-mode scan)', () => {
    const files = discoverMissionFiles(join(REPO_ROOT, 'solutions'))
    expect(files.length).toBeGreaterThan(0)
    const result = runScan(files, { isFullScan: false })
    expect(result.failedCount).toBe(0)
    expect(result.hasFailures).toBe(false)
    expect(result.report).not.toContain('🚨')
  })

  it('allow-list entries are file-scoped and carry a pattern', () => {
    for (const e of MALICIOUS_ALLOWLIST) {
      expect(e.file).toMatch(/^solutions\/.+\.json$/)
      expect(e.type).toBeTruthy()
      expect(e.value).toBeInstanceOf(RegExp)
    }
  })
})
