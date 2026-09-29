# Incident Response: Corrupted `search-state.json`

## Scope

This runbook covers incidents caused by the `collect` job of the
`CNCF Mission Generation` workflow (`.github/workflows/cncf-mission-gen.yml`),
which merges per-batch search state and pushes `search-state.json`
**directly to `master`** on every scheduled run (daily, `0 6 * * *`) —
with no pull request, no required review, and, unlike `fixes/index.json`,
no gate at all from `mission-content-validation.yml` or
`kb-quality-enforcement.yml` (both trigger only on
`fixes/**/*.json` and `runbooks/**/*.json` paths — `search-state.json`
lives at the repo root and is validated by neither).

`search-state.json` is not cosmetic bookkeeping: it is the **dedup memory**
for CNCF issue/discussion scanning across every configured project. If the
checked-out `search-state.json` fails to parse, `scripts/merge-search-state.mjs`
self-heals: it treats the base as an empty `projects: {}` object and
proceeds, rather than failing the job (this replaced an `exit(1)` that used
to permanently break the scheduled workflow — see
kubestellar/console-kb#3197). A corrupted-then-reset state is a **quiet**
incident in the sense that the workflow run still shows green, but as of
this fix it is no longer silent: the merge step logs loudly to stderr, and
when `GITHUB_STEP_SUMMARY` is set (every real run) it appends a `⚠️
search-state.json self-healed from corrupt base` warning to the run's job
summary. The corrupt file is also renamed to a timestamped
`search-state.json.corrupt-<ts>` copy on disk, but that copy is **not**
retrievable after the job — it lives only on the ephemeral runner, is never
uploaded as a workflow artifact, and is gone once the job ends, so treat
the job-summary line (or the stderr log) as the actual detection signal,
not the renamed file.

## Symptoms

- `generation-report.md` (workflow artifact/summary) shows an unusually
  high count of Copilot issues created for `gh:<org>/<repo>#<id>` entries
  that were already flagged in a prior run's report.
- `search-state.json` on `master` fails to parse as JSON, or its
  `projects` object is unexpectedly small/empty compared to the previous
  commit.
- A `🌱 Update CNCF mission search state` commit lands with a diff that
  drops most `processedIds` arrays to empty instead of only appending.

## Detection

Run from a checkout of `master`:

```bash
# 1. Confirm the file is valid JSON
node -e "JSON.parse(require('fs').readFileSync('search-state.json','utf8')); console.log('valid JSON')"

# 2. Compare project/processedIds counts against the prior commit
git show HEAD~1:search-state.json > /tmp/search-state-prev.json
node -e "
  const cur = JSON.parse(require('fs').readFileSync('search-state.json','utf8'));
  const prev = JSON.parse(require('fs').readFileSync('/tmp/search-state-prev.json','utf8'));
  const count = (s) => Object.values(s.projects || {}).reduce((n, srcs) =>
    n + Object.values(srcs).reduce((m, d) => m + (d.processedIds || []).length, 0), 0);
  console.log('prev processedIds:', count(prev), 'current processedIds:', count(cur));
"
```

If step 1 fails, or step 2 shows a large unexpected drop in total
`processedIds` (state reset rather than grown), treat this as a confirmed
corruption incident.

## Immediate mitigation

1. Identify the offending commit:
   ```bash
   git log --oneline -5 -- search-state.json
   ```
   Auto-published commits are authored by `github-actions[bot]` with the
   message `🌱 Update CNCF mission search state (<date>)`.
2. Revert it on `master` (requires an admin/maintainer with push rights,
   since this repository does not currently require PR review for direct
   pushes from CI — see `docs/BRANCH_PROTECTION.md`):
   ```bash
   git revert --no-edit <bad-commit-sha>
   git push origin master
   ```
3. Check the affected CNCF project repos referenced in that run's
   `generation-report.md` for duplicate issues created against
   already-tracked upstream items, and close/dedupe as needed — this
   state corruption's user-facing impact is external (upstream CNCF repo
   noise), not a KubeStellar Console outage.

## Root-cause follow-up

1. Re-run the detection commands above against the reverted state to
   confirm `processedIds` counts are restored.
2. Inspect the `collect` job logs for the run that produced the bad
   commit — the merge step logs `Error merging <file>: <message>` on a
   per-batch parse failure (non-fatal, but a signal); the retry-loop
   `git rebase` steps can also leave a partially-applied stash if a
   rebase conflict occurs mid-loop, which is the most likely source of a
   malformed working-tree file.
3. File a postmortem using
   [`runbooks/POSTMORTEM_TEMPLATE.md`](./POSTMORTEM_TEMPLATE.md).

## Prevention (tracked, not implemented by this runbook)

The `merge-search-state.mjs` job-summary warning (see above) covers
detection for the corrupt-base case. Two gaps remain, and both require
editing `.github/workflows/*.yml`, which needs `workflows` permission this
contribution's credentials do not have — tracked in the same follow-up as
[`runbooks/incident-response-index-publish-failure.md`](./incident-response-index-publish-failure.md#prevention-tracked-not-implemented-by-this-runbook)
and the open `[operations]` issue on scheduled-workflow failure alerts:

1. A `pull_request`-triggered JSON-validity check for `search-state.json`
   (matching the existing `fixes/**/*.json` / `runbooks/**/*.json` gates) —
   `search-state.json` is pushed directly to `master` with no PR gate at all.
2. An `if: failure()` alert on the `collect` job itself, for failure modes
   the self-heal doesn't cover (e.g. the job erroring out before it reaches
   the merge step).
