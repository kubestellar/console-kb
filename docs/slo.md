# Service Level Objectives: `kubestellar/console-kb`

This repository has no runtime backend of its own — no confirmed OTel/Prometheus/commercial
backend is wired up in this repo. Its user-facing product is the **published mission
catalog**: `fixes/index.json` on `master`, fetched live by the KubeStellar Console frontend
on every KB page load (see `scripts/build-index.mjs`, and `kubestellar/console#8148`, which
serves these index fields via `/api/missions/scores`). CI health on `master` for the
publish/validation pipeline is therefore the closest available user-facing signal, in the
same spirit as `kubestellar/homebrew-tap`'s `docs/slo.md` (formula CI health as SLI proxy).

No exporter or external data flow is added by this document — recommendations only.

## SLIs and SLOs

### 1. Index publish integrity

- **SLI**: `fixes/index.json` on `master` parses as valid JSON and its mission `count`
  matches the number of valid mission files under `fixes/**` and `runbooks/**`.
- **SLO**: 100% of commits to `master` leave `fixes/index.json` valid and in sync.
  Any bad publish is a confirmed incident (see
  [`runbooks/incident-response-index-publish-failure.md`](../runbooks/incident-response-index-publish-failure.md)),
  not a tolerated error budget — this file is read on every Console KB page load.
- **Source**: `Build Mission Index` workflow (`.github/workflows/build-index.yml`) run
  status, plus the manual detection commands in the incident-response runbook.

### 2. Mission content safety

- **SLI**: percentage of merged mission files (`fixes/**`, `runbooks/**`) that pass
  `Mission Safety Scan` (`.github/workflows/mission-safety-scan.yml`) and
  `Validate Mission Schema` (`.github/workflows/validate-schema.yml`) on their
  introducing pull request.
