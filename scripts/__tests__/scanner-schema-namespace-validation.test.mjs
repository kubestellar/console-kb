import { describe, it, expect } from 'vitest'
import { validateMissionExport } from '../scanner.mjs'

// ─── Helpers ─────────────────────────────────────────────────────────

function missionWithStep(description) {
  return {
    version: 'kc-mission-v1',
    name: 'demo-mission',
    mission: {
      title: 'Demo Mission',
      steps: [{ title: 'Step 1', description }],
    },
  }
}

// ─── Namespace flag validation ───────────────────────────────────────
// console-kb#3928 added an RFC 1123 namespace check that misfired on
// -n flags belonging to unrelated commands (echo -n, systemd-ask-password
// -n) and on real namespace flags with trailing sentence punctuation.

describe('validateMissionExport namespace check', () => {
  it('flags a genuinely invalid kubectl namespace', () => {
    const result = validateMissionExport(
      missionWithStep('```bash\nkubectl get pods -n Bad_NS\n```'),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      'Invalid namespace "Bad_NS" in step command (must be an RFC 1123 label)',
    ])
  })

  it('ignores "echo -n" (not a namespace flag)', () => {
    const result = validateMissionExport(
      missionWithStep('```yaml\necho -n v0.0.0-\n```'),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('ignores "-n" on unrelated commands like systemd-ask-password', () => {
    const result = validateMissionExport(
      missionWithStep('```bash\nsystemd-ask-password -n | systemd-creds encrypt\n```'),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('strips trailing sentence punctuation from a real namespace flag', () => {
    const result = validateMissionExport(
      missionWithStep('Running with kubectl get pods -n olm.'),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('still accepts $VAR and <placeholder> namespaces', () => {
    const result = validateMissionExport(
      missionWithStep('```bash\nkubectl get pods -n $NAMESPACE\nkubectl get pods -n <namespace>\n```'),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('still flags an invalid helm --namespace value', () => {
    const result = validateMissionExport(
      missionWithStep('```bash\nhelm upgrade foo bar --namespace Bad_NS\n```'),
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      'Invalid namespace "Bad_NS" in step command (must be an RFC 1123 label)',
    ])
  })
})
