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

## Detection

Run from a checkout of `master`:

```bash
# 1. Confirm the file is valid per the schema validator
cd scripts && npm ci && cd ..
node scripts/validate-schema.mjs --all

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
