# Incident Response: Mission Merged Without Passing Safety Scan / Schema Validation

## Scope

This runbook was written for incidents caused by the `auto-merge` job of the
`CNCF Mission Generation` workflow (`.github/workflows/cncf-mission-gen.yml`),
which merges `cncf-mission-gen`-labeled PRs to `master` using:

```
gh pr merge <pr-number> --squash --admin --delete-branch
```

**That specific gap is now fixed.** `--admin` unconditionally overrides
branch protection, including any required status checks and required
reviews, and the merge decision used to be based **solely** on
`scripts/quality-scorer.mjs`'s content heuristic (threshold 70/100),
never inspecting the result of `Mission Safety Scan`
(`.github/workflows/mission-safety-scan.yml`) or `Validate Mission Schema`
(`.github/workflows/validate-schema.yml`). PR
[#3418](https://github.com/kubestellar/console-kb/pull/3418) closed
[#3157](https://github.com/kubestellar/console-kb/issues/3157) by adding a
`requiredChecksPassed()` gate to `scripts/score-and-merge-mission-prs.mjs`
that queries `gh pr checks` for both checks before the `--admin` merge and
leaves the PR open with an explanatory comment if either hasn't passed.
This runbook is retained for historical incident recovery (a bad commit
merged before the fix landed) and because three related false-green gaps
below, affecting other workflows, are still open. See `docs/slo.md`
section 2 and `docs/BRANCH_PROTECTION.md` for background.

`fixes/**` and `runbooks/**` content merged this way feeds
`fixes/index.json`, fetched live by the KubeStellar Console frontend on
every KB page load. An unsafe or schema-invalid mission reaching `master`
is a **user-facing incident**.

### Related gap: `Mission Safety Scan` false-green on `runbooks/**`-only PRs

Separately from the auto-merge bypass above, `Mission Safety Scan` itself
has a script-level gap that affects **any** PR (not just `cncf-mission-gen`
ones) that touches only `runbooks/**` files: its `on.pull_request.paths`
trigger includes `runbooks/**/*.json`, `runbooks/**/*.yaml`, and
`runbooks/**/*.yml`, but the "Scan for dangerous commands" step's file
selection (`git diff --name-only ... -- 'fixes/**/*.json' 'fixes/**/*.yaml'
'fixes/**/*.yml'`, with a `find fixes -name ...` fallback) is scoped only to
`fixes/`. For a `runbooks/**`-only PR, this resolves to an empty file list,
so the loop that checks for dangerous `kubectl`/`rm -rf`/credential/hostname
patterns never runs against the changed file(s) — the job still reports
"Safety scan passed" and shows green. A `runbooks/**` mission can reach
`master` (via normal review, no `--admin` needed) without ever having its
content actually scanned. Tracked separately as a `[operations]` issue since
fixing it requires editing `.github/workflows/mission-safety-scan.yml`
(`workflows` permission). Use the manual scan in step 2 of Detection below
for **any** merged `runbooks/**` file, not only ones merged via auto-merge.

### Related gap: `Validate Mission Schema` never checked `runbooks/**` (now fixed)

A second, broader instance of the same false-green class used to affect
`Validate Mission Schema` (`.github/workflows/validate-schema.yml`). Its
`on.pull_request.paths`/`on.push.paths` triggers include `runbooks/**`, but:

- **PR mode**: the "Find changed files (PR only)" step's `git diff`
  pathspec used to be `'fixes/**/*.json' 'fixes/**/*.yaml' 'fixes/**/*.yml'`
  only. A `runbooks/**`-only PR resolved to an empty file list, so the
  "Validate schema (PR — changed files only)" step's `if` condition
  (`steps.changed.outputs.files != ''`) was false and the step was
  **skipped** — not failed. The job reported green having validated
  nothing.
- **Scheduled/push mode** (`--all`, weekly Monday 05:30 UTC plus every
  qualifying push to `master`): `scripts/validate-schema.mjs` used to call
  `discoverMissionFiles('fixes')` only — `runbooks/**` was never walked,
  even in the full sweep.

**Both sides are now fixed.** The `--all` branch was fixed first to also
discover `runbooks/**` files. The remaining PR-mode gap was closed as
[#3255](https://github.com/kubestellar/console-kb/issues/3255) and fixed
in PR [#3410](https://github.com/kubestellar/console-kb/pull/3410), which
extended the PR-mode `git diff` pathspec to also match
`runbooks/**/*.json`/`*.yaml`/`*.yml`. The 10 `runbooks/*.json` mission
files (same `kc-mission-v1` schema as `fixes/**`, per `runbooks/README.md`)
now have automated schema validation coverage on both triggers. This
section is retained for historical incident recovery only.

### Related gap: `KB Quality Enforcement` false-green on `runbooks/**`-only PRs

A third instance of the same false-green class affects
`KB Quality Enforcement` (`.github/workflows/kb-quality-enforcement.yml`).
Its `on.pull_request.paths` trigger includes `runbooks/**/*.json`, but the
"Detect Changed KB Entries" step's file selection
(`git diff --name-only --diff-filter=d ... -- 'fixes/**/*.json'`) is scoped
only to `fixes/`. For a `runbooks/**`-only PR, this resolves to an empty
file list (`files_changed=false`), so the "Run Quality Scorer" step's `if`
condition is false and the step is **skipped**, not failed — the job
reports green having scored zero files. Confirmed via
`node scripts/test-kb-quality-ci.mjs` (no args → "No KB JSON files
provided for scoring") vs. `node scripts/test-kb-quality-ci.mjs
runbooks/disaster-recovery.json` (scores 100/100 when given the file
directly) — `runbooks` does not otherwise appear in
`scripts/test-kb-quality-ci.mjs` or `scripts/advanced-quality-scorer.mjs`.
Confirmed still present as of this writing. Originally filed as
`[operations]` issue #3203, then re-confirmed and closed as a
docs-only duplicate in #3268 (both now closed, not fixed — the "fourth
known exception" in `docs/slo.md` section 2 remains the authoritative
tracking for this gap) since fixing it requires editing
`.github/workflows/kb-quality-enforcement.yml` (`workflows` permission).
Use the manual scoring command in step 3 of Detection below for any
merged `runbooks/**` file.

### Related gap: `Mission Content Validation` false-green on `runbooks/**`-only PRs

A fourth instance of the same false-green class affects
`Mission Content Validation` (`.github/workflows/mission-content-validation.yml`).
Its `on.pull_request.paths` trigger includes `runbooks/**/*.json`,
`runbooks/**/*.yaml`, and `runbooks/**/*.yml`, but neither of its two
validation steps ever selects a `runbooks/**` file: the "Validate mission
quality" step's `git diff` pathspec is scoped to
`fixes/cncf-install/install-*.{json,yaml,yml}` only, and the "Validate
mission content" step's `git diff` pathspec is
`'fixes/**/*.json' 'fixes/**/*.yaml' 'fixes/**/*.yml'` only. For a
`runbooks/**`-only PR, both steps resolve to an empty file list, print
"No install missions changed" / "No solution files changed", and `exit 0`
— the job reports green having validated nothing. Confirmed via direct
inspection of `.github/workflows/mission-content-validation.yml` (both
`git diff` pathspecs omit `runbooks/**` despite the trigger watching it).
Tracked separately as a `[operations]` issue (#3292, closed not-planned —
same `workflows`-permission constraint as the other three gaps above) since
fixing it requires editing `.github/workflows/mission-content-validation.yml`
to add matching `runbooks/**/*.json`/`*.yaml`/`*.yml` globs to both
`git diff` pathspecs. There is no manual-equivalent check script for this
workflow's quality/reachability heuristics (URL/Helm-repo/container-image
extraction and skeleton-step/placeholder detection are inline in the
workflow, not in `scripts/`), so review any merged `runbooks/**` file by
hand against the checks listed in the "Validate mission quality" and
"Validate mission content" step names in that workflow file.

## Symptoms

- A mission file merged via a `cncf-mission-gen`-labeled PR fails
  `Validate Mission Schema`'s push-triggered run against `master` (it
  triggers on `push` to `master` for `fixes/**`/`runbooks/**`, excluding
  `fixes/index.json` — a failure there means a bad file already landed).
- A mission file contains a pattern that `mission-safety-scan.yml` would
  flag (e.g. `kubectl delete namespace|ns|all ... --all`, `rm -rf` against
  `/`, `/*`, `~`, or `$HOME`, or similar destructive commands — see the
  scan patterns in `.github/workflows/mission-safety-scan.yml`), but the
  PR's `Mission Safety Scan` check shows no run, a cancelled run, or a
  failure, on a PR that was merged anyway.
- The auto-merge PR comment (`Auto-merge: quality score .../100 ...`)
  appears on a PR whose `Mission Safety Scan` or `Validate Mission Schema`
  checks are absent, pending, or red at merge time (visible via
  `gh pr view <pr-number> --json statusCheckRollup`, if the PR is still
  queryable, or the merge commit's associated checks in the GitHub UI).
- A merged PR touched only `runbooks/**` files and `Mission Safety Scan`
  shows green (`Safety scan passed`), but the job's log has no per-file
  scan output for the changed `runbooks/**` file(s) — this is the false-green
  case described above, and applies whether or not the PR went through
  auto-merge.
- A merged PR touched only `runbooks/**` files and `Validate Mission
  Schema` shows green — as of PR #3410, this is expected (the PR-mode
  pathspec now covers `runbooks/**`, so a genuine failure here would show
  the step actually ran and failed, not skipped). If the job's log instead
  shows the "Validate schema (PR — changed files only)" step **skipped**
  entirely, that indicates a regression of the fixed gap and should be
  treated as a new incident.
- A merged PR touched only `runbooks/**` files and `KB Quality
  Enforcement` shows green, but the job's log shows "No KB JSON files
  changed" and the "Run Quality Scorer" step was **skipped** (not run) —
  this is the `KB Quality Enforcement` false-green gap described above.
- A merged PR touched only `runbooks/**` files and `Mission Content
  Validation` shows green, but the job's log shows "No install missions
  changed" and "No solution files changed" on both validation steps — this
  is the `Mission Content Validation` false-green gap described above.

## Detection

Run from a checkout of `master`:

```bash
# 1. Confirm the file is valid per the schema validator. `--all` and the
#    PR-mode pathspec both cover runbooks/** as of PR #3410/the --all fix,
#    but re-check runbooks/*.json explicitly too as defense-in-depth.
cd scripts && npm ci && cd ..
node scripts/validate-schema.mjs --all
node scripts/validate-schema.mjs $(ls runbooks/*.json)

# 2. Scan merged mission files for the same dangerous patterns
#    mission-safety-scan.yml checks for (adjust the file list to the
#    suspect mission(s), e.g. from the auto-merge commit's diff)
git log --oneline -10 --grep="cncf-mission-gen" -- fixes/ runbooks/
grep -RPl 'kubectl delete (namespace|ns|all)\b.*--all' fixes/ runbooks/ || true
grep -RPl 'rm\s+-rf?\s+(/|/\*|~|\$HOME)' fixes/ runbooks/ || true

# 3. Confirm quality-scorer coverage — kb-quality-enforcement.yml only
#    diffs fixes/**, so runbooks/*.json must be passed explicitly too
node scripts/test-kb-quality-ci.mjs $(ls runbooks/*.json)
```

If step 1 reports a schema failure, step 2 matches a merged file, or
step 3 reports a score below threshold, treat this as a confirmed
unsafe/invalid merge.

## Immediate mitigation

1. Identify the offending commit (auto-merged squash commits reference the
   PR number in the commit message, e.g. `... (#1234)`):
   ```bash
   git log --oneline -10 -- fixes/ runbooks/
   ```
2. Revert it on `master` (requires an admin/maintainer with push rights,
   since `--admin` already bypassed branch protection once for this
   content — see `docs/BRANCH_PROTECTION.md`):
   ```bash
   git revert --no-edit <bad-commit-sha>
   git push origin master
   ```
3. If the reverted commit had already been picked up by
   `Build Mission Index`, re-trigger that workflow via `workflow_dispatch`
   and validate `fixes/index.json` per
   [`runbooks/incident-response-index-publish-failure.md`](./incident-response-index-publish-failure.md#detection).

## Root-cause follow-up

1. Confirm which of `Mission Safety Scan` / `Validate Mission Schema` was
   missing, pending, or failing on the merged PR at merge time (the PR's
   Checks tab, if still accessible, or the workflow run history filtered
   to that PR's head SHA).
2. File a postmortem using
   [`runbooks/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md).

## Prevention (tracked, not implemented by this runbook)

The `cncf-mission-gen.yml` auto-merge gap is **fixed**: PR
[#3418](https://github.com/kubestellar/console-kb/pull/3418) added a
`requiredChecksPassed()` gate to `scripts/score-and-merge-mission-prs.mjs`
that queries `gh pr checks <pr-number>` for `Mission Safety Scan` and
`Validate Mission Schema` before calling `gh pr merge --admin`, skipping
the merge (with an explanatory PR comment) if either hasn't passed. This
closed [#3157](https://github.com/kubestellar/console-kb/issues/3157) and
`docs/slo.md` section 2's original "known exception".

Closing the separate false-green gap (`Mission Safety Scan` skipping
`runbooks/**` files in its own scan logic) requires editing
`.github/workflows/mission-safety-scan.yml` to add the same
`runbooks/**/*.json`/`*.yaml`/`*.yml` globs already present in its
`on.pull_request.paths` trigger to the `git diff`/`find` file-selection
logic in the "Scan for dangerous commands" step. Also requires `workflows`
permission this contribution's credentials do not have — tracked in a
separate open `[operations]` issue on this repo.

The `Validate Mission Schema` gap (never checking `runbooks/**` on PRs or
on its scheduled sweep) is **fixed**: the `--all` branch was updated first
(`scripts/validate-schema.mjs`'s `discoverMissionFiles('runbooks')`), and
the remaining PR-mode `git diff` pathspec gap in
`.github/workflows/validate-schema.yml` was closed as
[#3255](https://github.com/kubestellar/console-kb/issues/3255) and fixed
in PR [#3410](https://github.com/kubestellar/console-kb/pull/3410), which
extended the pathspec to also include
`'runbooks/**/*.json' 'runbooks/**/*.yaml' 'runbooks/**/*.yml'`.

Closing the `KB Quality Enforcement` gap (never scoring `runbooks/**` on
PRs) requires extending the `git diff` pathspec in the "Detect Changed KB
Entries" step of `.github/workflows/kb-quality-enforcement.yml` to also
include `'runbooks/**/*.json'`, matching the trigger's own
`on.pull_request.paths`. Requires `workflows` permission this
contribution's credentials do not have. Originally tracked in
`[operations]` issue #3203, closed as a docs-only duplicate in #3268
(both now closed, not fixed) — `docs/slo.md` section 2's "fourth known
exception" remains the authoritative tracking for this gap.

Closing the `Mission Content Validation` gap (never validating
`runbooks/**` on PRs, despite triggering on it) requires extending the
`git diff` pathspecs in both the "Validate mission quality" and "Validate
mission content" steps of
`.github/workflows/mission-content-validation.yml` to also include
`'runbooks/**/*.json' 'runbooks/**/*.yaml' 'runbooks/**/*.yml'`. Requires
`workflows` permission this contribution's credentials do not have —
tracked in a separate `[operations]` issue on this repo (#3292, closed
not-planned) — `docs/slo.md` section 2's "fifth known exception" is the
authoritative tracking for this gap.
