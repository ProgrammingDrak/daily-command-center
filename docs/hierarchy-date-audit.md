# Hierarchy and undated-date reconciliation

Branch: `fix/hierarchy-date-audit`. Base: upstream `b126acc` (PR402).

## Upstream audit and provenance

- PR401 is merged at `5709fb4`; it synchronizes date-picker presets and task details. Its description explicitly excludes the undated Task Library placement defect.
- PR403 remains open on `feature/dcc-accountability-completion`. No PR403 commits or social-release changes were adopted.
- The existing `fix/hierarchy-consistency` worktree contained the unfinished hierarchy changes on `5709fb4`. Those changes were copied into this isolated branch; the original worktree and shared main checkout were preserved.
- Date-only placement commit `962615b` was not on upstream main. It was cherry-picked as `129714e`, including its focused tests and fixture browser verifier.
- Current-main controls reproduce truncated deep rendering (21 of 80 rows), wrap-to-subtask drop failure, template truncation (21 of 2,000 nodes), and the undated placement error `Block has no source date to move from`.

## Verified changes

- Shared iterative graph traversal replaces arbitrary depth limits and recursive rendering/progress/template walks. Mixed subtask/ride-along trees remain complete; cycle guards terminate corrupt graphs without silently dropping legitimate descendants.
- Database hierarchy changes synchronize property aliases and `parent_id`, reject self/cyclic/conflicting/wrong-day/foreign parents, and serialize concurrent graph changes within a workspace. Server subtree collection follows the canonical property edge, with row-parent fallback.
- Native wrap/subtask reparenting, promotion and time reflow carry descendants and preserve notes, IDs, untimed state and zero-duration subtask semantics. Carryover keeps the complete server-bounded pool rather than cutting it again at 100 rows.
- An undated Task Library selection assigns the requested day atomically to the original tree, without inventing a source date or requiring a time. Stale repeated assignments are refused.
- A newly reproduced overlapping Undo/delete race is fixed: deleting a child while an older parent Undo is restoring rows now waits for that inverse before deleting the same durable rows.
- Real Chromium touch testing reproduced native panning cancelling a lifted drag. A non-passive touchmove handler prevents panning only after lift; ordinary pre-lift swipes still scroll.
- Desktop hierarchy indentation is bounded; phone indentation is capped further so deep titles and controls remain readable. Actual hierarchy depth is retained in the model.

## Validation

- Node 20 full suite: 2,923 passed, 8 skipped, 0 failures (2,931 tests). Repository lint: 0 errors, 70 existing warnings. Final scoped lint: clean.
- Focused hierarchy/date/drag/delete suite: 69 passed. Deep regressions cover 20,000-node rendering, 12,000-node completion/rollback, 2,000-node templates and 1,500-node delete/Undo.
- Disposable PostgreSQL 16 on `/tmp/dcc-hierarchy-date-audit/socket`, port 55447: 13 passes, 0 skips/failures. Checks cover 600-level SQL traversal/completion, row/local-ID aliases, cycles, concurrent reparenting, date placement and stale retry, repeated deletion/restoration with original IDs and notes.
- Database-free browser fixture on 127.0.0.1:8147: trusted native HTML5 dragstart/drop; 80 descendant levels; repeated promote/nest; real touch long-press/sideways nesting; reload persistence; ordinary swipe scrolling; readable geometry at 320, 390 and 768 px.
- Date browser fixture: Today, Tomorrow and custom dates at 1280 and 375 px; keyboard Tomorrow; Los Angeles local-day/UTC boundary; same IDs/subtree/notes, no time or source-date invention; reload persistence.
- Atomic Undo failure injection: real PostgreSQL middle-row rollback, later-row unique conflict, fresh-connection visibility, lost acknowledgement retry, stale deletion replay and overlapping generations. Client WAL retains complete membership, waits for forward deletion and hide writes, rejects incomplete acknowledgements, and reloads account/date/generation-scoped Retry state. Production route checks cover Triage/meeting provenance and restored overlays/broadcasts.
- Desktop and 390 px browser Undo: 82 original mixed descendants, 409 rejection followed by reload/Retry, 503 followed by reload/WAL replay through the real event listener, repeat operations and another reload. No false restoration success.
- FULL pre-review completed all five lanes; confirmed date/Retry and response-boundary findings fixed, with follow-up correctness/performance/test review clear. Additive partial `idx_operations_delete_receipt` supports guarded deletion replay; schema bootstrap applies it. Reflows reuse hierarchy indexes.
- Screenshots are under `test-results/hierarchy/` and `test-results/undated-scheduling/`. Verification logs are retained in `/Users/drakeshadwell/Documents/Codex/2026-10-08/task-17/`.

## Reproduce browser QA

```sh
PORT=8147 DCC_REVIEW_HIERARCHY=1 node scripts/ui-review-server.mjs
node scripts/verify-hierarchy-browser.mjs http://127.0.0.1:8147
node scripts/verify-undated-scheduling.mjs http://127.0.0.1:8147
node scripts/verify-subtree-undo.mjs http://127.0.0.1:8147
```

The fixture imports no production routes or database. The hierarchy verifier resets only its synthetic fixture store. Browser launch defaults to the installed Mac Chrome; `CHROME_PATH` overrides it.

## Remaining limitations and authority

- Shipping is authorized through `/ship-it`; review registration `eba31d4d-c137-4d6e-b92b-497fd0a293b5` owns this branch. Queue acquisition, exact-candidate checks and production SHA verification remain required.
- Atomic restore replaces the previously disclosed sequential Undo limitation. A missing row, newer deletion, uniqueness conflict or middle-row SQL failure rolls back all restored rows and the dated hide overlay. Pending/rejected attempts retain full membership and a persistent Retry across reload; success requires all original rows to be acknowledged.
- Physical iOS/Safari hardware was not tested; mobile verification uses real Chromium touch input at phone/tablet sizes.
- Large SQL hierarchy traversal has nontrivial cost (the 600-node test takes several seconds); this is correctness verification, not a performance claim.
