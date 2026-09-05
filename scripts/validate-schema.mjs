#!/usr/bin/env node
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { validateMissionExport } from './scanner.mjs';

/** Valid mission file extensions */
const MISSION_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);

/** Files to skip when discovering all missions */
const SKIP_FILENAMES = new Set(['index.json']);

/**
 * Recursively discovers all mission files under the given directory.
 * Returns an array of relative file paths.
 */
function discoverMissionFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverMissionFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = entry.name.substring(entry.name.lastIndexOf('.'));
      if (MISSION_EXTENSIONS.has(ext) && !SKIP_FILENAMES.has(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Emits a single-line JSON event to stdout for CI observability.
 * Kept local to this script (no shared dependency) so it can be adopted
 * independently of any other in-flight structured-logging change.
 */
function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * Runs schema validation over `files` and returns a result summary.
 * Exported for unit testing; does not call process.exit.
 */
export function runValidation(files) {
  let hasErrors = false;
  let validCount = 0;
  let invalidCount = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`❌ ${file}: Could not read file: ${err.message}`);
      hasErrors = true;
      invalidCount++;
      continue;
    }

    let data;
    try {
      if (file.endsWith('.json')) {
        data = JSON.parse(content);
      } else if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        data = yaml.load(content);
      } else {
        // Try JSON first, then YAML
        try {
          data = JSON.parse(content);
        } catch {
          data = yaml.load(content);
        }
      }
    } catch (err) {
      console.error(`❌ ${file}: Parse error: ${err.message}`);
      hasErrors = true;
      invalidCount++;
      continue;
    }

    const result = validateMissionExport(data);

    if (result.valid) {
      console.log(`✅ ${file}: Valid kc-mission-v1`);
      validCount++;
    } else {
      console.error(`❌ ${file}:`);
      for (const error of result.errors) {
        console.error(`   - ${error}`);
      }
      hasErrors = true;
      invalidCount++;
    }
  }

  return { hasErrors, validCount, invalidCount, total: files.length };
}

function main() {
  const args = process.argv.slice(2);
  const trigger = args.includes('--all') ? 'all' : 'changed-files';
  const startedAt = Date.now();

  let files;
  if (args.includes('--all')) {
    // Discover all mission files under fixes/ (used for push/schedule/dispatch)
    files = discoverMissionFiles('fixes');
    console.log(`Discovered ${files.length} mission files to validate.\n`);
  } else {
    files = args.flatMap(a => a.split(/\s+/)).filter(Boolean);
  }

  if (files.length === 0) {
    console.log('No files to validate.');
    logEvent('schema-validation-summary', {
      level: 'info',
      trigger,
      total: 0,
      validCount: 0,
      invalidCount: 0,
      durationMs: Date.now() - startedAt,
    });
    process.exit(0);
  }

  const { hasErrors, validCount, invalidCount, total } = runValidation(files);
  const durationMs = Date.now() - startedAt;

  logEvent('schema-validation-summary', {
    level: hasErrors ? 'error' : 'info',
    trigger,
    total,
    validCount,
    invalidCount,
    durationMs,
  });

  if (hasErrors) {
    console.error('\n❌ Schema validation failed.');
    process.exit(1);
  } else {
    console.log('\n✅ All files passed schema validation.');
    process.exit(0);
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('validate-schema.mjs')) {
  main();
}
