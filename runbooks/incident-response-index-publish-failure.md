# Incident Response: Bad `fixes/index.json` Publish

## Scope

This runbook covers incidents caused by the `Build Mission Index` workflow
(`.github/workflows/build-index.yml`), which regenerates `fixes/index.json`
and pushes the result **directly to `master`** on every merge that touches
`fixes/**` or `runbooks/**` — with no pull request, no required review, and
no gate from `mission-safety-scan.yml` or the PR path of
`validate-schema.yml` (both of which only run `on: pull_request`).

`fixes/index.json` is not just repository content: it is fetched by the
KubeStellar Console frontend on every KB page load (see the companion note
in `scripts/build-index.mjs` referencing `kubestellar/console#8148`, which
serves these index fields via `/api/missions/scores`). A bad publish is a
**user-facing incident**, not a cosmetic repo issue.

## Symptoms

- The Console KB page fails to load, shows an empty/stale mission list, or
  errors fetching mission scores.
- `fixes/index.json` on `master` fails to parse as JSON, or its `count`
  field does not match the number of valid mission files under `fixes/**`
  and `runbooks/**`.
- The `Build Mission Index` workflow run shows a commit pushed to `master`
  immediately followed by reports of missing/garbled KB content.

## Detection

Run from a checkout of `master`:

```bash
# 1. Confirm the file is valid JSON
node -e "JSON.parse(require('fs').readFileSync('fixes/index.json','utf8')); console.log('valid JSON')"

# 2. Compare the reported count against a fresh local build
cd scripts && npm ci && cd ..
node scripts/build-index.mjs
git diff --stat fixes/index.json
```

If step 1 fails, or step 2 shows a large unexpected diff (missions
disappearing, `qualityScore` values collapsing to the same number, etc.),
treat this as a confirmed bad publish.

## Immediate mitigation

1. Identify the offending commit:
   ```bash
   git log --oneline -5 -- fixes/index.json
   ```
   Auto-published commits are authored by `github-actions[bot]` with the
   message `🌱 Auto-update mission index`.
2. Revert it on `master` (requires an admin/maintainer with push rights,
   since this repository does not currently require PR review for direct
   pushes from CI — see `docs/BRANCH_PROTECTION.md`):
   ```bash
   git revert --no-edit <bad-commit-sha>
   git push origin master
   ```
3. Confirm the Console KB page recovers (fetches `fixes/index.json`
   successfully) after the revert propagates.

## Root-cause follow-up

1. Re-run `node scripts/build-index.mjs` locally against the current
   `fixes/**`/`runbooks/**` tree and diff the output against the reverted
   version to isolate which source mission file or scorer change caused
   the bad output.
2. Fix the offending mission file or scorer logic through a normal
   reviewed pull request (do not push the fix directly to `master`).
3. Re-trigger the index rebuild via `workflow_dispatch` on
   `Build Mission Index` once the fix merges, and re-validate with the
   detection steps above.
4. File a postmortem using
   [`runbooks/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md).

## Prevention (tracked, not implemented by this runbook)

`docs/BRANCH_PROTECTION.md` already recommends routing bot-generated
commits through a `generated/` branch merged via reviewed PRs instead of
pushing straight to `master`. This runbook does not change
`build-index.yml` — it documents recovery until that safeguard is adopted.
