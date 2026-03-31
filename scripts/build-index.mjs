#!/usr/bin/env node
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, relative, extname } from 'path';
import { parse as parseYaml } from 'yaml';

const SOLUTIONS_DIR = join(process.cwd(), 'fixes');
const INDEX_PATH = join(SOLUTIONS_DIR, 'index.json');

async function walkDir(dir) {
  const entries = [];
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...await walkDir(fullPath));
    } else if (['.yaml', '.yml', '.json'].includes(extname(item.name).toLowerCase())) {
      if (item.name === 'index.json') continue;
      entries.push(fullPath);
    }
  }
  return entries;
}

function extractMetadata(content, filePath) {
  const relPath = relative(process.cwd(), filePath);
  try {
    const data = filePath.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
    if (!data || (!data.title && !data.mission?.title)) return null;
    
    // Extract category from path: fixes/<category>/...
    const pathParts = relPath.split('/');
    const category = pathParts.length > 1 ? pathParts[1] : 'general';

    // Determine missionClass: explicit field > path-based > default
    let missionClass = data.missionClass;
    if (!missionClass) {
      missionClass = category === 'cncf-install' ? 'install' : 'troubleshoot';
    }

    // Author: from mission JSON or default to bot
    const author = data.author || 'KubeStellar Bot';
    const authorGithub = data.authorGithub || 'kubestellar';
    
    const entry = {
      path: relPath,
      title: data.title || data.mission?.title || '',
      description: (data.description || data.mission?.description || '').slice(0, 200),
      category,
      missionClass,
      author,
      authorGithub,
      authorAvatar: `https://github.com/${authorGithub}.png`,
      tags: data.metadata?.tags || data.tags || [],
      cncfProjects: data.metadata?.cncfProjects || (data.metadata?.cncfProject ? [data.metadata.cncfProject] : []),
      targetResourceKinds: data.metadata?.targetResourceKinds || [],
      difficulty: data.metadata?.difficulty || 'intermediate',
      issueTypes: data.metadata?.issueTypes || extractIssueTypes(data),
      type: data.type || data.mission?.type || 'troubleshoot',
      installMethods: data.metadata?.installMethods || [],
    };

    // Include versioning metadata when present in the mission file
    if (data.metadata?.projectVersion) entry.projectVersion = data.metadata.projectVersion;
    if (data.metadata?.maturity) entry.maturity = data.metadata.maturity;
    if (data.metadata?.qualityScore != null) entry.qualityScore = data.metadata.qualityScore;

    return entry;
  } catch (e) {
    console.warn(`Skipping ${relPath}: ${e.message}`);
    return null;
  }
}

function extractIssueTypes(data) {
  const types = [];
  const text = JSON.stringify(data).toLowerCase();
  const patterns = [
    ['CrashLoopBackOff', /crashloopbackoff/],
    ['OOMKilled', /oomkill/],
    ['ImagePullBackOff', /imagepullbackoff/],
    ['PodUnschedulable', /unschedulable/],
    ['NodeNotReady', /nodenotready|node.*not.*ready/],
    ['ServiceUnavailable', /service.*unavailable|503/],
    ['CertificateExpired', /certificate.*expir/],
    ['PersistentVolumeError', /pv.*error|volume.*fail/],
    ['NetworkPolicy', /network.*polic/],
    ['RBACDenied', /rbac.*denied|forbidden/],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) types.push(name);
  }
  return types;
}

export async function buildIndex() {
  const files = await walkDir(SOLUTIONS_DIR);
  const missions = [];
  
  for (const filePath of files) {
    const content = await readFile(filePath, 'utf-8');
    const meta = extractMetadata(content, filePath);
    if (meta) missions.push(meta);
  }
  
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: missions.length,
    missions: missions.sort((a, b) => a.title.localeCompare(b.title)),
  };
  
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.log(`Generated index with ${missions.length} missions at ${INDEX_PATH}`);
  return index;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('build-index.mjs')) {
  buildIndex().catch(e => { console.error(e); process.exit(1); });
}
