import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Regression guard for build-index.mjs's runbook fallback branch:
// when the caller invokes buildIndex() with no argument (targetDir defaults to
// SOLUTIONS_DIR) and runbooks/ does not exist, walkDir(RUNBOOKS_DIR) must be
// caught and a warning emitted, and buildIndex must still complete using only
// missions found under fixes/. Previously this branch (lines 119-123) was
// uncovered — every existing test passed an explicit targetDir which bypasses
// the runbooks lookup entirely.
describe('buildIndex() default-arg runbook fallback', () => {
  const originalCwd = process.cwd();
  let workDir;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'build-index-runbook-fallback-'));
    // fixes/ exists with one valid mission; runbooks/ deliberately absent.
    await mkdir(join(workDir, 'fixes', 'general'), { recursive: true });
    await writeFile(
      join(workDir, 'fixes', 'general', 'sample.yaml'),
      [
        'title: Sample Mission',
        'description: A minimal fixture used to exercise the runbook fallback branch.',
        'type: troubleshoot',
        'tags:',
        '  - sample',
      ].join('\n') + '\n',
    );
    process.chdir(workDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('warns about the missing runbooks/ directory and still writes fixes/index.json', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Fresh import so SOLUTIONS_DIR / RUNBOOKS_DIR resolve against workDir.
    vi.resetModules();
    const { buildIndex } = await import('../build-index.mjs');

    const index = await buildIndex(); // no arg → defaults to SOLUTIONS_DIR

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No runbooks/ directory found'),
    );
    expect(index.version).toBe(1);
    expect(index.count).toBe(1);
    expect(index.missions[0].title).toBe('Sample Mission');

    // Verify the file was written to fixes/index.json (SOLUTIONS_DIR/index.json)
    const written = JSON.parse(
      await readFile(join(workDir, 'fixes', 'index.json'), 'utf-8'),
    );
    expect(written.count).toBe(1);
    expect(written.missions[0].title).toBe('Sample Mission');

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
