#!/usr/bin/env node
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { validateMissionExport } from './scanner.mjs';

const files = process.argv.slice(2);

if (files.length === 0) {
  console.log('No files to validate.');
  process.exit(0);
}

let hasErrors = false;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`❌ ${file}: Could not read file: ${err.message}`);
    hasErrors = true;
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
    continue;
  }

  const result = validateMissionExport(data);

  if (result.valid) {
    console.log(`✅ ${file}: Valid kc-mission-v1`);
  } else {
    console.error(`❌ ${file}:`);
    for (const error of result.errors) {
      console.error(`   - ${error}`);
    }
    hasErrors = true;
  }
}

if (hasErrors) {
  console.error('\n❌ Schema validation failed.');
  process.exit(1);
} else {
  console.log('\n✅ All files passed schema validation.');
  process.exit(0);
}
