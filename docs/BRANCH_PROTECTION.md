# Branch Protection Requirements

This document records the recommended branch protection settings for the `master` branch of `kubestellar/console-kb`.

## Recommended Settings

Enable these rules in **Settings → Branches → Branch protection rules** for `master`:

| Setting | Recommended Value |
|---------|-------------------|
| Require pull request reviews before merging | ✅ Enabled — at least 1 approving review |
| Dismiss stale reviews on new commits | ✅ Enabled |
| Require status checks to pass before merging | ✅ Enabled (CodeQL, actionlint, `Mission Safety Scan`, `Validate Mission Schema`, `KB Quality Enforcement`, `Mission Content Validation`, `Scripts Tests`) |
| Require conversation resolution before merging | ✅ Enabled |
| Restrict force pushes | ✅ Disabled for all non-admins |
| Require signed commits | ⚠️ Recommended but optional |
| Allow bypassing rules for admins | ❌ Not recommended |

## Why This Matters

Without branch protection:
- Maintainers with push access can force-push directly to `master`, rewriting history without audit trail
- PRs can be merged without passing required status checks
- PRs can be merged without required reviewer approvals

**This was not theoretical here, but is now fixed**: the `CNCF Mission
Generation` workflow's `auto-merge` job
(`.github/workflows/cncf-mission-gen.yml`) used to merge
`cncf-mission-gen`-labeled PRs with `gh pr merge --admin`, which
unconditionally overrides branch protection (required status checks and
required reviews alike) regardless of whether `Mission Safety Scan` or
`Validate Mission Schema` had run or passed on that PR — the merge
decision came solely from a content-heuristic score in
`scripts/quality-scorer.mjs`. PR
[#3418](https://github.com/kubestellar/console-kb/pull/3418) closed
[#3157](https://github.com/kubestellar/console-kb/issues/3157) by adding a
`requiredChecksPassed()` gate that queries both checks before allowing the
`--admin` merge. See `docs/slo.md` section 2 for details.

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
note this only diffs `fixes/**/*.json` today — originally tracked in
#3203, closed as a docs-only duplicate in #3268; both are now closed
without a code fix, see `docs/slo.md` section 2's "fourth known
exception" for the authoritative tracking)
and `Mission Content Validation` (`.github/workflows/mission-content-validation.yml`,
fails the job on skeleton steps, unreachable Helm repos, or missing inline
manifests). Neither was listed here previously; without them configured as
required, the same "merge while still running/cancelled/failing" gap applies
to them as it does to `Mission Safety Scan` and `Validate Mission Schema`
above.

`Scripts Tests` (`.github/workflows/scripts-tests.yml`) is now included in
the required-status-checks list above. It was previously excluded here
because its `npm test` step ran with `continue-on-error: true`, so the job
reported success even when tests failed. **That gap is now fixed**: PR
[#3417](https://github.com/kubestellar/console-kb/pull/3417) (merged
2026-09-16) closed [#3199](https://github.com/kubestellar/console-kb/issues/3199)
by dropping `continue-on-error` and switching `npm test` to
`vitest run --coverage`. Verified on current `master`: the "Run tests" step
in `.github/workflows/scripts-tests.yml` carries no `continue-on-error`, so a
real test failure now fails the check instead of merging behind a green
checkmark — see `docs/slo.md` section 5 for the authoritative tracking.

**Caveat, now resolved — marking `Validate Mission Schema` required now
does gate `runbooks/**` content**: the check used to never validate any
file under `runbooks/**`, on a PR or on its own scheduled sweep. PR
[#3410](https://github.com/kubestellar/console-kb/pull/3410) closed
[#3255](https://github.com/kubestellar/console-kb/issues/3255) by
extending the PR-mode `git diff` pathspec in
`.github/workflows/validate-schema.yml` to also match `runbooks/**`; the
`--all` scheduled-sweep side (`scripts/validate-schema.mjs`) was fixed
separately. A `runbooks/**`-only PR is now actually validated by this
required check.

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
