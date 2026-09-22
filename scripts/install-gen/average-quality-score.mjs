#!/usr/bin/env node
/**
 * CLI entry point for the "Merge reports" step of
 * .github/workflows/cncf-install-gen.yml (see kubestellar/console-kb#3164).
 *
 * Prints the average quality score across all generated install missions in
 * fixes/cncf-install, or 0 if none have a recorded score. Missions with no
 * recorded score are excluded so the reported number reflects only missions
 * with a known score — see the `excludeZero` option in
 * `../lib/mission-quality-stats.mjs` and kubestellar/console-kb#3508 for the
 * semantic split against the platform-install variant.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { averageQualityScore } from '../lib/mission-quality-stats.mjs'

const dir = 'fixes/cncf-install'
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '.gitkeep')
const missions = files.map((f) => {
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf-8'))
  } catch {
    return {}
  }
})

console.log(averageQualityScore(missions, { excludeZero: true }))
