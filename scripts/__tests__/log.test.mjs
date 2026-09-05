import { describe, it, expect, vi, afterEach } from 'vitest';
import { logEvent } from '../lib/log.mjs';

describe('logEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes an info-level event to console.log as a JSON payload', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logEvent('mission-indexed', { missionCount: 3 });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0];
    expect(line).toMatch(/^\[kb\] /);
    const payload = JSON.parse(line.slice('[kb] '.length));
    expect(payload.event).toBe('mission-indexed');
    expect(payload.missionCount).toBe(3);
    expect(payload.ts).toBeTruthy();
  });

  it('routes warn-level events to console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logEvent('mission-skipped', { level: 'warn', path: 'fixes/bad.yaml', reason: 'parse error' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(warnSpy.mock.calls[0][0].slice('[kb] '.length));
    expect(payload.path).toBe('fixes/bad.yaml');
  });

  it('routes error-level events to console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logEvent('index-build-failed', { level: 'error', reason: 'disk full' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errorSpy.mock.calls[0][0].slice('[kb] '.length));
    expect(payload.reason).toBe('disk full');
  });

  it('falls back to info level for unrecognized level values', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logEvent('weird-event', { level: 'debug' });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
