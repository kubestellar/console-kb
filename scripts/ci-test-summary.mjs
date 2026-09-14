#!/usr/bin/env node
/**
 * Runs `vitest run` and, in addition to normal console output, writes a
 * bounded, machine-readable summary of the run to `$GITHUB_STEP_SUMMARY`
 * (when present) plus a single `scripts-test-summary` event line via
 * `lib/logger.mjs`'s `summary()` helper on stdout.
 *
 * This exists so that `scripts-tests.yml` and `fuzz.yml`'s `npm test` step
 * (both of which just run `vitest run` today via this package's "test"
 * script) gain a structured, leveled CI-observability record without
 * editing any file under `.github/workflows/` — this repo's GitHub App
 * installation lacks the `workflows` permission needed to do that (see
 * issue #3319). Because `GITHUB_STEP_SUMMARY` is an environment variable
 * GitHub Actions sets for every step in a job, a script invoked by an
 * unchanged `run: npm test` step can still write to it directly.
 *
 * No exporter, metrics backend, or external data flow: stdout/step-summary
 * only, and every field is a bounded count/duration from vitest's own JSON
 * reporter output (see `lib/ci-test-summary.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from './lib/logger.mjs';
import { buildSummary, buildStepSummaryMarkdown } from './lib/ci-test-summary.mjs';

const log = createLogger('ci-test-summary');
const REPORT_PATH = join(tmpdir(), `vitest-report-${randomUUID()}.json`);

// coverageEnabled decides whether the wrapped vitest run should also
// emit v8 coverage. We turn it on automatically under GitHub Actions
// so the CI job actually enforces vitest.config.mjs's coverage
// thresholds (61/61/65/66) and produces lcov + json-summary artifacts
// that a follow-up workflow edit can upload — without slowing down
// day-to-day local `npm test` runs. #3287 tracks the workflow-side
// artifact upload half; the config + wiring halves land here.
//
// Override via CI_COVERAGE=1 (force on) or CI_COVERAGE=0 (force off)
// so a maintainer can bisect a suspected coverage-collector-only
// failure without needing a local env inspection.
export function coverageEnabled(env = process.env) {
  const override = env.CI_COVERAGE;
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  return env.GITHUB_ACTIONS === 'true';
}

function runVitest() {
  const args = [
    join('node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT_PATH}`,
  ];
  if (coverageEnabled()) {
    // vitest.config.mjs already configures the v8 provider, reporters
    // (text + lcov + json-summary), include/exclude, and thresholds.
    // A bare --coverage flips the collector on with that config.
    args.push('--coverage');
  }
  const result = spawnSync(
    process.execPath,
    args,
    { stdio: 'inherit', env: process.env },
  );
  return result.status ?? 1;
}

function readReport() {
  try {
    return JSON.parse(readFileSync(REPORT_PATH, 'utf-8'));
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(REPORT_PATH);
    } catch {
      // best-effort cleanup; missing file is fine
    }
  }
}

function writeStepSummary(summary) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, buildStepSummaryMarkdown(summary));
}

function main() {
  const exitCode = runVitest();
  const report = readReport();
  const summary = buildSummary(report, exitCode);

  writeStepSummary(summary);
  log.summary('scripts-test-summary', {
    level: summary.status === 'pass' ? 'info' : 'error',
    ...summary,
  });

  process.exit(exitCode);
}

// When invoked as a script (node ci-test-summary.mjs), run main().
// Skip main() on import so unit tests can exercise coverageEnabled
// without kicking off vitest.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
