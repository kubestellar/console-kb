# Branch Protection Requirements

This document records the recommended branch protection settings for the `master` branch of `kubestellar/console-kb`.

## Recommended Settings

Enable these rules in **Settings → Branches → Branch protection rules** for `master`:

| Setting | Recommended Value |
|---------|-------------------|
| Require pull request reviews before merging | ✅ Enabled — at least 1 approving review |
| Dismiss stale reviews on new commits | ✅ Enabled |
| Require status checks to pass before merging | ✅ Enabled (CodeQL, actionlint, `Mission Safety Scan`, `Validate Mission Schema`, `KB Quality Enforcement`, `Mission Content Validation`) |
| Require conversation resolution before merging | ✅ Enabled |
| Restrict force pushes | ✅ Disabled for all non-admins |
| Require signed commits | ⚠️ Recommended but optional |
| Allow bypassing rules for admins | ❌ Not recommended |

## Why This Matters

Without branch protection:
- Maintainers with push access can force-push directly to `master`, rewriting history without audit trail
- PRs can be merged without passing required status checks
- PRs can be merged without required reviewer approvals

**This is not theoretical here**: the `CNCF Mission Generation` workflow's
`auto-merge` job (`.github/workflows/cncf-mission-gen.yml`) already merges
`cncf-mission-gen`-labeled PRs with `gh pr merge --admin`, which unconditionally
overrides branch protection (required status checks and required reviews alike)
regardless of whether `Mission Safety Scan` or `Validate Mission Schema` have run
or passed on that PR — the merge decision comes solely from a content-heuristic
score in `scripts/quality-scorer.mjs`. See `docs/slo.md` section 2 for details.
Enabling "Require status checks to pass before merging" does not close this gap
on its own, because `--admin` bypasses it.

Separately, for regular human-reviewed PRs (no `--admin` involved), the
required-status-checks list above must actually include `Mission Safety Scan`
and `Validate Mission Schema` — both trigger `on: pull_request` against
`fixes/**`/`runbooks/**` changes. Without them configured as required checks,
a reviewer can merge through the normal UI while one or both checks is still
running, cancelled, or failing, since GitHub only blocks merges on checks
explicitly marked required. This is the repo-configuration precondition
`docs/slo.md` section 2's "100% ... nothing merged by a human reviewer should
bypass both" SLO depends on.

The same requirement applies to two more `pull_request`-triggered checks that
also gate content safety on the same paths (`fixes/**/*.json`,
`runbooks/**/*.json`, plus YAML for the latter): `KB Quality Enforcement`
(`.github/workflows/kb-quality-enforcement.yml`, fails the job when
`scripts/test-kb-quality-ci.mjs` scores a changed mission below threshold —
note this only diffs `fixes/**/*.json` today, tracked separately in #3203)
and `Mission Content Validation` (`.github/workflows/mission-content-validation.yml`,
fails the job on skeleton steps, unreachable Helm repos, or missing inline
manifests). Neither was listed here previously; without them configured as
required, the same "merge while still running/cancelled/failing" gap applies
to them as it does to `Mission Safety Scan` and `Validate Mission Schema`
above. `Scripts Tests` (`.github/workflows/scripts-tests.yml`) is
intentionally *not* added to this list: its `npm test` step currently runs
with `continue-on-error: true`, so the job reports success even when tests
fail — marking it required would give a false sense of coverage gating until
that gap (tracked separately, see #3199) is closed.

See OpenSSF Scorecard findings #1 (BranchProtectionID) and #58 (CodeReviewID) for background.

## Code Review Policy

At minimum one human reviewer must approve each PR before it merges. This addresses:
- Prevents a single contributor from merging their own changes without oversight
- Catches supply-chain or credential-compromise attacks before they land on `master`
- Ensures automated content-generation PRs receive spot-checks

For bot-generated content committed directly to `master` by CI workflows, consider routing commits through a `generated/` branch merged to `master` via reviewed PRs.

## References

- [GitHub Docs: About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- OpenSSF Scorecard `Branch-Protection` check (alert #1)
- OpenSSF Scorecard `Code-Review` check (alert #58)
- Issues: [#2794](https://github.com/kubestellar/console-kb/issues/2794), [#2795](https://github.com/kubestellar/console-kb/issues/2795)
