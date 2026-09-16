#!/usr/bin/env node
// Extracted from the "Review: Version freshness" step of
// .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
// Prints "<repo> <version>" for a single mission file, where <repo> is the
// GitHub "owner/name" slug parsed from metadata.sourceUrls.repo (or empty)
// and <version> is metadata.projectVersion (or "latest").
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
const repo = (d.metadata?.sourceUrls?.repo || '').replace('https://github.com/', '');
const version = d.metadata?.projectVersion || 'latest';

console.log(`${repo} ${version}`);
