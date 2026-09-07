# Incident Response: Mission Merged Without Passing Safety Scan / Schema Validation

## Scope

This runbook covers incidents caused by the `auto-merge` job of the
`CNCF Mission Generation` workflow (`.github/workflows/cncf-mission-gen.yml`),
which merges `cncf-mission-gen`-labeled PRs to `master` using:

```
gh pr merge <pr-number> --squash --admin --delete-branch
```

`--admin` unconditionally overrides branch protection, including any
required status checks and required reviews. The merge decision is based
**solely** on `scripts/quality-scorer.mjs`'s content heuristic (threshold
70/100); it never inspects the result of `Mission Safety Scan`
(`.github/workflows/mission-safety-scan.yml`) or `Validate Mission Schema`
(`.github/workflows/validate-schema.yml`), both of which trigger
`on: pull_request` against the same PR. A mission JSON that scores ≥70 on
the heuristic can reach `master` even if one or both of those checks
failed or never finished running. See `docs/slo.md` section 2 and
`docs/BRANCH_PROTECTION.md` for background — this is a known, tracked gap,
not a hypothetical.

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

### Related gap: `Validate Mission Schema` never checks `runbooks/**`, on PRs *or* on its scheduled sweep

A second, broader instance of the same false-green class affects
`Validate Mission Schema` (`.github/workflows/validate-schema.yml`) itself.
Its `on.pull_request.paths`/`on.push.paths` triggers include `runbooks/**`,
but:

- **PR mode**: the "Find changed files (PR only)" step's `git diff`
  pathspec is `'fixes/**/*.json' 'fixes/**/*.yaml' 'fixes/**/*.yml'` only.
  A `runbooks/**`-only PR resolves to an empty file list, so the
  "Validate schema (PR — changed files only)" step's `if` condition
  (`steps.changed.outputs.files != ''`) is false and the step is
  **skipped** — not failed. The job reports green having validated
  nothing.
- **Scheduled/push mode** (`--all`, weekly Monday 05:30 UTC plus every
  qualifying push to `master`): `scripts/validate-schema.mjs` calls
  `discoverMissionFiles('fixes')` only — `runbooks/**` is never walked,
  even in the full sweep.

The result: the 10 `runbooks/*.json` mission files (same `kc-mission-v1`
schema as `fixes/**`, per `runbooks/README.md`) have **no automated schema
validation coverage at all**, on any trigger, while every run reports
success. Confirmed via `node scripts/validate-schema.mjs $(ls
runbooks/*.json)` (10/10 valid when given directly) vs.
`node scripts/validate-schema.mjs --all` (validates only `fixes/**`, 0
files under `runbooks/**`). Tracked separately as a `[operations]` issue
since fixing it requires editing `.github/workflows/validate-schema.yml`
and `scripts/validate-schema.mjs` (`workflows` permission). Use step 1 of
Detection below manually against `runbooks/*.json` for the same reason.

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
  Schema` shows green, but the job's log shows the "Validate schema (PR —
  changed files only)" step was **skipped** (not run) — this is the
  `runbooks/**`-omission gap described above, and also applies to the
  weekly scheduled sweep, whose log never lists any `runbooks/*.json`
  file among the files it discovered.

## Detection

Run from a checkout of `master`:

```bash
# 1. Confirm the file is valid per the schema validator — `--all` only
#    covers fixes/**, so runbooks/*.json must be passed explicitly too
cd scripts && npm ci && cd ..
node scripts/validate-schema.mjs --all
node scripts/validate-schema.mjs $(ls runbooks/*.json)

# 2. Scan merged mission files for the same dangerous patterns
#    mission-safety-scan.yml checks for (adjust the file list to the
#    suspect mission(s), e.g. from the auto-merge commit's diff)
git log --oneline -10 --grep="cncf-mission-gen" -- fixes/ runbooks/
grep -RPl 'kubectl delete (namespace|ns|all)\b.*--all' fixes/ runbooks/ || true
grep -RPl 'rm\s+-rf?\s+(/|/\*|~|\$HOME)' fixes/ runbooks/ || true
```

If step 1 reports a schema failure, or step 2 matches a merged file,
treat this as a confirmed unsafe/invalid merge.

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

Closing this gap requires editing `.github/workflows/cncf-mission-gen.yml`
to query `gh pr checks <pr-number>` (or
`gh pr view --json statusCheckRollup`) for `Mission Safety Scan` and
`Validate Mission Schema` results before calling `gh pr merge --admin`, or
to drop `--admin` in favor of a mergeable-state check. This requires
`workflows` permission this contribution's credentials do not have —
tracked in the open `[operations]` issue on this repo (auto-merge bypasses
Mission Safety Scan and Validate Mission Schema via `--admin`) and in
`docs/slo.md` section 2.

Closing the separate false-green gap (`Mission Safety Scan` skipping
`runbooks/**` files in its own scan logic) requires editing
`.github/workflows/mission-safety-scan.yml` to add the same
`runbooks/**/*.json`/`*.yaml`/`*.yml` globs already present in its
`on.pull_request.paths` trigger to the `git diff`/`find` file-selection
logic in the "Scan for dangerous commands" step. Also requires `workflows`
permission this contribution's credentials do not have — tracked in a
separate open `[operations]` issue on this repo.

Closing the `Validate Mission Schema` gap (never checking `runbooks/**` on
PRs or on its scheduled sweep) requires: (1) extending the PR-mode
`git diff` pathspec in `.github/workflows/validate-schema.yml` to also
include `'runbooks/**/*.json' 'runbooks/**/*.yaml' 'runbooks/**/*.yml'`,
and (2) having `scripts/validate-schema.mjs`'s `--all` branch also call
`discoverMissionFiles('runbooks')` alongside `discoverMissionFiles('fixes')`.
Requires `workflows` permission this contribution's credentials do not
have — tracked in a separate open `[operations]` issue on this repo
(#3255).
