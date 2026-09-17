#!/usr/bin/env node
/**
 * CLI entry point for the AVG_SCORE step of
 * .github/workflows/platform-install-gen.yml (see kubestellar/console-kb#3197).
 *
 * Prints the average quality score across all generated platform-install
 * missions in fixes/platform-install, or 0 if none have a recorded score.
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { averageQualityScore } from '../lib/mission-quality-stats.mjs'

const dir = 'fixes/platform-install'
const files = readdirSync(dir).filter((f) => f.startsWith('platform-') && f.endsWith('.json'))
const missions = files.map((f) => {
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf-8'))
  } catch {
    return {}
  }
})

console.log(averageQualityScore(missions))
