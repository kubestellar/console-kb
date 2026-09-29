#!/usr/bin/env node
/**
 * test-kb-quality-ci.mjs
 *
 * CI entry point that scores each KB JSON file with `scoreMissionAdvanced`
 * and exits non-zero when any entry falls below `MIN_SCORE`.
 *
 * The scoring library itself (`advanced-quality-scorer.mjs`) is well
 * covered by its own unit tests. This wrapper's control flow — argument
 * fan-out, per-file try/catch, aggregate failure counting, `log.summary`
 * payload shape, and exit-code mapping — is exposed via the pure
 * `runQualityCi` helper below so it can be covered in-process (matching
 * the pattern used by `fuzz-json-fixtures.mjs` `runCli` and
 * `ci-test-summary.mjs` `buildSummary`; see console-kb#3586).
 */
import { readFileSync } from 'fs';
import { scoreMissionAdvanced, MIN_SCORE } from './advanced-quality-scorer.mjs';
import { createLogger } from './lib/logger.mjs';

const defaultLog = createLogger('kb-quality-ci');

/**
 * Pure CI runner. Scores each file in `files` and returns a POSIX exit
 * code (0 = every entry met the threshold, 1 = at least one entry failed
 * or could not be read).
 *
 * `readFile`, `log`, `stdout`, and `stderr` are injectable so tests can
 * drive this path in-process without touching the real filesystem or
 * process streams. `minScore` is threaded through so tests can force a
 * pass/fail decision independent of the real `MIN_SCORE` constant.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.files]        list of KB JSON file paths
 * @param {(path: string, enc: string) => string} [opts.readFile]
 * @param {{summary: (event: string, payload: object) => void}} [opts.log]
 * @param {(...args: unknown[]) => void} [opts.stdout]
 * @param {(...args: unknown[]) => void} [opts.stderr]
 * @param {number} [opts.minScore]       minimum passing score
 * @returns {0 | 1}
 */
export function runQualityCi({
  files = [],
  readFile = (p) => readFileSync(p, 'utf-8'),
  log = defaultLog,
  stdout = console.log,
  stderr = console.error,
  minScore = MIN_SCORE,
} = {}) {
  if (files.length === 0) {
    stdout('No KB JSON files provided for scoring.');
    log.summary('kb-quality-ci-summary', { total: 0, passed: 0, failed: 0 });
    return 0;
  }

  stdout(`Evaluating ${files.length} KB entries for quality...\n`);

  let failed = 0;

  for (const file of files) {
    try {
      const content = readFile(file, 'utf-8');
      const data = JSON.parse(content);

      const project = data.metadata?.cncfProjects?.[0] || 'Unknown';
      const result = scoreMissionAdvanced(data, project, file, minScore);

      stdout(`=================================================`);
      stdout(`File: ${file}`);
      stdout(`Project: ${result.project}`);
      stdout(`Score: ${result.score}/100 (${result.pass ? '[PASS] OK' : '[FAIL] BELOW THRESHOLD'})`);
      stdout(`Breakdown:`);
      Object.entries(result.breakdown).forEach(([k, v]) => {
        stdout(`  - ${k}: ${v}`);
      });

      if (result.issues.length > 0) {
        stdout(`\nIssues Found:`);
        result.issues.forEach((i) => stdout(`  [!] ${i}`));
      }

      if (result.suggestions.length > 0) {
        stdout(`\nSuggestions:`);
        result.suggestions.forEach((s) => stdout(`  [*] ${s}`));
      }

      stdout(`=================================================\n`);

      if (!result.pass) {
        failed++;
      }
    } catch (e) {
      stderr(`Error evaluating ${file}: ${e.message}`);
      failed++;
    }
  }

  log.summary('kb-quality-ci-summary', {
    total: files.length,
    passed: files.length - failed,
    failed,
  });

  if (failed > 0) {
    stderr(`\nValidation Failed: ${failed} KB entries fell below the minimum quality threshold of ${minScore}.`);
    return 1;
  }

  stdout(`\nSuccess: All ${files.length} KB entries met the minimum quality standards.`);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runQualityCi({ files: process.argv.slice(2) }));
}
