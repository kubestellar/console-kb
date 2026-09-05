import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, LOG_LEVELS } from '../lib/logger.mjs'

describe('createLogger', () => {
  let writeSpy
  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    writeSpy.mockRestore()
  })

  it('exposes debug, info, warn, and error methods matching LOG_LEVELS', () => {
    const logger = createLogger('test-component')
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error'])
    for (const level of LOG_LEVELS) {
      expect(typeof logger[level]).toBe('function')
    }
  })

  it('writes a single JSON line to stderr with level, component, and message', () => {
    const logger = createLogger('mission-executor')
    logger.error('fatal error executing mission', { mission: 'foo.json' })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = writeSpy.mock.calls[0][0]
    expect(written.endsWith('\n')).toBe(true)

    const entry = JSON.parse(written)
    expect(entry.level).toBe('error')
    expect(entry.component).toBe('mission-executor')
    expect(entry.message).toBe('fatal error executing mission')
    expect(entry.mission).toBe('foo.json')
    expect(typeof entry.ts).toBe('string')
    expect(new Date(entry.ts).toString()).not.toBe('Invalid Date')
  })

  it('drops non-primitive field values to keep log lines bounded', () => {
    const logger = createLogger('test-component')
    logger.warn('bad fields', {
      keep: 'yes',
      count: 3,
      ok: true,
      dropped: { nested: 'object' },
      alsoDropped: ['array'],
      alsoNull: null,
    })

    const entry = JSON.parse(writeSpy.mock.calls[0][0])
    expect(entry.keep).toBe('yes')
    expect(entry.count).toBe(3)
    expect(entry.ok).toBe(true)
    expect(entry.alsoNull).toBe(null)
    expect(entry.dropped).toBeUndefined()
    expect(entry.alsoDropped).toBeUndefined()
  })

  it('emits at each level with the correct level field', () => {
    const logger = createLogger('multi-level')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    const levels = writeSpy.mock.calls.map(([line]) => JSON.parse(line).level)
    expect(levels).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('works with no fields argument', () => {
    const logger = createLogger('no-fields')
    expect(() => logger.info('hello')).not.toThrow()
    const entry = JSON.parse(writeSpy.mock.calls[0][0])
    expect(entry.message).toBe('hello')
  })
})
