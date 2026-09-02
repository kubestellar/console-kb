# Postmortem Template

Copy this template when writing up an incident (e.g. a bad
`fixes/index.json` publish — see
[`incident-response-index-publish-failure.md`](./incident-response-index-publish-failure.md)).

## Summary

_One or two sentences: what broke, for whom, for how long._

## Impact

- **User-facing effect:**
- **Duration:** (detection time → mitigation time)
- **Scope:** (all Console KB users / a subset / internal only)

## Timeline

| Time (UTC) | Event |
|------------|-------|
|            | Change/commit landed |
|            | Symptom first observed |
|            | Incident confirmed |
|            | Mitigation applied (e.g. revert pushed) |
|            | Recovery confirmed |

## Root cause

_What actually caused the bad state — be specific (e.g. "scorer bug
produced `NaN` for missions missing `metadata.difficulty`, which failed
JSON schema expectations on the Console frontend").
Avoid stopping at "a bad commit was pushed" — explain why the safeguards
that should have caught it (schema validation, safety scan, review) did
not apply to this change._

## What went well

## What went poorly

## Action items

| Action | Owner | Tracking issue |
|--------|-------|----------------|
|        |       |                |

## Lessons for prevention

_Reference any existing recommendation this incident reinforces, e.g.
`docs/BRANCH_PROTECTION.md`'s suggestion to route bot-generated commits
through a reviewed branch instead of pushing directly to `master`._
