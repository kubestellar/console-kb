/**
 * mission-discovery.test.mjs
 *
 * Direct, in-process unit coverage for scripts/lib/mission-discovery.mjs's
 * discoverMissionFiles(), which was previously exercised only indirectly
 * through scan-pr.mjs and validate-schema.mjs's `--all` CLI paths
 * (scan-pr-cli-branches.test.mjs, validate-schema-cli-discover.test.mjs).
 * Both of those drive the real function through a spawnSync subprocess
 * (scan-pr-runcli.test.mjs even injects a fake `discoverFiles` so its
 * in-process assertions never call the real implementation), so v8's
 * coverage collector never attributed any statements in this file to a
 * unit test — see vitest.config.mjs's note on subprocess instrumentation.
 *
 * This file exercises discoverMissionFiles() directly (no subprocess) so
 * a future regression in the recursion, extension filter, skip-filename
 * filter, or ENOENT-tolerance guard fails fast and close to the change,
 * without needing to spawn validate-schema.mjs or scan-pr.mjs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  discoverMissionFiles,
  MISSION_EXTENSIONS,
  SKIP_FILENAMES,
} from '../lib/mission-discovery.mjs'

let dir

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('discoverMissionFiles', () => {
  it('returns [] when the directory does not exist (ENOENT tolerance)', () => {
    dir = mkdtempSync(join(tmpdir(), 'mission-discovery-'))
    expect(discoverMissionFiles(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('recursively discovers .json/.yaml/.yml files under nested directories', () => {
    dir = mkdtempSync(join(tmpdir(), 'mission-discovery-'))
    const deep = join(dir, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(dir, 'root.json'), '{}')
    writeFileSync(join(dir, 'a', 'mid.yaml'), '')
    writeFileSync(join(deep, 'leaf.yml'), '')

    const results = discoverMissionFiles(dir)

    expect(results).toHaveLength(3)
    expect(results).toEqual(expect.arrayContaining([
      join(dir, 'root.json'),
      join(dir, 'a', 'mid.yaml'),
      join(deep, 'leaf.yml'),
    ]))
  })

  it('skips files whose extension is not in MISSION_EXTENSIONS', () => {
    dir = mkdtempSync(join(tmpdir(), 'mission-discovery-'))
    writeFileSync(join(dir, 'notes.txt'), '')
    writeFileSync(join(dir, 'README.md'), '')
    writeFileSync(join(dir, 'ok.json'), '{}')

    const results = discoverMissionFiles(dir)

    expect(results).toEqual([join(dir, 'ok.json')])
  })

  it('skips filenames in SKIP_FILENAMES even when the extension matches', () => {
    dir = mkdtempSync(join(tmpdir(), 'mission-discovery-'))
    writeFileSync(join(dir, 'index.json'), '{}')
    writeFileSync(join(dir, 'ok.json'), '{}')

    const results = discoverMissionFiles(dir)

    expect(results).toEqual([join(dir, 'ok.json')])
  })

  it('returns [] for an empty directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'mission-discovery-'))
    expect(discoverMissionFiles(dir)).toEqual([])
  })

  it('exports MISSION_EXTENSIONS and SKIP_FILENAMES as the documented Sets', () => {
    expect(MISSION_EXTENSIONS).toEqual(new Set(['.json', '.yaml', '.yml']))
    expect(SKIP_FILENAMES).toEqual(new Set(['index.json']))
  })

  it('re-throws non-ENOENT errors instead of silently swallowing them', () => {
    // discoverMissionFiles only guards ENOENT; exercise that branch by
    // pointing at a path whose parent is a file, which readdirSync
    // rejects with ENOTDIR (not ENOENT) and must propagate.
    dir = mkdtempSync(join(tmpdir(), 'mission-discovery-'))
    const notADir = join(dir, 'file.json')
    writeFileSync(notADir, '{}')
    expect(() => discoverMissionFiles(join(notADir, 'child'))).toThrow()
  })
})