- **SLO**: 100% — these checks run `on: pull_request` only, and nothing merged by a
  human reviewer should bypass both (see `docs/BRANCH_PROTECTION.md`). **Formerly
  known exception, now fixed**: the `CNCF Mission Generation` workflow's
  `auto-merge` job (`.github/workflows/cncf-mission-gen.yml`) used to merge
  `cncf-mission-gen`-labeled PRs with `gh pr merge --admin` based solely on a
  content-heuristic quality score, without ever inspecting `Mission Safety Scan`
  or `Validate Mission Schema` results — closed as
  [#3157](https://github.com/kubestellar/console-kb/issues/3157) and fixed in
  PR [#3418](https://github.com/kubestellar/console-kb/pull/3418), which added a
  `requiredChecksPassed()` gate to `scripts/score-and-merge-mission-prs.mjs` that
  queries `gh pr checks` for both checks before allowing the `--admin` merge, and
  leaves the PR open with an explanatory comment if either check hasn't passed.
  Recovery steps for the historical incident class remain documented in
  [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md).
  **Second known exception**: `Mission Safety Scan` itself has a script-level gap —
  its `on.pull_request.paths` trigger watches `runbooks/**/*.json`/`*.yaml`/`*.yml`,
  but the "Scan for dangerous commands" step's `git diff`/`find` file selection is
  scoped only to `fixes/`. A PR that touches only `runbooks/**` files runs the job,
  finds zero files to scan, and reports "Safety scan passed" without ever
  evaluating the changed file's content — a false-green result that affects any
  `runbooks/**`-only PR, independent of the auto-merge bypass above. Also tracked
  as a follow-up (see below); recovery guidance is in the same
  [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md).
  **Third known exception**: `Validate Mission Schema` itself has a broader
  version of this same gap, **now fixed** — it used to never validate
  `runbooks/**` at all, on *either* trigger. The scheduled/push `--all` mode
  side (`scripts/validate-schema.mjs` only walking `fixes/`) was fixed first,
  so the weekly cadence sweep discovers mission files under `runbooks/` too.
  The remaining PR-mode `git diff` pathspec gap — it covered only
  `fixes/**/*.json`/`*.yaml`/`*.yml`, so a `runbooks/**`-only PR resolved to
  an empty file list and the validation step was skipped (job still reported
  green) — was closed as
  [#3255](https://github.com/kubestellar/console-kb/issues/3255) and fixed in
  PR [#3410](https://github.com/kubestellar/console-kb/pull/3410), which
  extended `.github/workflows/validate-schema.yml`'s "Find changed files (PR
  only)" step to also match `runbooks/**/*.json`/`*.yaml`/`*.yml`. Recovery
  guidance for the historical incident class remains in
  [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md).
  **Fourth known exception**: `KB Quality Enforcement`
  (`.github/workflows/kb-quality-enforcement.yml`) has the same
  false-green gap for a third workflow — its `on.pull_request.paths`
  trigger includes `runbooks/**/*.json`, but the "Detect Changed KB
  Entries" step's `git diff` pathspec covers only `fixes/**/*.json`, so a
  `runbooks/**`-only PR resolves to zero changed files and the "Run
  Quality Scorer" step is skipped (job still reports green, having scored
  nothing). Confirmed reproducible: `node scripts/test-kb-quality-ci.mjs`
  with no args reports "No KB JSON files provided for scoring", while
  `node scripts/test-kb-quality-ci.mjs runbooks/disaster-recovery.json`
  scores it 100/100 when given the file directly. Also tracked as a
  follow-up (see below); recovery guidance is in the same
  [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md).
  **Fifth known exception**: `Mission Content Validation`
  (`.github/workflows/mission-content-validation.yml`) has the same
  false-green gap for a fourth workflow — its `on.pull_request.paths`
  trigger includes `runbooks/**/*.json`/`*.yaml`/`*.yml`, but neither of
  its two validation steps' `git diff` pathspecs (`fixes/cncf-install/
  install-*.{json,yaml,yml}` for "Validate mission quality"; `fixes/**/
  *.{json,yaml,yml}` for "Validate mission content") ever selects a
  `runbooks/**` file. A `runbooks/**`-only PR resolves both steps to an
  empty file list, prints "No install missions changed" / "No solution
  files changed", and `exit 0` — the job reports green having validated
  nothing. Confirmed via direct inspection of
  `.github/workflows/mission-content-validation.yml` (both pathspecs omit
  `runbooks/**` despite the trigger watching it; closed not-planned as
  #3292, same `workflows`-permission constraint as the other exceptions
  above). Also tracked as a follow-up (see below); recovery guidance is in
  the same
  [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md).

  **Separate known gap**: `KB Quality Enforcement`
  (`.github/workflows/kb-quality-enforcement.yml`) triggers on PRs touching
  either `fixes/**/*.json` or `runbooks/**/*.json`, but its "Detect Changed KB
  Entries" step only diffs `fixes/**/*.json` — a PR that changes only
  `runbooks/**/*.json` produces zero detected files, skips the quality-scorer
  step entirely, and still reports the `quality-check` job as passing. Tracked
  as a follow-up (see below); this document does not add the fix itself.

### 3. Time-to-detect a bad publish

- **SLI**: elapsed time from a bad `fixes/index.json` commit landing on `master` to
  the first confirmed detection (manual validation per the incident-response runbook,
  or a future automated check).
- **SLO target**: detect within 24 hours. There is currently no automated alert on
  `Build Mission Index` job failure or on a passing-but-corrupt publish — detection
  today relies on a maintainer noticing a broken Console KB page or a failed
  scheduled workflow run. Tracked as a follow-up (see below); this document does not
  add the alert itself. Until that alert exists, use
  [`runbooks/incident-response-scheduled-workflow-failure.md`](../runbooks/incident-response-scheduled-workflow-failure.md)
  to manually check for a silent job failure.

### 4. Time-to-rollback

- **SLI**: elapsed time from confirmed detection to a reverted `fixes/index.json` on
  `master`.
- **SLO target**: rollback within 1 hour of detection, via
  `git revert --no-edit <bad-commit-sha>` as documented in the incident-response
  runbook's "Immediate mitigation" section.

### 5. CI gate integrity for `scripts/` tests

- **SLI**: whether the `Scripts Tests / test` check (`.github/workflows/scripts-tests.yml`)
  actually blocks a merge when `npm test` in `scripts/` fails, versus only displaying
  green regardless of the suite's real outcome.
- **SLO**: 100% — a check with this name and a green checkmark should mean the suite
  passed, not "informational only." **Known gap**: the `Run tests` step in
  `scripts-tests.yml` still has `continue-on-error: true`, which was added
  intentionally while 4 tests were failing on `master` (#3023) with an explicit
  follow-up to remove it once the suite went green. The suite has since been fully
  green (75 test files, 1108 passing, 1 intentional negative-path fail, verified on
  current `master`), but the flag was never removed — so a real regression in
  `scripts/` (which builds `fixes/index.json` and gates mission content quality)
  can merge to `master` behind a check that reports success either way. Removing
  `continue-on-error: true` requires editing `.github/workflows/scripts-tests.yml`,
  which needs `workflows` permission this contribution's credentials do not have;
  filed separately as [operations] issue
  [#3199](https://github.com/kubestellar/console-kb/issues/3199) rather than
  included in this docs-only change.
- **Source**: `.github/workflows/scripts-tests.yml`, `Scripts Tests / test` check
  status on `master` and on pull requests.

## Follow-up not covered by this document

None of the scheduled workflows that publish or validate content on a cadence
(`build-index.yml` on every qualifying push, `validate-schema.yml` weekly,
`mission-safety-scan.yml` per-PR, `cncf-mission-gen.yml` daily, `cncf-install-gen.yml`
weekly, `scan-missions.yml` weekly, `platform-install-gen.yml` 4x daily, `fuzz.yml`
daily) alert anyone when the *job itself* fails — a red run there means the SLI in
section 3 above cannot be measured at all beyond a maintainer noticing the Actions
tab. `platform-install-gen.yml` writes directly to `fixes/platform-install/**` and
`fixes/index.json` at the highest cadence of any workflow in this repo, so a silent
failure there has the widest exposure window per day. Adding that alert requires
editing `.github/workflows/*.yml`, which needs `workflows` permission this
contribution's credentials do not have; filed separately as `[operations]` issues
instead of included in this docs-only change.

The same gap also applies to this repo's two recurring security scans,
`codeql.yml` (nightly, `30 5 * * *`) and `scorecard.yml` (weekly,
`0 6 * * 1`): neither has an `if: failure()` step, issue/comment creation, or
webhook, so a silently-broken CodeQL or Scorecard run has no automated
time-to-detect signal either. Tracked as a follow-up alongside the workflows
above (see below); this document does not add the alert itself.

The same gap also applies to `stale.yml` (daily, `0 0 * * *`), which
additionally has a real-world precedent: it previously failed silently with
`startup_failure` due to an invalid `secrets:` token passed to
`reusable-stale.yml` (#3057/#3071). A repeat of that failure mode today would
again be visible only via the Actions tab. Tracked as a follow-up alongside
the workflows above (see below); this document does not add the alert
itself.

This silent-failure gap is not limited to cron-triggered workflows: `PR
Verifier` (`.github/workflows/pr-verifier.yml`, triggered on
`pull_request_target`) had a 100% `startup_failure` rate from at least
2026-08-30 through 2026-09-17 (12+ consecutive days, zero jobs ever created
on any run) — the same residual stale-pin issue `#3071` left open for this
file specifically (see
[`runbooks/postmortem-2026-08-stale-workflow-startup-failure.md`](../runbooks/postmortem-2026-08-stale-workflow-startup-failure.md)'s
action-item table). Every PR opened, edited, synced, or reopened in that
window received zero verifier feedback, with no alert distinguishing that
from a healthy "no issues found" result. Filed as
[#3336](https://github.com/kubestellar/console-kb/issues/3336) and
**now fixed**: PR
[#3441](https://github.com/kubestellar/console-kb/pull/3441) (merged
2026-09-17) replaced the broken `uses:` call to
`kubestellar/infra`'s nonexistent `reusable-pr-verifier.yml` with a
minimal self-contained title/body check, closing #3336. Runs have been
green with real jobs created since 2026-09-17T14:20 UTC. This was the
fifth recorded `startup_failure` incident for this workflow since
2026-06-29 (#2704, #2780, #2883, #2975, #3336) — see
[`runbooks/postmortem-2026-09-pr-verifier-chronic-startup-failure.md`](../runbooks/postmortem-2026-09-pr-verifier-chronic-startup-failure.md)
for the retrospective on why none of the first four incidents produced a
safeguard against this recurring failure class before #3441 finally broke
the cycle. The underlying silent-failure gap (no alert distinguishing a
`startup_failure` from a healthy run) remains a follow-up for scheduled
workflows generally — see above.

Separately, the section 2 "known exception" above (`cncf-mission-gen.yml`'s
`--admin` auto-merge bypassing `Mission Safety Scan` and `Validate Mission Schema`)
is now resolved: PR [#3418](https://github.com/kubestellar/console-kb/pull/3418)
added a `requiredChecksPassed()` gate to `scripts/score-and-merge-mission-prs.mjs`
that queries both checks before the `--admin` merge and leaves the PR open with
an explanatory comment otherwise, closing
[#3157](https://github.com/kubestellar/console-kb/issues/3157).

Separately, the section 2 "separate known gap" above (`kb-quality-enforcement.yml`
never scoring `runbooks/**/*.json`-only PRs) also requires editing that workflow's
diff pathspec to include `runbooks/**/*.json` alongside `fixes/**/*.json`. Also
filed separately as a `[operations]` issue for the same `workflows`-permission
reason.

The section 2 "second known exception" above (`mission-safety-scan.yml`'s
scan-step file selection omitting `runbooks/**` despite the workflow's own
trigger watching it) also requires editing that workflow — adding the
`runbooks/**/*.json`/`*.yaml`/`*.yml` globs already present in
`on.pull_request.paths` to the `git diff`/`find` pathspecs in the "Scan for
dangerous commands" step. Also filed separately as a `[operations]` issue
for the same `workflows`-permission reason.

The section 2 "third known exception" above (`validate-schema.yml` never
validating `runbooks/**`) is now fully resolved:
`scripts/validate-schema.mjs`'s `--all` branch discovers files under
`runbooks/` (weekly/push sweep covers all 10 `runbooks/*.json` files), and
the remaining PR-mode gap was closed in PR
[#3410](https://github.com/kubestellar/console-kb/pull/3410), which extended
`validate-schema.yml`'s "Find changed files (PR only)" `git diff` pathspec
with the `runbooks/**/*.json`/`*.yaml`/`*.yml` globs so a `runbooks/**`-only
PR is no longer skipped, closing
[#3255](https://github.com/kubestellar/console-kb/issues/3255).

Separately, `fuzz.yml` (daily, `0 6 * * *`, plus every PR/push to `master`)
has no structured CI-observability summary at all — its steps only print
decorative free-text, with no `$GITHUB_STEP_SUMMARY` output, no step `id`s,
and no `if: always()` summary step, so a mid-job failure leaves no
structured record of what ran. Tracked as [#3316](https://github.com/kubestellar/console-kb/issues/3316)
(closed, but the underlying `fuzz.yml` fix was never applied — the closing
commit only added the runbook and this SLO entry), with the validated,
ready-to-apply diff preserved in
[`runbooks/fuzz-yml-ci-summary-gap.md`](../runbooks/fuzz-yml-ci-summary-gap.md)
for the same `workflows`-permission reason as the follow-ups above.

The section 2 "fifth known exception" above (`mission-content-validation.yml`
never validating `runbooks/**` on PRs, despite triggering on it) also
requires editing that workflow's two `git diff` pathspecs to include
`runbooks/**/*.json`/`*.yaml`/`*.yml`. Filed separately as a `[operations]`
issue (#3292, closed not-planned — same `workflows`-permission constraint
as the other exceptions above); recovery guidance in the same
incident-response runbook stands until code changes.

Separately, the section 5 gap above (`scripts-tests.yml`'s `Run tests` step still
carrying `continue-on-error: true` after the suite went green) also requires
editing that workflow, for the same `workflows`-permission reason; filed as
[#3199](https://github.com/kubestellar/console-kb/issues/3199).

## References


- [`runbooks/incident-response-index-publish-failure.md`](../runbooks/incident-response-index-publish-failure.md)
- [`runbooks/incident-response-search-state-corruption.md`](../runbooks/incident-response-search-state-corruption.md) — covers the `CNCF Mission Generation` workflow's separate direct-to-`master` push of `search-state.json`, which (unlike `fixes/index.json`) has no content-validation gate at all
- [`runbooks/incident-response-unsafe-mission-merge.md`](../runbooks/incident-response-unsafe-mission-merge.md) — covers the `CNCF Mission Generation` workflow's `--admin` auto-merge bypassing `Mission Safety Scan` and `Validate Mission Schema`, and separately, `Mission Safety Scan`'s own false-green on `runbooks/**`-only PRs
- [`runbooks/incident-response-scheduled-workflow-failure.md`](../runbooks/incident-response-scheduled-workflow-failure.md) — manual detection for a silent job failure (or missing run) in any of the nine scheduled/publish/security-scan workflows above, pending the automated alert tracked as a follow-up; also now covers event-triggered reusable-workflow callers, since the same silent-failure risk applies there too (worked example: `pr-verifier.yml`'s #3336 incident, fixed by #3441)
- [Issue #3199](https://github.com/kubestellar/console-kb/issues/3199) — `scripts-tests.yml`'s `Run tests` step still has `continue-on-error: true` despite the suite being green, so the check can report success even on a real regression
- [`runbooks/POSTMORTEM_TEMPLATE.md`](../runbooks/POSTMORTEM_TEMPLATE.md)
- [`docs/BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md)
