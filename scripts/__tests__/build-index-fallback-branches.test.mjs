/**
 * Branch-coverage tests for scripts/build-index.mjs — extractMetadata's fallback
 * chains and per-field selectors. The existing build-index.test.mjs covers
 * happy paths (metadata.tags, top-level title, curated qualityScore) but leaves
 * every "|| fallback" and "?? default" arm untested. These arms are what silently
 * decide the shape of index.json when a mission author uses the alternate schema
 * (nested `mission.*` block, `metadata.cncfProject` singular, top-level `tags`,
 * ...), so a regression here would corrupt the KB index without a loud failure.
 *
 * Each test writes a self-contained fixture into a scratch directory and runs
 * buildIndex against it, asserting the *specific* fallback arm the fixture is
 * meant to exercise. Fixtures never leak between tests: beforeAll cleans up any
 * stale scratch, and afterAll removes it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { buildIndex } from '../build-index.mjs';

const TEST_DIR = join(process.cwd(), 'fixes', '_test-build-index-branches');

describe('buildIndex — extractMetadata fallback branches', () => {
  beforeAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, 'general'), { recursive: true });
    await mkdir(join(TEST_DIR, 'nested'), { recursive: true });
    await mkdir(join(TEST_DIR, 'toplevel'), { recursive: true });
    await mkdir(join(TEST_DIR, 'cncf-install'), { recursive: true });
    await mkdir(join(TEST_DIR, 'custom-author'), { recursive: true });
    await mkdir(join(TEST_DIR, 'many-issues'), { recursive: true });

    // Fixture 1 — nested `mission.*` block; extractMetadata must fall through
    // `data.title || data.mission?.title`, description, and type. No metadata
    // block at all: exercises `data.metadata?.tags || data.tags || []` -> [] and
    // `data.metadata?.cncfProjects || data.metadata?.cncfProject ? ... : []` -> [].
    await writeFile(
      join(TEST_DIR, 'nested', 'nested-form.yaml'),
      `mission:\n  title: Nested Title Form\n  description: Uses the mission.* nested block instead of top-level.\n  type: install\n`
    );

    // Fixture 2 — top-level `tags` array (no metadata.tags), `metadata.cncfProject`
    // SINGULAR (must be wrapped into an array by the ternary arm), and
    // `metadata.issueTypes` explicitly set (skips extractIssueTypes()).
    await writeFile(
      join(TEST_DIR, 'toplevel', 'toplevel-form.yaml'),
      `title: Top-Level Tags Form
description: Uses top-level tags and metadata.cncfProject singular.
tags:
  - toplevel
  - alt
metadata:
  cncfProject: kubernetes
  issueTypes:
    - CustomIssue
`
    );

    // Fixture 3 — category "cncf-install" so the missionClass inference arm
    // picks 'install' rather than 'troubleshoot'. Explicit `category` in the
    // mission file drives the derivation (path-based fallback would resolve
    // relative to process.cwd() and give an unpredictable segment).
    await writeFile(
      join(TEST_DIR, 'cncf-install', 'install-mission.yaml'),
      `title: Install Something
description: A cncf-install mission with no explicit missionClass.
category: cncf-install
type: install
`
    );

    // Fixture 4 — explicit `missionClass` on the mission itself (must bypass
    // the category-based inference entirely). Explicit `category` pinned so
    // the assertion does not depend on process.cwd() shape.
    await writeFile(
      join(TEST_DIR, 'general', 'explicit-class.yaml'),
      `title: Explicit Class
description: Author set missionClass directly.
category: general
missionClass: workshop
type: troubleshoot
`
    );

    // Fixture 5 — custom `author` and `authorGithub` fields override the
    // default bot identity and drive `authorAvatar`.
    await writeFile(
      join(TEST_DIR, 'custom-author', 'custom-author.yaml'),
      `title: Custom Author
description: Custom author identity.
author: Jane Doe
authorGithub: janedoe
type: troubleshoot
`
    );

    // Fixture 6 — mission that generates >5 quality issues and >5 suggestions
    // so the 5-entry cap is exercised. Advanced scorer emits issues/suggestions
    // for missing structural fields (no steps, no runbook, no schemaVersion,
    // no summary, no risk-level, etc.), so a bare-bones mission is enough.
    await writeFile(
      join(TEST_DIR, 'many-issues', 'sparse.yaml'),
      `title: Sparse Mission
description: A mission intentionally missing most structural fields so the scorer emits many issues and suggestions.
type: troubleshoot
`
    );
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('reads title/description/type from the nested mission.* block', async () => {
    const index = await buildIndex(TEST_DIR);
    const nested = index.missions.find((m) => m.title === 'Nested Title Form');
    expect(nested).toBeDefined();
    expect(nested.description).toBe(
      'Uses the mission.* nested block instead of top-level.'
    );
    expect(nested.type).toBe('install');
    // No metadata block at all -> falls all the way through to empty defaults.
    expect(nested.tags).toEqual([]);
    expect(nested.cncfProjects).toEqual([]);
    expect(nested.targetResourceKinds).toEqual([]);
    expect(nested.installMethods).toEqual([]);
    expect(nested.difficulty).toBe('intermediate');
  });

  it('wraps metadata.cncfProject singular into an array and uses top-level tags', async () => {
    const index = await buildIndex(TEST_DIR);
    const tl = index.missions.find((m) => m.title === 'Top-Level Tags Form');
    expect(tl).toBeDefined();
    // metadata.cncfProject "kubernetes" -> ["kubernetes"] via the ternary arm.
    expect(tl.cncfProjects).toEqual(['kubernetes']);
    // Top-level tags used because there is no metadata.tags.
    expect(tl.tags).toEqual(['toplevel', 'alt']);
    // metadata.issueTypes explicitly set -> skips extractIssueTypes().
    expect(tl.issueTypes).toEqual(['CustomIssue']);
  });

  it('infers missionClass "install" for cncf-install category', async () => {
    const index = await buildIndex(TEST_DIR);
    const inst = index.missions.find((m) => m.title === 'Install Something');
    expect(inst).toBeDefined();
    expect(inst.category).toBe('cncf-install');
    expect(inst.missionClass).toBe('install');
  });

  it('preserves an explicit missionClass field over category-based inference', async () => {
    const index = await buildIndex(TEST_DIR);
    const explicit = index.missions.find((m) => m.title === 'Explicit Class');
    expect(explicit).toBeDefined();
    // Category is "general" (from path) so inference would pick "troubleshoot";
    // the explicit "workshop" value must win.
    expect(explicit.category).toBe('general');
    expect(explicit.missionClass).toBe('workshop');
  });

  it('uses custom author/authorGithub and derives avatar from authorGithub', async () => {
    const index = await buildIndex(TEST_DIR);
    const custom = index.missions.find((m) => m.title === 'Custom Author');
    expect(custom).toBeDefined();
    expect(custom.author).toBe('Jane Doe');
    expect(custom.authorGithub).toBe('janedoe');
    expect(custom.authorAvatar).toBe('https://github.com/janedoe.png');
  });

  it('defaults author identity to the KubeStellar bot when unset', async () => {
    const index = await buildIndex(TEST_DIR);
    const nested = index.missions.find((m) => m.title === 'Nested Title Form');
    expect(nested).toBeDefined();
    expect(nested.author).toBe('KubeStellar Bot');
    expect(nested.authorGithub).toBe('kubestellar');
    expect(nested.authorAvatar).toBe('https://github.com/kubestellar.png');
  });

  it('caps qualityIssues and qualitySuggestions at 5 entries each', async () => {
    const index = await buildIndex(TEST_DIR);
    const sparse = index.missions.find((m) => m.title === 'Sparse Mission');
    expect(sparse).toBeDefined();
    // The cap arm truncates .slice(0, 5) and String(s).slice(0, 200) each entry.
    expect(sparse.qualityIssues.length).toBeLessThanOrEqual(5);
    expect(sparse.qualitySuggestions.length).toBeLessThanOrEqual(5);
    for (const s of [...sparse.qualityIssues, ...sparse.qualitySuggestions]) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeLessThanOrEqual(200);
    }
  });
});
