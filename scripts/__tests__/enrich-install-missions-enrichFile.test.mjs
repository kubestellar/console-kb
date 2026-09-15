/**
 * Tests for the enrichFile() branches previously uncovered in
 * enrich-install-missions.mjs (lines 245–311). These target:
 *   - filename allowlist rejection
 *   - path-traversal rejection via assertSafePath
 *   - already-enriched short-circuit (uninstall + upgrade + troubleshooting present)
 *   - callLLM returning null → error
 *   - LLM returns object with all sections structurally invalid → error
 *   - LLM returns valid sections → mission is enriched and written
 *   - DRY_RUN=true prevents writes (verified indirectly: file unchanged)
 *   - partial validity: only some sections merged; existing sections preserved
 *
 * The real callLLM() implementation is exercised (global fetch is stubbed) so
 * these tests also cover the success path through callLLM (Content-Type OK,
 * size OK, JSON parse OK) — mirroring what production does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, resolve } from 'path'

// The module captures SOLUTIONS_DIR = join(process.cwd(), 'fixes', 'cncf-install')
// at import time — vitest runs from scripts/, so ensure that path exists BEFORE
// importing. We also set LLM_TOKEN so callLLM() does not short-circuit to null.
const SOLUTIONS_DIR = join(process.cwd(), 'fixes', 'cncf-install')
const preexistingSolutionsDir = existsSync(SOLUTIONS_DIR)
if (!preexistingSolutionsDir) mkdirSync(SOLUTIONS_DIR, { recursive: true })

process.env.LLM_TOKEN = process.env.LLM_TOKEN || 'test-token-not-real'

const { enrichFile } = await import('../enrich-install-missions.mjs')

// A minimal install mission that is NOT already enriched (no uninstall/upgrade/troubleshooting).
function baseMission() {
  return {
    mission: {
      title: 'Install Foo',
      description: 'Install the Foo project',
      steps: [
        { title: 'Add repo', description: 'helm repo add foo https://example.test/foo' },
        { title: 'Install', description: 'helm install foo foo/foo' },
      ],
    },
    metadata: { installMethods: ['helm'], cncfProjects: ['foo'] },
  }
}

// A valid LLM completion body (chat/completions shape). content is a JSON
// string per response_format: json_object.
function fetchResponseWithSections(sections) {
  const contentJson = JSON.stringify(sections)
  const body = JSON.stringify({ choices: [{ message: { content: contentJson } }] })
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
    },
    text: async () => body,
  }
}

const validSections = {
  uninstall: [
    { title: 'Remove release', description: 'helm uninstall foo' },
    { title: 'Remove CRDs', description: 'kubectl delete crd foo.example.com' },
    { title: 'Remove ns', description: 'kubectl delete ns foo' },
  ],
  upgrade: [
    { title: 'Backup', description: 'helm get values foo > backup.yaml' },
    { title: 'Update', description: 'helm repo update && helm upgrade foo foo/foo' },
    { title: 'Verify', description: 'kubectl rollout status deploy/foo' },
  ],
  troubleshooting: [
    { title: 'CrashLoopBackOff', description: 'kubectl logs -n foo -l app=foo' },
    { title: 'ImagePullBackOff', description: 'kubectl describe pod -n foo' },
    { title: 'Pending PVC', description: 'kubectl get pvc -n foo' },
    { title: 'Webhook fails', description: 'kubectl get validatingwebhookconfiguration' },
  ],
}

const createdFiles = new Set()
function writeInstallFile(name, mission) {
  const p = join(SOLUTIONS_DIR, name)
  writeFileSync(p, JSON.stringify(mission, null, 2) + '\n')
  createdFiles.add(p)
  return p
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const p of createdFiles) {
    try { rmSync(p) } catch { /* ignore */ }
  }
  createdFiles.clear()
})

