/**
 * Mission Executor — LLM-powered integration test for install missions.
 *
 * Reads a mission JSON file, spins up against a Kind cluster, and uses an LLM
 * agent in a multi-turn loop to:
 *   1. Parse commands from each step's description
 *   2. Execute them against the cluster
 *   3. Diagnose failures and retry (max 3 attempts per step)
 *   4. Run verification steps and confirm the install worked
 *   5. Clean up (delete namespace)
 *
 * Usage:
 *   GITHUB_TOKEN=xxx node scripts/mission-executor.mjs <mission.json> [mission2.json ...]
 *
 * Environment:
 *   GITHUB_TOKEN     — GitHub Models API auth (required)
 *   KUBECONFIG       — path to kubeconfig (default: ~/.kube/config)
 *   LLM_MODEL        — model to use (default: gpt-4o-mini)
 *   MAX_RETRIES      — retries per step (default: 3)
 *   STEP_TIMEOUT_MS  — timeout per command (default: 120000)
 *   MISSION_TIMEOUT_MS — timeout per mission (default: 300000)
 *   DRY_RUN          — if "true", print commands but don't execute
 */

import { readFileSync, writeFileSync } from 'fs'
import { createLogger } from './lib/logger.mjs'
import {
  ALLOWED_BASE_COMMANDS,
  validateCommand,
  parseCommand,
  sanitizeArg,
  runBinary,
  execCommand,
} from './lib/command-sandbox.mjs'
import { SYSTEM_PROMPT, llmChat } from './lib/executor-llm.mjs'

const log = createLogger('mission-executor')

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10)
const MISSION_TIMEOUT_MS = parseInt(process.env.MISSION_TIMEOUT_MS || '300000', 10)
import { DRY_RUN } from './lib/batch-env.mjs'

// ── LLM conversation ───────────────────────────────────────────
//
// Endpoint trust check, token resolution, SYSTEM_PROMPT, and llmChat() now
// live in ./lib/executor-llm.mjs (console-kb#3151). Command sandbox
// primitives (ALLOWED_BASE_COMMANDS, validateCommand, parseCommand,
// sanitizeArg, runBinary, execCommand) live in ./lib/command-sandbox.mjs.
// Both are imported above and re-exported below so existing consumers and
// tests importing from this file are unaffected.

// ── Mission execution ──────────────────────────────────────────

async function executeStep(step, stepIndex, missionContext, conversationHistory) {
  const result = {
    step: stepIndex + 1,
    title: step.title,
    status: 'pending',
    commands_run: [],
    attempts: 0,
    output: '',
  }

  // Ask LLM to extract commands from the step
  const extractMsg = {
    role: 'user',
    content: JSON.stringify({
      action: 'extract_commands',
      step_number: stepIndex + 1,
      step_title: step.title,
      step_description: step.description,
      mission_context: missionContext,
    }),
  }

  conversationHistory.push(extractMsg)

  let llmResponse
  try {
    llmResponse = await llmChat([
      { role: 'system', content: SYSTEM_PROMPT },
      ...conversationHistory,
    ])
  } catch (err) {
    result.status = 'error'
    result.output = `LLM extraction failed: ${err.message}`
    return result
  }

  conversationHistory.push({ role: 'assistant', content: JSON.stringify(llmResponse) })

  const commands = llmResponse.commands || []
  if (commands.length === 0) {
    // LLM found no actionable commands — might be a description-only step
    result.status = 'skipped'
    result.output = 'No actionable commands in this step'
    return result
  }

  console.log(`    Step ${stepIndex + 1}: ${step.title}`)
  if (llmResponse.adaptations) {
    console.log(`    Adaptations: ${llmResponse.adaptations}`)
  }

  // Execute commands with retry loop
  for (const cmd of commands) {
    let lastResult = null

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      result.attempts = attempt + 1
      const cmdToRun = attempt === 0 ? cmd : lastResult?.fixCmd || cmd

      console.log(`      [attempt ${attempt + 1}] ${cmdToRun.slice(0, 120)}`)
      result.commands_run.push(cmdToRun)

      if (DRY_RUN) {
        console.log(`      [dry-run] would execute: ${cmdToRun}`)
        lastResult = { success: true, output: '[dry-run]' }
        break
      }

      const execResult = execCommand(cmdToRun)

      if (execResult.success) {
        console.log(`      ✅ success`)
        lastResult = execResult
        break
      }

      console.log(`      ❌ failed (exit ${execResult.exitCode})`)

      // Ask LLM to diagnose and suggest fix
      const diagMsg = {
        role: 'user',
        content: JSON.stringify({
          action: 'diagnose_failure',
          command: cmdToRun,
          exit_code: execResult.exitCode,
          error_output: execResult.output.slice(-2000),
          attempt: attempt + 1,
          max_attempts: MAX_RETRIES,
        }),
      }

      conversationHistory.push(diagMsg)

      try {
        const diagResponse = await llmChat([
          { role: 'system', content: SYSTEM_PROMPT },
          ...conversationHistory.slice(-10), // keep context window small
        ])

        conversationHistory.push({ role: 'assistant', content: JSON.stringify(diagResponse) })

        if (diagResponse.skip) {
          console.log(`      ⏭️  LLM says skip: ${diagResponse.diagnosis}`)
          lastResult = { success: true, output: `Skipped: ${diagResponse.diagnosis}`, skipped: true }
          break
        }

        if (diagResponse.fix_commands?.length > 0) {
          console.log(`      🔧 LLM fix: ${diagResponse.diagnosis}`)
          // Execute fix commands first, then retry
          for (const fixCmd of diagResponse.fix_commands) {
            console.log(`      [fix] ${fixCmd.slice(0, 120)}`)
            result.commands_run.push(fixCmd)
            if (!DRY_RUN) execCommand(fixCmd)
          }
          lastResult = { ...execResult, fixCmd: diagResponse.fix_commands[diagResponse.fix_commands.length - 1] }
        } else {
          lastResult = execResult
        }
      } catch (diagErr) {
        console.log(`      ⚠️ LLM diagnosis failed: ${diagErr.message}`)
        lastResult = execResult
      }
    }

    if (!lastResult?.success && !lastResult?.skipped) {
      result.status = 'failed'
      result.output = lastResult?.output?.slice(-500) || 'Command failed after retries'
      return result
    }
  }

  result.status = 'passed'
  result.output = 'All commands succeeded'
  return result
}

