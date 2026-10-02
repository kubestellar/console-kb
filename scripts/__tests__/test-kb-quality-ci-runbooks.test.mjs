/**
 * test-kb-quality-ci-runbooks.test.mjs
 *
 * Drives `runQualityCi` against every real `runbooks/*.json` file in the
 * repository so that:
 *
 *   1. `advanced-quality-scorer` is pinned as capable of scoring the
 *      runbook mission class — a regression that caused the scorer to
 *      error (or score 0) on a runbook would fail this suite instead of
 *      silently landing.
 *
 *   2. Once `.github/workflows/kb-quality-enforcement.yml` is widened to
 *      include a `runbooks` tree glob in its diff pathspec (see
 *      kubestellar/console-kb#3631), every current runbook already
 *      clears the configured `MIN_SCORE` threshold — no runbook has to
 *      be rewritten to make the gate green.
 *
 * This is a pure in-process test (no `spawnSync`), using the real
 * on-disk runbook JSON through `runQualityCi`'s default `readFile`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runQualityCi } from '../test-kb-quality-ci.mjs';
import { MIN_SCORE, scoreMissionAdvanced } from '../advanced-quality-scorer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNBOOKS_DIR = join(__dirname, '..', '..', 'runbooks');

function listRunbookJsonFiles() {
  return readdirSync(RUNBOOKS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(RUNBOOKS_DIR, name))
    .sort();
}

function makeSink() {
  const lines = [];
  return { lines, fn: (...args) => lines.push(args.map(String).join(' ')) };
}

function makeLog() {
  const events = [];
  return {
    events,
    summary: (event, payload) => events.push({ event, payload }),
  };
}

describe('runQualityCi against the real runbooks/ corpus', () => {
  it('finds at least one runbook JSON file to score', () => {
    const files = listRunbookJsonFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('scores every runbook at or above MIN_SCORE and exits 0', () => {
    const files = listRunbookJsonFiles();
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const code = runQualityCi({
      files,
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
    });

    expect(stderr.lines).toEqual([]);
    expect(code).toBe(0);

    expect(log.events).toHaveLength(1);
    const [{ event, payload }] = log.events;
    expect(event).toBe('kb-quality-ci-summary');
    expect(payload).toEqual({
      total: files.length,
      passed: files.length,
      failed: 0,
    });
  });

  it('scoreMissionAdvanced accepts each runbook mission without throwing', () => {
    const files = listRunbookJsonFiles();

    for (const file of files) {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const project = data.metadata?.cncfProjects?.[0] || 'runbook';

      let result;
      expect(() => {
        result = scoreMissionAdvanced(data, project, file, MIN_SCORE);
      }).not.toThrow();

      expect(result).toBeDefined();
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(MIN_SCORE);
      expect(result.pass).toBe(true);
    }
  });
});
