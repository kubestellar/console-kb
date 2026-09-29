/**
 * test-kb-quality-ci-runQualityCi.test.mjs
 *
 * Drives the pure `runQualityCi` helper exported from
 * `scripts/test-kb-quality-ci.mjs` in-process, so the CLI's control
 * flow (empty args, per-file try/catch, aggregate failure counting,
 * `log.summary` payload shape, and success/failure exit-code mapping)
 * is attributed by v8 coverage instead of hidden behind a `spawnSync`
 * subprocess. See console-kb#3586.
 *
 * The scoring library (`advanced-quality-scorer.mjs`) is not mocked —
 * the tests use `minScore` to force a pass/fail decision independent
 * of any threshold change, and injected `readFile`/`stdout`/`stderr`/
 * `log` sinks to keep the run entirely in-process.
 */
import { describe, it, expect } from 'vitest';

import { runQualityCi } from '../test-kb-quality-ci.mjs';

function makeSink() {
  const lines = [];
  return {
    lines,
    fn: (...args) => lines.push(args.map(String).join(' ')),
  };
}

function makeLog() {
  const events = [];
  return {
    events,
    summary: (event, payload) => events.push({ event, payload }),
  };
}

function passingMission(project = 'argo') {
  return {
    id: 'install-argo',
    project,
    version: '1.0.0',
    metadata: {
      cncfProjects: [project],
      tags: ['install', 'argo'],
      difficulty: 'beginner',
      estimatedTime: '5m',
    },
    title: 'Install Argo on Kubernetes',
    description:
      'Comprehensive step-by-step instructions for installing the Argo CNCF project on a Kubernetes cluster with prerequisites, verification, and cleanup.',
    prerequisites: ['A running Kubernetes cluster', 'kubectl configured'],
    steps: [
      {
        title: 'Create the argo namespace',
        description: 'Isolate Argo resources in their own namespace.',
        commands: ['kubectl create namespace argo'],
        verification: 'kubectl get namespace argo',
      },
      {
        title: 'Install Argo via the official manifest',
        description: 'Apply the upstream install manifest.',
        commands: ['kubectl apply -n argo -f https://example.com/argo/install.yaml'],
        verification: 'kubectl get pods -n argo',
      },
    ],
    verification: {
      description: 'Verify the Argo control plane is Ready.',
      commands: ['kubectl get pods -n argo'],
      expectedOutput: 'All pods in Running state',
    },
    cleanup: ['kubectl delete namespace argo'],
    troubleshooting: [
      { issue: 'Pods stuck in Pending', resolution: 'Check node capacity and taints.' },
    ],
  };
}