async function executeMission(missionPath) {
  const startTime = Date.now()
  const raw = readFileSync(missionPath, 'utf-8')
  const mission = JSON.parse(raw)

  const title = mission.mission?.title || mission.name || missionPath
  const steps = mission.mission?.steps || []
  const safeName = (mission.name || 'mission').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)
  const namespace = `test-${safeName}-${Date.now() % 10000}`

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  🚀 Executing: ${title}`)
  console.log(`  📁 File: ${missionPath}`)
  console.log(`  📦 Namespace: ${namespace}`)
  console.log(`  📋 Steps: ${steps.length}`)
  console.log(`${'═'.repeat(70)}`)

  const report = {
    mission: title,
    file: missionPath,
    namespace,
    steps: [],
    verdict: 'pending',
    duration_ms: 0,
    error: null,
  }

  // Create isolated namespace
  if (!DRY_RUN) {
    const namespaceManifest = runBinary('kubectl', ['create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml'])
    if (namespaceManifest.success) {
      runBinary('kubectl', ['apply', '-f', '-'], { input: namespaceManifest.output })
    }
  }

  const kubectlVersion = runBinary('kubectl', ['version', '--client', '-o', 'json'])
  let kubernetesVersion = 'unknown'
  if (kubectlVersion.success) {
    try {
      kubernetesVersion = JSON.parse(kubectlVersion.output).clientVersion?.gitVersion || 'unknown'
    } catch {
      kubernetesVersion = 'unknown'
    }
  }

  const missionContext = {
    namespace,
    cluster_type: 'kind',
    kubernetes_version: kubernetesVersion,
    available_tools: ['kubectl', 'helm', 'curl'],
    note: 'This is a Kind cluster — no LoadBalancer, no cloud storage. Use NodePort or port-forward.',
  }

  const conversationHistory = []

  let allPassed = true
  let verificationPassed = false

  for (let i = 0; i < steps.length; i++) {
    // Check mission timeout
    if (Date.now() - startTime > MISSION_TIMEOUT_MS) {
      console.log(`  ⏰ Mission timeout (${MISSION_TIMEOUT_MS / 1000}s) — aborting remaining steps`)
      report.steps.push({ step: i + 1, title: steps[i].title, status: 'timeout' })
      break
    }

    const stepResult = await executeStep(steps[i], i, missionContext, conversationHistory)
    report.steps.push(stepResult)

    if (stepResult.status === 'failed') {
      allPassed = false
      console.log(`    ❌ Step ${i + 1} failed — continuing to see what else works`)
    }

    // Track if verification step passed
    const desc = (steps[i].description || '').toLowerCase()
    if (desc.includes('verify') || desc.includes('health') || desc.includes('check') || steps[i].title?.toLowerCase().includes('verify')) {
      if (stepResult.status === 'passed') verificationPassed = true
    }
  }

  // Final verification: ask LLM to confirm overall status
  console.log(`\n  🔍 Final verification...`)
  if (!DRY_RUN) {
    const podsExec = runBinary('kubectl', ['get', 'pods', '-n', namespace, '--no-headers'])
    const svcsExec = runBinary('kubectl', ['get', 'svc', '-n', namespace, '--no-headers'])
    const podsResult = podsExec.success ? podsExec : { ...podsExec, output: 'no pods' }
    const svcsResult = svcsExec.success ? svcsExec : { ...svcsExec, output: 'no services' }

    conversationHistory.push({
      role: 'user',
      content: JSON.stringify({
        action: 'final_verification',
        pods: podsResult.output.slice(0, 1000),
        services: svcsResult.output.slice(0, 500),
        step_results: report.steps.map(s => ({ step: s.step, title: s.title, status: s.status })),
      }),
    })

    try {
      const verifyResponse = await llmChat([
        { role: 'system', content: SYSTEM_PROMPT + '\nFor final_verification, respond: {"installed": true/false, "healthy": true/false, "summary": "..."}' },
        ...conversationHistory.slice(-6),
      ])

      if (verifyResponse.installed && verifyResponse.healthy) {
        console.log(`  ✅ LLM confirms: installed and healthy`)
        verificationPassed = true
      } else {
        console.log(`  ⚠️ LLM says: ${verifyResponse.summary || 'not fully installed'}`)
      }
    } catch {
      console.log(`  ⚠️ Final LLM verification skipped`)
    }
  }

  // Cleanup
  console.log(`  🧹 Cleaning up namespace ${namespace}...`)
  if (!DRY_RUN) {
    runBinary('kubectl', ['delete', 'namespace', namespace, '--wait=false'])
  }

  report.duration_ms = Date.now() - startTime

  if (allPassed && verificationPassed) {
    report.verdict = 'pass'
    console.log(`\n  ✅ VERDICT: PASS (${(report.duration_ms / 1000).toFixed(1)}s)`)
  } else if (allPassed) {
    report.verdict = 'pass_unverified'
    console.log(`\n  ⚠️ VERDICT: PASS (unverified — no verification step confirmed)`)
  } else if (verificationPassed) {
    report.verdict = 'partial'
    console.log(`\n  ⚠️ VERDICT: PARTIAL (some steps failed but verification passed)`)
  } else {
    report.verdict = 'fail'
    console.log(`\n  ❌ VERDICT: FAIL (${(report.duration_ms / 1000).toFixed(1)}s)`)
  }

  return report
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('Usage: node mission-executor.mjs <mission.json> [mission2.json ...]')
    log.error('no mission files provided', { argv_count: files.length })
    process.exit(1)
  }

  // Verify cluster connectivity
  console.log('🔌 Checking cluster connectivity...')
  const clusterCheck = runBinary('kubectl', ['cluster-info', '--request-timeout=10s'])
  if (!clusterCheck.success) {
    console.error('❌ Cannot connect to cluster:', clusterCheck.output)
    log.error('cluster connectivity check failed', { error_kind: 'cluster_unreachable' })
    process.exit(1)
  }
  console.log(`✅ Connected: ${(clusterCheck.output || '').split('\n').slice(0, 3)[0]}`)

  // Verify helm is available
  const helmCheck = runBinary('helm', ['version', '--short'])
  console.log(`✅ Helm: ${helmCheck.success ? helmCheck.output : 'not available'}`)

  const results = []
  for (const file of files) {
    try {
      const report = await executeMission(file)
      results.push(report)
    } catch (err) {
      console.error(`\n❌ Fatal error executing ${file}: ${err.message}`)
      log.error('fatal error executing mission', { mission: file })
      results.push({ mission: file, verdict: 'error', error: err.message })
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(70)}`)
  console.log('  📊 Execution Summary')
  console.log(`${'═'.repeat(70)}`)

  const passed = results.filter(r => r.verdict === 'pass').length
  const partial = results.filter(r => r.verdict === 'partial' || r.verdict === 'pass_unverified').length
  const failed = results.filter(r => r.verdict === 'fail' || r.verdict === 'error').length

  for (const r of results) {
    const icon = { pass: '✅', partial: '⚠️', pass_unverified: '⚠️', fail: '❌', error: '💥' }[r.verdict] || '❓'
    const dur = r.duration_ms ? ` (${(r.duration_ms / 1000).toFixed(1)}s)` : ''
    console.log(`  ${icon} ${r.mission}${dur} — ${r.verdict}`)
  }

  console.log(`\n  Total: ${results.length} | ✅ ${passed} | ⚠️ ${partial} | ❌ ${failed}`)
  log.info('mission execution summary', { total: results.length, passed, partial, failed })

  // Write report
  const reportPath = process.env.REPORT_PATH || 'mission-execution-report.json'
  writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { total: results.length, passed, partial, failed } }, null, 2))
  console.log(`\n  📝 Report: ${reportPath}`)

  // Exit code: fail if >50% of missions failed
  if (failed > results.length / 2) {
    console.log('\n  ❌ Majority of missions failed — failing CI')
    process.exit(1)
  }
}

// Only run main() when executed directly (not when imported for testing)
import { fileURLToPath } from 'url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err)
    log.error('unhandled fatal error in main', { error_message: err.message })
    process.exit(1)
  })
}

// Exports for unit testing
export {
  sanitizeArg,
  runBinary,
  validateCommand,
  parseCommand,
  execCommand,
  ALLOWED_BASE_COMMANDS,
  llmChat,
  executeStep,
  executeMission,
  main,
}