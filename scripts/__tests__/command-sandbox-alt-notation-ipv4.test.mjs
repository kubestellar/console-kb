import { describe, it, expect } from 'vitest'
import { parseAltNotationIPv4 } from '../lib/command-sandbox.mjs'

/**
 * Direct unit coverage for `parseAltNotationIPv4` (console-kb#3770, CWE-918).
 *
 * The existing regression suite (mission-executor-curl-hardening.test.mjs,
 * "curl SSRF alt-notation IPv4 bypass") only exercises this function
 * indirectly through `validateCommand`, which first runs every matched URL
 * through `new URL(...)`. Node's WHATWG URL parser already normalises
 * decimal/hex/octal/shorthand IPv4 hostnames to canonical dotted-decimal
 * before `parseAltNotationIPv4` is ever consulted — so none of those
 * regression cases actually reach this function's body (confirmed by
 * hardcoding it to `return null` and re-running that suite: all 39 tests
 * still passed). That leaves `parseAltNotationIPv4` itself — despite being
 * exported specifically for testing — at 0% coverage, so a real regression
 * in its bit-packing or bounds checks (wrong shift, swapped octet order,
 * missing overflow guard) would ship silently.
 *
 * These tests call the exported function directly, independent of the URL
 * normalisation layer, to cover the 1/2/3/4-part forms and their bounds
 * checks.
 */
describe('parseAltNotationIPv4', () => {
  it('parses canonical 4-part dotted-decimal', () => {
    expect(parseAltNotationIPv4('127.0.0.1')).toBe('127.0.0.1')
  })

  it('parses a 4-part form with a hex first octet', () => {
    expect(parseAltNotationIPv4('0x7f.0.0.1')).toBe('127.0.0.1')
  })

  it('parses a bare decimal 32-bit value (1-part)', () => {
    expect(parseAltNotationIPv4('2130706433')).toBe('127.0.0.1')
  })

  it('parses a bare hex 32-bit value (1-part)', () => {
    expect(parseAltNotationIPv4('0x7f000001')).toBe('127.0.0.1')
  })

  it('parses a bare octal 32-bit value (1-part)', () => {
    expect(parseAltNotationIPv4('017700000001')).toBe('127.0.0.1')
  })

  it('parses the 2-part shorthand (a.b)', () => {
    expect(parseAltNotationIPv4('127.1')).toBe('127.0.0.1')
  })

  it('parses the 3-part shorthand (a.b.c)', () => {
    expect(parseAltNotationIPv4('127.0.1')).toBe('127.0.0.1')
  })

  it('round-trips the cloud metadata address via hex', () => {
    expect(parseAltNotationIPv4('0xa9fea9fe')).toBe('169.254.169.254')
  })

  it('round-trips the cloud metadata address via decimal', () => {
    expect(parseAltNotationIPv4('2852039166')).toBe('169.254.169.254')
  })

  it('rejects a 1-part value above 0xffffffff', () => {
    expect(parseAltNotationIPv4('4294967296')).toBeNull()
  })

  it('rejects a 2-part value whose first octet overflows', () => {
    expect(parseAltNotationIPv4('256.1')).toBeNull()
  })

  it('rejects a 2-part value whose remainder overflows', () => {
    expect(parseAltNotationIPv4('1.16777216')).toBeNull()
  })

  it('rejects a 3-part value whose remainder overflows', () => {
    expect(parseAltNotationIPv4('1.1.65536')).toBeNull()
  })

  it('rejects a 4-part value with an out-of-range octet', () => {
    expect(parseAltNotationIPv4('1.1.1.256')).toBeNull()
  })

  it('returns null for a non-numeric hostname', () => {
    expect(parseAltNotationIPv4('example.com')).toBeNull()
  })

  it('returns null for more than 4 dot-separated segments', () => {
    expect(parseAltNotationIPv4('1.2.3.4.5')).toBeNull()
  })
})