describe('runQualityCi (pure helper)', () => {
  it('returns 0 and emits a zero-count summary when no files are given', () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const code = runQualityCi({ files: [], stdout: stdout.fn, stderr: stderr.fn, log });

    expect(code).toBe(0);
    expect(stdout.lines[0]).toBe('No KB JSON files provided for scoring.');
    expect(stderr.lines).toEqual([]);
    expect(log.events).toEqual([
      { event: 'kb-quality-ci-summary', payload: { total: 0, passed: 0, failed: 0 } },
    ]);
  });

  it('returns 0 and counts every file as passed when all entries meet the threshold', () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const files = ['/kb/a.json', '/kb/b.json'];
    const readFile = (p) => JSON.stringify(passingMission(p.includes('a') ? 'argo' : 'flux'));

    const code = runQualityCi({
      files,
      readFile,
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
      // Very low threshold: whatever scoreMissionAdvanced returns for the
      // fixture above, it will clear it. This isolates the wrapper's
      // pass/fail control flow from any future scorer tuning.
      minScore: 0,
    });

    expect(code).toBe(0);
    expect(stderr.lines).toEqual([]);
    expect(log.events).toEqual([
      { event: 'kb-quality-ci-summary', payload: { total: 2, passed: 2, failed: 0 } },
    ]);
    // Success banner is printed on the stdout sink, not stderr.
    expect(stdout.lines.some((l) => l.startsWith('Evaluating 2 KB entries'))).toBe(true);
    expect(
      stdout.lines.some((l) => l.includes('Success: All 2 KB entries met the minimum quality standards.')),
    ).toBe(true);
    // Each file's [PASS] banner is emitted with the file path.
    expect(stdout.lines.some((l) => l.includes('File: /kb/a.json'))).toBe(true);
    expect(stdout.lines.some((l) => l.includes('File: /kb/b.json'))).toBe(true);
    expect(stdout.lines.some((l) => l.includes('[PASS] OK'))).toBe(true);
  });

  it('returns 1 and counts a below-threshold entry as failed', () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const readFile = () => JSON.stringify(passingMission());

    const code = runQualityCi({
      files: ['/kb/a.json'],
      readFile,
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
      // Impossibly high threshold: no fixture can score 101 out of 100,
      // so the wrapper MUST count this as a failure.
      minScore: 101,
    });

    expect(code).toBe(1);
    expect(log.events).toEqual([
      { event: 'kb-quality-ci-summary', payload: { total: 1, passed: 0, failed: 1 } },
    ]);
    // Failure banner goes to stderr with the threshold interpolated.
    expect(
      stderr.lines.some((l) =>
        l.includes('Validation Failed: 1 KB entries fell below the minimum quality threshold of 101.'),
      ),
    ).toBe(true);
    expect(stdout.lines.some((l) => l.includes('[FAIL] BELOW THRESHOLD'))).toBe(true);
  });

  it('counts an unreadable file as a failure and logs the underlying error', () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const readFile = (p) => {
      if (p === '/kb/missing.json') {
        throw new Error('ENOENT: no such file');
      }
      return JSON.stringify(passingMission());
    };

    const code = runQualityCi({
      files: ['/kb/missing.json', '/kb/ok.json'],
      readFile,
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
      minScore: 0,
    });

    expect(code).toBe(1);
    expect(log.events).toEqual([
      { event: 'kb-quality-ci-summary', payload: { total: 2, passed: 1, failed: 1 } },
    ]);
    expect(
      stderr.lines.some((l) => l.includes('Error evaluating /kb/missing.json') && l.includes('ENOENT')),
    ).toBe(true);
    expect(
      stderr.lines.some((l) => l.includes('Validation Failed: 1 KB entries fell below')),
    ).toBe(true);
  });

  it('counts an invalid-JSON file as a failure', () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const readFile = (p) => (p === '/kb/bad.json' ? '{not json' : JSON.stringify(passingMission()));

    const code = runQualityCi({
      files: ['/kb/bad.json', '/kb/ok.json'],
      readFile,
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
      minScore: 0,
    });

    expect(code).toBe(1);
    expect(log.events).toEqual([
      { event: 'kb-quality-ci-summary', payload: { total: 2, passed: 1, failed: 1 } },
    ]);
    expect(stderr.lines.some((l) => l.startsWith('Error evaluating /kb/bad.json'))).toBe(true);
  });

  it("defaults an entry with no metadata.cncfProjects to project 'Unknown'", () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    const mission = passingMission();
    delete mission.metadata.cncfProjects;

    const code = runQualityCi({
      files: ['/kb/no-project.json'],
      readFile: () => JSON.stringify(mission),
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
      minScore: 0,
    });

    expect(code).toBe(0);
    // The scorer receives 'Unknown' as the project argument and echoes it
    // back on `result.project`, which the wrapper prints verbatim.
    expect(stdout.lines.some((l) => l === 'Project: Unknown')).toBe(true);
  });

  it('prints Issues Found and Suggestions sections when the scorer returns them', () => {
    const stdout = makeSink();
    const stderr = makeSink();
    const log = makeLog();

    // An empty document has no title/description/steps/etc., so
    // scoreMissionAdvanced returns a populated `issues` and `suggestions`
    // list — enough to exercise both `forEach` branches in the wrapper.
    const readFile = () => JSON.stringify({});

    const code = runQualityCi({
      files: ['/kb/empty.json'],
      readFile,
      stdout: stdout.fn,
      stderr: stderr.fn,
      log,
      minScore: 0,
    });

    // With minScore=0 the entry passes, but the Issues/Suggestions lines
    // should still have been rendered.
    expect(code).toBe(0);
    expect(stdout.lines.some((l) => l === '\nIssues Found:')).toBe(true);
    expect(stdout.lines.some((l) => l.startsWith('  [!] '))).toBe(true);
  });
});
