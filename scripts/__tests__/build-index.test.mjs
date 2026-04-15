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
    expect(rbac.qualityScore).toBeDefined(); // Now dynamically evaluated
    expect(rbac.projectVersion).toBe('2.1.0');
  });

  it('should omit versioning metadata when absent', async () => {
    const index = await buildIndex(TEST_DIR);
    const crash = index.missions.find(m => m.title === 'Fix CrashLoopBackOff');
    expect(crash).toBeDefined();
    expect(crash.maturity).toBeUndefined();
    expect(crash.qualityScore).toBeDefined(); // Now dynamically evaluated for all
    expect(crash.projectVersion).toBeUndefined();
  });
});
