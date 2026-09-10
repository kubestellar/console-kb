/**
 * walkDir + extractMetadata edge-branch coverage for build-index.mjs.
 *
 * The existing build-index-fallback-branches.test.mjs covers the metadata
 * fallback chain in extractMetadata but leaves two specific arms uncovered
 * in the v8 profile:
 *
 *   - build-index.mjs:19  the `if (item.name === 'index.json') continue;`
 *                         skip inside walkDir — no existing test seeds a
 *                         stale index.json in the walked tree.
 *   - build-index.mjs:31  the `!data` arm of the null-guard
 *                         `if (!data || (!data.title && !data.mission?.title))
 *                         return null;` — no test feeds YAML that parses to
 *                         null/undefined (empty document).
 *
 * Each test writes its own scratch directory and asserts the exact arm the
 * fixture is meant to hit. Directories are cleaned up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { buildIndex } from '../build-index.mjs';

const TEST_DIR = join(process.cwd(), 'fixes', '_test-build-index-walkdir');

describe('buildIndex — walkDir and extractMetadata edge branches', () => {
  beforeAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, 'seeded-stale-index'), { recursive: true });
    await mkdir(join(TEST_DIR, 'null-yaml'), { recursive: true });
    await mkdir(join(TEST_DIR, 'good'), { recursive: true });

    // Fixture 1 — a stale index.json sitting inside the walked tree next to a
    // real mission file. walkDir must skip index.json (build-index.mjs:19) or
    // it would be parsed as a mission and pollute the rebuilt index. The
    // stale file's `title` is deliberately distinctive so we can assert it
    // does NOT show up in the new index.
    await writeFile(
      join(TEST_DIR, 'seeded-stale-index', 'index.json'),
      JSON.stringify({
        version: 1,
        count: 1,
        missions: [{ title: 'STALE MUST NOT APPEAR', description: 'x' }],
      })
    );
    await writeFile(
      join(TEST_DIR, 'seeded-stale-index', 'real.yaml'),
      `title: Real Mission Alongside Stale Index
description: This one should appear; the neighbouring index.json must not.
category: seeded-stale-index
type: troubleshoot
`
    );

    // Fixture 2 — YAML document that parses to null (a single line-comment).
    // extractMetadata catches the `!data` arm of its null-guard and returns
    // null instead of crashing when `data.title` is dereferenced.
    await writeFile(
      join(TEST_DIR, 'null-yaml', 'empty-doc.yaml'),
      `# just a comment — parses to null\n`
    );

    // Fixture 3 — a well-formed mission so the index isn't empty on either
    // side, keeping the assertions readable.
    await writeFile(
      join(TEST_DIR, 'good', 'good.yaml'),
      `title: A Good Mission
description: Ensures the good file survives so we can assert on missions.length.
category: good
type: troubleshoot
`
    );
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('skips index.json inside walkDir even when it sits next to real missions', async () => {
    const index = await buildIndex(TEST_DIR);

    // The stale entry MUST be absent from the newly-built index (proves
    // walkDir skipped it rather than parsing it as a mission).
    expect(index.missions.some((m) => m.title === 'STALE MUST NOT APPEAR')).toBe(false);
    // The sibling real mission MUST be present (proves walkDir kept walking
    // rather than short-circuiting on the index.json entry).
    expect(
      index.missions.some((m) => m.title === 'Real Mission Alongside Stale Index')
    ).toBe(true);

    // Sanity: buildIndex wrote its own index.json at the target root. Read
    // it back and confirm the stale title is gone from the on-disk copy too.
    const written = JSON.parse(
      await readFile(join(TEST_DIR, 'index.json'), 'utf-8')
    );
    expect(written.missions.some((m) => m.title === 'STALE MUST NOT APPEAR')).toBe(false);
  });

  it('returns null from extractMetadata when the YAML document is empty (null data)', async () => {
    const index = await buildIndex(TEST_DIR);

    // No mission was produced from null-yaml/empty-doc.yaml — the `!data`
    // guard arm ran, so nothing derived from that fixture should appear.
    for (const m of index.missions) {
      expect(m.path).not.toContain('empty-doc.yaml');
    }

    // extractMetadata still processed the other fixtures normally, so the
    // "good" mission from Fixture 3 must be present.
    expect(index.missions.some((m) => m.title === 'A Good Mission')).toBe(true);
  });
});
