#!/usr/bin/env node
// Extracted from the "Review: Command smoke test" step of
// .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
// Prints one CLI command per line, found in a mission's step descriptions.
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
const steps = d.mission?.steps || [];
const cmds = steps.flatMap(
  (s) => (s.description || '').match(/(?:helm|kubectl|docker|kustomize|operator-sdk)\s+\w+[^\n`]*/g) || []
);

cmds.forEach((c) => console.log(c.trim().slice(0, 120)));
