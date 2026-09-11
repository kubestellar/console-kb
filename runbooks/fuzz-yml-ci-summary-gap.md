# Runbook: `fuzz.yml` has no structured CI-observability summary

## Status: blocked on GitHub App token permission (`workflows` scope)

Tracked in [#3316](https://github.com/kubestellar/console-kb/issues/3316).

## Gap

`.github/workflows/fuzz.yml`'s three test steps ("Run fuzz tests",
"Property-based testing for JSON schema", "Fuzz mission scanner") only print
decorative free-text to stdout. Nothing is ever written to
`$GITHUB_STEP_SUMMARY`, no step has an `id`, and no step uses `if: always()`.
A failure partway through the job leaves no structured record of what ran
before it stopped, and there is no machine-readable summary line for
grep-based CI tooling.

This is the same gap class already closed for `scripts/validate-marketplace.py`
in `kubestellar/console-marketplace`, and tracked the same way (via a
runbook-preserved diff, not a direct CI-config edit) in that repo's
[PR #616](https://github.com/kubestellar/console-marketplace/pull/616) and
[PR #600](https://github.com/kubestellar/console-marketplace/pull/600), for
the identical reason documented below.

## Why this is a runbook, not a direct CI config edit

A push updating `.github/workflows/fuzz.yml` was rejected server-side by
GitHub with:

```
! [remote rejected] telemetry/fuzz-yml-ci-summary -> telemetry/fuzz-yml-ci-summary
  (refusing to allow a GitHub App to create or update workflow
  `.github/workflows/fuzz.yml` without `workflows` permission)
```

This repo's GitHub App token lacks the `workflows` permission scope needed to
create or update files under `.github/workflows/`. This is a repo-wide (in
fact, org-wide — the same restriction has been hit in `console-marketplace`
and `homebrew-tap`) token limitation, not something retrying the push can
work around. This runbook preserves the validated, ready-to-apply diff so a
maintainer with the right permissions can apply it directly, and so future
audit passes don't keep re-deriving (and re-blocking on) the same fix.

**No CI config file is created or modified by landing this runbook.** Only
this markdown file and a cross-link in `docs/slo.md` are added.

## Ready-to-apply diff

Validated locally (YAML parses, no logic changes to existing steps beyond
adding `id`s and bounded `GITHUB_OUTPUT` writes). Apply with
`git apply` from the repo root, or by hand:

```diff
diff --git a/.github/workflows/fuzz.yml b/.github/workflows/fuzz.yml
index a7c966c..a7c90f6 100644
--- a/.github/workflows/fuzz.yml
+++ b/.github/workflows/fuzz.yml
@@ -30,6 +30,7 @@ jobs:
         run: npm ci
 
       - name: Run fuzz tests
+        id: unit-tests
         working-directory: scripts
         run: npm test
         env:
@@ -37,18 +38,22 @@ jobs:
           FUZZ_ITERATIONS: 1000
 
       - name: Property-based testing for JSON schema
+        id: json-schema
         run: |
           node --input-type=module <<'EOF'
           import { readFileSync, readdirSync } from 'node:fs'
           import { join } from 'node:path'
+          import { appendFileSync } from 'node:fs'
 
           const fixesDirs = ['fixes/cncf-generated', 'fixes/cncf-install', 'fixes/llm-d', 'fixes/platform-install']
           let errors = 0
+          let filesChecked = 0
 
           for (const dir of fixesDirs) {
             try {
               const files = readdirSync(dir, { recursive: true }).filter(file => file.endsWith('.json'))
               for (const file of files) {
+                filesChecked += 1
                 try {
                   JSON.parse(readFileSync(join(dir, file), 'utf-8'))
                 } catch (error) {
@@ -61,18 +66,24 @@ jobs:
             }
           }
 
+          if (process.env.GITHUB_OUTPUT) {
+            appendFileSync(process.env.GITHUB_OUTPUT, `files_checked=${filesChecked}\nerrors=${errors}\n`)
+          }
+
           if (errors > 0) {
             console.error(`\nFuzzing found ${errors} JSON parsing errors`)
             process.exit(1)
           }
 
-          console.log('✓ All JSON files parsed successfully')
+          console.log(`✓ All ${filesChecked} JSON files parsed successfully`)
           EOF
 
       - name: Fuzz mission scanner
+        id: scanner-fuzz
         run: |
           node --input-type=module <<'EOF'
           import { scanMissionFile } from './scripts/scanner.mjs'
+          import { appendFileSync } from 'node:fs'
 
           const malformedInputs = [
             '{"version":"kc-mission-v1"}',
@@ -93,5 +104,40 @@ jobs:
             handled += 1
           }
 
+          if (process.env.GITHUB_OUTPUT) {
+            appendFileSync(process.env.GITHUB_OUTPUT, `handled=${handled}\ntotal=${malformedInputs.length}\n`)
+          }
+
           console.log(`✓ Handled ${handled}/${malformedInputs.length} malformed inputs gracefully`)
           EOF
+
+      - name: CI-observability summary
+        if: always()
+        run: |
+          UNIT_RESULT="${{ steps.unit-tests.outcome }}"
+          SCHEMA_RESULT="${{ steps.json-schema.outcome }}"
+          SCANNER_RESULT="${{ steps.scanner-fuzz.outcome }}"
+          FILES_CHECKED="${{ steps.json-schema.outputs.files_checked }}"
+          SCHEMA_ERRORS="${{ steps.json-schema.outputs.errors }}"
+          SCANNER_HANDLED="${{ steps.scanner-fuzz.outputs.handled }}"
+          SCANNER_TOTAL="${{ steps.scanner-fuzz.outputs.total }}"
+
+          if [ "$UNIT_RESULT" = "success" ] && [ "$SCHEMA_RESULT" = "success" ] && [ "$SCANNER_RESULT" = "success" ]; then
+            OVERALL="pass"
+          else
+            OVERALL="fail"
+          fi
+
+          {
+            echo "## 🧪 Fuzz CI Summary"
+            echo ""
+            echo "| Step | Result |"
+            echo "|------|--------|"
+            echo "| Unit tests (\`npm test\`) | ${UNIT_RESULT:-skipped} |"
+            echo "| JSON schema fuzz (${FILES_CHECKED:-0} files, ${SCHEMA_ERRORS:-0} errors) | ${SCHEMA_RESULT:-skipped} |"
+            echo "| Scanner fuzz (${SCANNER_HANDLED:-0}/${SCANNER_TOTAL:-0} handled) | ${SCANNER_RESULT:-skipped} |"
+            echo ""
+            echo "**Overall: ${OVERALL}**"
+          } >> "$GITHUB_STEP_SUMMARY"
+
+          echo "FUZZ_SUMMARY: {\"unit_tests\":\"${UNIT_RESULT:-skipped}\",\"schema_files_checked\":${FILES_CHECKED:-0},\"schema_errors\":${SCHEMA_ERRORS:-0},\"scanner_handled\":${SCANNER_HANDLED:-0},\"scanner_total\":${SCANNER_TOTAL:-0},\"overall\":\"${OVERALL}\"}"
```

## Scope note

No metrics backend, exporter, or off-box data flow is introduced — this is
CI-log / `$GITHUB_STEP_SUMMARY`-only structured output, consistent with the
"no backend confirmed" posture for this repo (`docs/slo.md`). All counts in
the summary are bounded: the fuzzed-corpus directory list and the malformed-
input list are both fixed, so no field can grow from user-controlled input.
