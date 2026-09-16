#!/usr/bin/env node
// Extracted from the "Review: Section completeness" step of
// .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
// Prints "<sections>|<count>/4" for a single mission file, where <sections>
// is a comma-separated list of the mission sections that are populated.
//
// Reads the target file path from the FILE env var instead of interpolating
// it directly into inline JS source, removing a script-injection surface.
import { readFileSync } from 'fs';

const file = process.env.FILE;
if (!file) {
  console.error('FILE env var is required');
  process.exit(2);
}

const d = JSON.parse(readFileSync(file, 'utf-8'));
const m = d.mission || {};
const has = [];
if ((m.steps || []).length > 0) has.push('install');
if ((m.uninstall || []).length > 0) has.push('uninstall');
if ((m.upgrade || []).length > 0) has.push('upgrade');
if ((m.troubleshooting || []).length > 0) has.push('troubleshooting');

console.log(`${has.join(',')}|${has.length}/4`);