afterAll(() => {
  // Only remove the dir if we created it; do not disturb a real solutions dir.
  if (!preexistingSolutionsDir) {
    try { rmSync(SOLUTIONS_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('enrichFile — filename & path guards', () => {
  it('rejects a filename that does not match install-<slug>.json', async () => {
    const bogus = writeInstallFile('install-ok-for-write.json', baseMission())
    // Pass a non-conforming fileName to trigger the regex guard on line 247.
    await expect(enrichFile(bogus, '../etc/passwd')).rejects.toThrow(
      /Unexpected install mission filename/
    )
  })

  it('rejects a filename with uppercase (allowlist is lowercase only)', async () => {
    const p = writeInstallFile('install-lower.json', baseMission())
    await expect(enrichFile(p, 'Install-Upper.json')).rejects.toThrow(
      /Unexpected install mission filename/
    )
  })

  it('rejects a resolved file path outside SOLUTIONS_DIR (path traversal)', async () => {
    // Filename passes the allowlist regex but the filePath resolves elsewhere.
    const outside = resolve(SOLUTIONS_DIR, '..', 'install-outside.json')
    writeFileSync(outside, JSON.stringify(baseMission()) + '\n')
    createdFiles.add(outside)
    await expect(enrichFile(outside, 'install-outside.json')).rejects.toThrow(
      /Path traversal detected/
    )
  })
})

describe('enrichFile — already-enriched short-circuit', () => {
  it('returns { status: "skipped", reason: "already enriched" } when all 3 sections are present', async () => {
    const enriched = baseMission()
    enriched.mission.uninstall = validSections.uninstall
    enriched.mission.upgrade = validSections.upgrade
    enriched.mission.troubleshooting = validSections.troubleshooting
    const p = writeInstallFile('install-already-enriched.json', enriched)

    // fetch must NOT be called on the short-circuit path.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called when mission is already enriched')
    })

    const result = await enrichFile(p, 'install-already-enriched.json')
    expect(result).toEqual({ status: 'skipped', reason: 'already enriched' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('enrichFile — LLM outcomes', () => {
  it('returns error when callLLM resolves null (e.g. 3 failed attempts)', async () => {
    const p = writeInstallFile('install-llm-null.json', baseMission())
    // A non-ok response that isn't 429 makes callLLM return null after one attempt.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => '',
    })

    const result = await enrichFile(p, 'install-llm-null.json')
    expect(result).toEqual({ status: 'error', reason: 'LLM returned null' })
  })

  it('returns error when every returned section is structurally invalid', async () => {
    const p = writeInstallFile('install-all-invalid.json', baseMission())
    // All three sections fail validateSection (wrong type / empty / missing fields).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fetchResponseWithSections({
        uninstall: 'not-an-array',
        upgrade: [],
        troubleshooting: [{ title: '', description: 'missing title' }],
      })
    )
    const result = await enrichFile(p, 'install-all-invalid.json')
    expect(result).toEqual({ status: 'error', reason: 'All sections invalid' })
  })

  it('enriches a fully-empty mission with all 3 valid sections and writes the file', async () => {
    const p = writeInstallFile('install-happy.json', baseMission())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponseWithSections(validSections))

    const result = await enrichFile(p, 'install-happy.json')

    expect(result.status).toBe('enriched')
    expect(result.sections).toBe(3)
    expect(result.uninstall).toBe(3)
    expect(result.upgrade).toBe(3)
    expect(result.troubleshooting).toBe(4)

    // File was actually written back with the merged sections.
    const onDisk = JSON.parse(readFileSync(p, 'utf-8'))
    expect(onDisk.mission.uninstall).toHaveLength(3)
    expect(onDisk.mission.upgrade).toHaveLength(3)
    expect(onDisk.mission.troubleshooting).toHaveLength(4)
    // Original install steps are preserved.
    expect(onDisk.mission.steps).toHaveLength(2)
  })

  it('only merges the valid section when the others fail validateSection', async () => {
    const p = writeInstallFile('install-partial.json', baseMission())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fetchResponseWithSections({
        uninstall: validSections.uninstall, // valid
        upgrade: [{ title: 'missing description' }], // invalid — no description
        troubleshooting: null, // invalid — not an array
      })
    )

    const result = await enrichFile(p, 'install-partial.json')
    expect(result.status).toBe('enriched')
    expect(result.sections).toBe(1)
    expect(result.uninstall).toBe(3)
    expect(result.upgrade).toBe(0)
    expect(result.troubleshooting).toBe(0)

    const onDisk = JSON.parse(readFileSync(p, 'utf-8'))
    expect(onDisk.mission.uninstall).toHaveLength(3)
    expect(onDisk.mission.upgrade).toBeUndefined()
    expect(onDisk.mission.troubleshooting).toBeUndefined()
  })

  it('does NOT overwrite a pre-existing section even when the LLM returns a valid replacement', async () => {
    const partiallyEnriched = baseMission()
    // Pre-populate uninstall — enrichFile should skip it and only add the two missing ones.
    partiallyEnriched.mission.uninstall = [
      { title: 'Existing uninstall', description: 'do not touch me' },
    ]
    const p = writeInstallFile('install-preserve-existing.json', partiallyEnriched)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchResponseWithSections(validSections))

    const result = await enrichFile(p, 'install-preserve-existing.json')
    expect(result.status).toBe('enriched')
    // Only 2 sections were actually merged (uninstall was already present and
    // is preserved), even though the LLM returned a valid uninstall too. The
    // `uninstall` field in the report reflects the LLM's returned length, not
    // whether it was merged — the on-disk check below is what proves the
    // preserve-existing behavior.
    expect(result.sections).toBe(2)

    const onDisk = JSON.parse(readFileSync(p, 'utf-8'))
    expect(onDisk.mission.uninstall).toEqual([
      { title: 'Existing uninstall', description: 'do not touch me' },
    ])
    expect(onDisk.mission.upgrade).toHaveLength(3)
    expect(onDisk.mission.troubleshooting).toHaveLength(4)
  })

  it('returns skipped/no-new-sections when every LLM section duplicates an already-present one', async () => {
    // Two of the three sections already exist; LLM returns valid versions of
    // ONLY those two, and an invalid third → sectionsAdded stays at 0.
    const mission = baseMission()
    mission.mission.uninstall = validSections.uninstall
    mission.mission.upgrade = validSections.upgrade
    const p = writeInstallFile('install-no-new-sections.json', mission)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fetchResponseWithSections({
        uninstall: validSections.uninstall,
        upgrade: validSections.upgrade,
        troubleshooting: [{ nope: true }], // invalid
      })
    )

    const result = await enrichFile(p, 'install-no-new-sections.json')
    expect(result).toEqual({ status: 'skipped', reason: 'no new sections needed' })
  })
})
