// Coverage for initializeSources and deduplicateAgainstExisting in
// generate-cncf-missions.mjs. Both were previously unexported internal
// helpers with zero test coverage; the switch over source ids in
// initializeSources (lines ~157-183) and the file-existence check in
// deduplicateAgainstExisting were completely unexercised.
//
// Pure/fs-only; no network.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  initializeSources,
  deduplicateAgainstExisting,
} from '../generate-cncf-missions.mjs'

describe('initializeSources', () => {
  it('skips sources with enabled: false', () => {
    const config = {
      sources: {
        reddit: { enabled: false },
      },
    }
    expect(initializeSources(config)).toEqual([])
  })

  it('builds a builtin descriptor for github-issues', () => {
    const config = {
      sources: {
        'github-issues': { enabled: true, foo: 'bar' },
      },
    }
    const sources = initializeSources(config)
    expect(sources).toEqual([
      { id: 'github-issues', builtin: true, config: { enabled: true, foo: 'bar' } },
    ])
  })

  it('instantiates RedditSource for the reddit id', () => {
    const config = { sources: { reddit: { enabled: true } } }
    const sources = initializeSources(config)
    expect(sources).toHaveLength(1)
    expect(sources[0].id).toBe('reddit')
    expect(sources[0].builtin).toBe(false)
    expect(sources[0].instance.constructor.name).toBe('RedditSource')
  })

  it('instantiates StackOverflowSource for the stackoverflow id', () => {
    const config = { sources: { stackoverflow: { enabled: true } } }
    const sources = initializeSources(config)
    expect(sources[0].instance.constructor.name).toBe('StackOverflowSource')
  })

  it('instantiates GitHubDiscussionsSource for the github-discussions id', () => {
    const config = { sources: { 'github-discussions': { enabled: true } } }
    const sources = initializeSources(config)
    expect(sources[0].instance.constructor.name).toBe('GitHubDiscussionsSource')
  })

  it('logs and skips unknown source ids', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const config = { sources: { 'mystery-source': { enabled: true } } }
    expect(initializeSources(config)).toEqual([])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown source: mystery-source'))
    logSpy.mockRestore()
  })

  it('builds descriptors for multiple enabled sources in order', () => {
    const config = {
      sources: {
        'github-issues': { enabled: true },
        reddit: { enabled: true },
        stackoverflow: { enabled: false },
      },
    }
    const sources = initializeSources(config)
    expect(sources.map(s => s.id)).toEqual(['github-issues', 'reddit'])
  })
})

describe('deduplicateAgainstExisting', () => {
  let dir
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('returns false when the project directory does not exist', () => {
    expect(deduplicateAgainstExisting('some-slug', '/no/such/dir/for-test')).toBe(false)
  })

  it('returns false when no existing file matches the slug', () => {
    dir = mkdtempSync(join(tmpdir(), 'cncf-dedup-'))
    writeFileSync(join(dir, 'other-slug.json'), '{}')
    expect(deduplicateAgainstExisting('some-slug', dir)).toBe(false)
  })

  it('returns true when a file matching the slug already exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'cncf-dedup-'))
    writeFileSync(join(dir, 'some-slug.json'), '{}')
    expect(deduplicateAgainstExisting('some-slug', dir)).toBe(true)
  })
})
