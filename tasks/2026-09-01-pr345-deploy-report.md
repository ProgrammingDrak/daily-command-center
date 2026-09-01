# Deploy report: PR #345

- **PR**: [#345 Give a touch drag a way to reorder, not just nest](https://github.com/ProgrammingDrak/daily-command-center/pull/345)
- **Repo**: ProgrammingDrak/daily-command-center
- **Branch**: `fix/touch-drag-reorder-mode` (deleted on merge)
- **Merge SHA**: `03aed5b4d00c64f9b6af9f1f415c9743ba507209` (squash)
- **Merged**: 2026-09-01T02:55:23Z
- **Merge path**: direct squash. The first `gh pr merge --auto` call errored on
  argument parsing (no merge method), attempted nothing, and authoritative state
  confirmed OPEN with no auto-merge queued before the retry.

## Verdict

**DEPLOYED AND VERIFIED**

## Timings

- Merge to deploy workflow complete: under 1 minute
- Deploy run: [33464335093](https://github.com/ProgrammingDrak/daily-command-center/actions/runs/33464335093), `completed/success`
- Platform: Railway auto-deploy on push to main

## Checks

| Job | Result |
|---|---|
| test (lint + npm test) | pass, 43s |
| smoke (playwright) | pass, 1m3s |
| guardrails | skipped (PR event, then clean on push: no db.js, pg-schema.js, or migrations/ paths touched) |
| canary | pass, prod served the merge SHA |

## Canary evidence

- `GET /api/health` returned 200 with `"revision":"03aed5b..."`, matching the merge SHA
- `GET /` returned 200 and redirected to `/login` as expected for an auth-gated app
- Login page rendered real content (title "Daily Command Center — Sign In", form present)
- No console errors (`Uncaught`, `TypeError`, `ReferenceError`, `Failed to load`)
- Changed assets confirmed live on prod: `_nestZone` present in `/public/js/drag.js`,
  `draggingUntimed` present, `NEST_PX = 48` and `SUB_PX = 112` present in
  `/public/js/touch-drag.js`

No prod login was performed, so the auth-gated `index.html` hint copy was not
verified in production. The functional change is entirely in the two JS assets
above, both confirmed.

## Pre-merge verification

- Suite: 2381 tests, 2378 pass, 0 fail
- Deep QA with real pointer events at 390x844 against the reviewed HEAD:
  a drop at the row's dead centre reordered with `wrapId` null, +60px set `wrapId`,
  +140px set `subtaskOf`, and sliding back left returned the reorder bar
- Five-lane local review with a verification pass (no review bot on this remote):
  security and performance clean, 3 findings confirmed and fixed, 3 dismissed
- Every new test guard mutation-checked: each fails under its own mutation and nothing else

## Closeout

Deploy-only fallback. No brain project slug resolves for this change, and the
repo's `## Ship It` contract sets reviewers `none` and feature reports `none`,
so no reviewer request, no feature report, and no Slack draft were produced.
