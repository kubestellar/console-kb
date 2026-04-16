import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { buildIndex } from '../build-index.mjs';

const TEST_DIR = join(process.cwd(), 'solutions', '_test-build-index');

describe('buildIndex', () => {
  beforeAll(async () => {
    await mkdir(join(TEST_DIR, 'troubleshooting'), { recursive: true });
    await mkdir(join(TEST_DIR, 'security'), { recursive: true });
    
    await writeFile(join(TEST_DIR, 'troubleshooting', 'fix-crash.yaml'), `
title: Fix CrashLoopBackOff
description: Resolve pods stuck in CrashLoopBackOff
type: troubleshoot
tags:
  - pod
  - restart
  - crashloop
metadata:
  targetResourceKinds:
    - Pod
  difficulty: beginner
  issueTypes:
    - CrashLoopBackOff
`);
    
    await writeFile(join(TEST_DIR, 'security', 'rbac-fix.json'), JSON.stringify({
      title: 'Fix RBAC Denied Errors',
      description: 'Resolve RBAC permission issues',
      type: 'troubleshoot',
      tags: ['rbac', 'security'],
      metadata: {
        targetResourceKinds: ['ClusterRole', 'RoleBinding'],
        cncfProjects: [],
        difficulty: 'advanced',
        maturity: 'graduated',
        qualityScore: 85,
        projectVersion: '2.1.0',
      }
    }));

    await writeFile(join(TEST_DIR, 'troubleshooting', 'invalid.yaml'), 'not: valid: yaml: {{{}}}');
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should generate index with valid missions', async () => {
    const index = await buildIndex(TEST_DIR);
    expect(index.version).toBe(1);
    expect(index.generatedAt).toBeTruthy();
    expect(index.missions.length).toBeGreaterThanOrEqual(2);
  });

  it('should extract metadata from YAML missions', async () => {
    const index = await buildIndex(TEST_DIR);
    const crash = index.missions.find(m => m.title === 'Fix CrashLoopBackOff');
    expect(crash).toBeDefined();
    expect(crash.tags).toContain('pod');
    expect(crash.targetResourceKinds).toContain('Pod');
    expect(crash.difficulty).toBe('beginner');
    expect(crash.issueTypes).toContain('CrashLoopBackOff');
  });

  it('should extract metadata from JSON missions', async () => {
    const index = await buildIndex(TEST_DIR);
    const rbac = index.missions.find(m => m.title === 'Fix RBAC Denied Errors');
    expect(rbac).toBeDefined();
    expect(rbac.tags).toContain('rbac');
    expect(rbac.targetResourceKinds).toContain('ClusterRole');
    expect(rbac.difficulty).toBe('advanced');
  });

  it('should skip invalid files gracefully', async () => {
    const index = await buildIndex(TEST_DIR);
    const invalid = index.missions.find(m => m.path?.includes('invalid'));
    expect(invalid).toBeUndefined();
  });

  it('should sort missions by title', async () => {
    const index = await buildIndex(TEST_DIR);
    for (let i = 1; i < index.missions.length; i++) {
      expect(index.missions[i].title.localeCompare(index.missions[i-1].title)).toBeGreaterThanOrEqual(0);
    }
  });

  it('should include count in index', async () => {
    const index = await buildIndex(TEST_DIR);
    expect(index.count).toBe(index.missions.length);
  });

  it('should include versioning metadata when present', async () => {
    const index = await buildIndex(TEST_DIR);
    const rbac = index.missions.find(m => m.title === 'Fix RBAC Denied Errors');
    expect(rbac).toBeDefined();
    expect(rbac.maturity).toBe('graduated');
    expect(rbac.projectVersion).toBe('2.1.0');
    // qualityScore: 85 is hand-curated in the fixture JSON and must be preserved.
    // The scorer runs but its computed result (58) is NOT used when a curated value exists.
    expect(rbac.qualityScore).toBe(85);
    expect(rbac.qualityPass).toBe(true); // 85 >= 60 (MIN_SCORE)
    // Breakdown is always from the live scorer (structural metadata, not the stored score)
    expect(rbac.qualityBreakdown).toBeDefined();
    // Arrays capped to max 5 entries
    expect(Array.isArray(rbac.qualityIssues)).toBe(true);
    expect(rbac.qualityIssues.length).toBeLessThanOrEqual(5);
    expect(Array.isArray(rbac.qualitySuggestions)).toBe(true);
    expect(rbac.qualitySuggestions.length).toBeLessThanOrEqual(5);
  });

  it('should omit versioning metadata when absent', async () => {
    const index = await buildIndex(TEST_DIR);
    const crash = index.missions.find(m => m.title === 'Fix CrashLoopBackOff');
    expect(crash).toBeDefined();
    expect(crash.maturity).toBeUndefined();
    expect(crash.projectVersion).toBeUndefined();
    // No hand-curated qualityScore in the YAML fixture, so the scorer's result is used.
    // Score is deterministic: five weighted dimensions on a fixed-content fixture = 58.
    expect(crash.qualityScore).toBe(58);
    expect(crash.qualityPass).toBe(false); // 58 < 60 (MIN_SCORE)
  });
});
