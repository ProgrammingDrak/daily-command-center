# Journal task: verification

Branch `feat/journal-handwriting` on base `bf1c8c6`. Committed locally on this
branch after Codex's read-only review; not pushed, no PR, not deployed. All data
synthetic. No production, no `localhost:8090`.

## Current state (final review, 2026-10-31)

Runtime: **Node 20.20.2**, `/opt/homebrew/opt/node@20/bin/node`, inside the
repo's `>=20 <23` engine range. Environment comes from `--env-file` files in
`~/Documents/Codex/2026-10-31/task/` (`T` below). Full logs use the
`final-review-` prefix there.

### Checks on the current code

| Check | Command (from the worktree) | Result | Log (in `T`) |
|---|---|---|---|
| Journal tests | `node20 --env-file=T/journal-qa.env --test --test-timeout=60000 journal-page-store.test.js journal-page-sync.test.js journal-task-privacy.test.js journal-postgres.test.js` | **52/52 pass**, 0 skipped (PostgreSQL ran on PGlite) | `final-review-journal-tests.log` |
| Lint | `node20 node_modules/eslint/bin/eslint.js .` | **0 errors, 71 warnings**; no journal source file has a warning (path matches are only the worktree name) | `final-review-lint.log` |
| Browser | server: `node20 --env-file=T/journal-review.env scripts/ui-review-server.mjs`; check: `node20 --env-file=T/journal-verify.env scripts/verify-journal-task.mjs http://127.0.0.1:8297` | **20/20 pass** on a fresh server (sections 1–14 plus new 15–19) | `final-review-browser-run3.log`, screenshots `journal-qa/` |
| Full suite (once, bounded) | `node20 --env-file=T/journal-qa.env --test --test-concurrency=4 --test-timeout=60000` | **3335 tests: 3320 pass, 0 fail, 2 cancelled, 13 skipped**, 22 s | `final-review-full-suite.log` |
| Mutations (by hand) | each guard broken with an edit, then the approved store-test command, then restored | **3/3 caught** (below) | `final-review-mutation-*.log`, `final-review-store-after-restore.log` |

The 2 cancellations are the pre-existing `guided.test.js` PGlite case. They
reproduce with the base commit's files (see "Earlier pass"), and they count as
not passed.

Browser runs that failed on the way, both kept as evidence:
- `final-review-browser.log`: section 18 failed. The diagnostic in
  `final-review-browser-run2.log` showed the pen was never down. Filling the
  notes had scrolled the paper, so the press landed off the paper. This was a
  test-setup defect: section 18 now scrolls the paper into view, picks a point
  inside both the paper and the viewport, and asserts that the pen is down
  before clicking.
- Sections 1–17 passed in that run, and sections 1–14 again in run 2.

### Defects fixed in this pass

1. **Silent eviction of unresolved drafts and recovery copies.**
   - `.slice(0, MAX_KEPT)` with a cap of 5 dropped the oldest draft. The reviewer
     reproduced this: d1 vanished after six stale saves. A cap of 20 only moves
     the loss to the 21st.
   - Fix: there is no cap now. A draft leaves the record only through an explicit
     choice (`resolveDraft`). A recovery copy leaves only through an explicit
     "Delete copy" (`dismissRecovery`).
   - If the device runs out of room, the write is rejected and the editor says
     so; copies already kept are untouched (regression below).
   - The recovery banner shows how many copies are kept.
   - Regressions:
     - 25 unresolved drafts, every one kept by id and content;
     - 25 recovery copies kept, and an explicit delete removes exactly one;
     - a quota failure while keeping a draft rejects visibly, keeping d1.
2. **Unknown stroke format reachable through non-mount display paths.**
   - `display()` is now the one place content reaches Ink, and it refuses
     `ink.v !== 1` before loading anything.
   - The background refresh (`replaceIfUntouched`) turns that refusal into the
     same read-only error state as opening such a page:
     - `ready=false`, so nothing is saved;
     - the paper and notes are locked;
     - toolbar and choices refuse.
   - The store refuses to adopt such content in `useServer` and `restoreRecovery`
     (`INK_VERSION`), with the record unchanged.
   - Regression: a v2 conflict copy and a v2 recovery copy are both refused, and
     content, conflict, version and copies stay as they were.

### Fixes from the second review, now executed

- **Stale-snapshot compare-and-set:**
  - Store tests 9–15 pass.
  - Browser section 15: two tabs on one IndexedDB.
  - Browser section 16: a newer server copy arriving during a pen-down stroke.
  - Browser section 17: pending typing during a refresh, with "Saving…" asserted.
- **Serialized conflict choices:**
  - Browser section 18: "Use the saved page" with typing pending and the pen
    down. Both are committed first and kept as recovery, and nothing is written
    over the choice afterwards.
  - Browser section 19: a choice while IndexedDB `put` fails is refused with
    nothing changed. Retry save writes, then the choice is offered again.

### Mutations run this pass (by hand, approved commands only)

| Mutation in `page-store.js` | Result |
|---|---|
| `keep()` capped with `.slice(0, 5)` | caught: test 17 "recovery copies are never evicted" |
| drafts capped with `.slice(0, 20)` | caught: test 16 "unresolved drafts are never evicted" |
| compare-and-set branch replaced by `if (false)` | caught: tests 9–14 and 16–18 (9 failing) |

- Each mutation was restored with an edit.
- `final-review-store-after-restore.log` shows the restored file passing.
- A search for the mutation text in the file finds nothing.

### Not run this pass, and why

- `final-review-mutations.cjs` (a runner for all 20 guards, written to `T`)
  needed approval under the narrowed command grant. That command was stopped,
  not worked around. The three hand mutations above cover the new guards. The
  earlier 14 server/client mutations (`journal-mutations.log`) ran against
  earlier code, and their guarded lines are unchanged.
- I wanted to preserve the earlier `journal-qa/` screenshots before re-running
  the browser check:
  - Copying them aside (`cp -R`) needed approval.
  - Because the copy and the browser run were sent in the same step, the browser
    run went ahead anyway and overwrote those screenshots and `results.json`
    with this pass's output.
  - The earlier text logs (`journal-browser-run.log`, `journal-browser-run2.log`,
    `journal-browser-pan-mutation.log`) are intact.
- A separate output folder via a new env file (`final-review-verify.env`) also
  needed approval, so the existing `journal-verify.env` was used.
- Unaffected earlier checks still apply, with these caveats:
  - The finger-pan browser mutation still applies: `wirePan` is unchanged.
  - The guided baseline comparison still applies: the files involved are unchanged.
  - The journal-API-down browser restart passed again in browser section 12.

### Duplicate journal ids: unverified edge, stated precisely

- **Copy paths were checked and are covered.** Repeat occurrences
  (`responsibility-store.js`) build properties explicitly and never copy
  `journalId`. Shell templates (`state.js`) copy type only. No task-duplicate UI
  exists. So the server mints a fresh id per copy, and the sequential copy test
  covers that.
- **Not exercised:** two different blocks created concurrently with the same
  client-supplied `journalId`. `createBlock`'s uniqueness check runs before the
  insert, without a lock, so it does not prevent this.
- **What this case would do (unverified):**
  - The server's UNIQUE `journal_id` on `task_journal_pages` lets only one task
    hold a page row. The other task's saves would get 409.
  - On the client, the on-device record is keyed by `journalId`, so both tasks
    would open the same local page.
  - `serverTaskId` sends sync to the first block in the block store carrying that
    `journalId`. Which task receives the page is therefore not defined.
- **So "cannot mix" is not claimed for this case.** It needs a client test with
  deliberately identical concurrent ids, and possibly a server index on
  `blocks((properties->>'journalId'))`. That is a production schema decision and
  is not made here.

## Earlier pass (code before the second and third reviews)

The results below ran on earlier code. They are kept as history and do not
prove the fixes above.

Runtime was the same Node 20.20.2. An even earlier Node 24 full-suite run (out of
the engine range) hung in `guided.test.js` and was stopped. That run and an
interrupted second run did **not** pass.

PostgreSQL tests use PGlite 0.5.8 from an existing local install
(`Repos/linelearner/node_modules/@electric-sql/pglite`), read-only.

| Check | Result | Log |
|---|---|---|
| Journal tests | 42 pass, 0 fail | console |
| Full suite | 3325 tests: 3310 pass, 0 fail, 2 cancelled, 13 skipped | `journal-full-suite-node20.log` |
| Lint | 0 errors, 71 warnings | `claude-journal-lint-node20.log` |
| Mutations (runner) | 14/14 caught, files hash-verified restored | `journal-mutations.log` |
| Browser | 15/15, twice, fresh server each time | `journal-browser-run.log`, `journal-browser-run2.log` |
| Browser mutation | finger pan disabled → caught ("scrolled the dialog by 0px") | `journal-browser-pan-mutation.log` |

### The 2 cancelled tests

Both are `guided.test.js` "guided real PostgreSQL lifecycle…" (the parent and its
"database API roles…" subtest): "Promise resolution is still pending but the
event loop has already resolved".

They are **pre-existing**. With `db.js`, `pg-schema.js` and `task-types.js`
swapped to their `bf1c8c6` versions, the same cancellation occurs
(`guided-baseline-node20.log`). All other guided inputs are unchanged from base.
The files were then restored and verified by diff.

A standalone PGlite repro of the role/RLS statements completes normally
(`pglite-role-repro.log`). So the stall is in the shared single-lock test-fixture
path, not in PGlite's RLS.

### Existing fixtures updated

- `commitment-privacy`, `public-share-status`, `permanent-guest` and
  `feed-completion-hook` extract route functions into a `vm` context. They now
  supply `TaskTypes`, which the shared private-type predicate reads.
- `launcher-urgent-menu` expects the Journal destination (11 items).
- `task-model-fromblock` includes `journalId` in its key-set guard.

## Coverage

**Node (unit tests, plus real PostgreSQL through real routes)**
- **Namespace:**
  - the database name decodes back to the exact account, including the reviewed
    collision pair;
  - another owner's records are never read, listed or overwritten.
- **Revision contract:**
  - compare-and-set saves, with stale snapshots kept as drafts;
  - an equal-revision seed is a no-op;
  - acks never change the content version;
  - mine/theirs choices and restores are compare-and-set;
  - closed-editor retries become drafts;
  - drafts and recovery copies are never evicted;
  - quota failures are visible;
  - unknown formats are never adopted.
- **Sync:**
  - backoff with idempotent retries;
  - 401 pauses, offline waits, 404 retries;
  - conflicts, including a failed comparison fetch;
  - 400/413 reported, ACCOUNT_CHANGED handled;
  - waits while the pen is down;
  - delayed A→B responses;
  - plain-function timers;
  - local → server task id resolution.
- **Server:**
  - `journalId` stamping and pinning;
  - privacy on create, update and move;
  - revisions and replay;
  - undo guards;
  - v2 rejected with 400, oversize with 413;
  - cross-account 404, viewer 403, bearer 401;
  - `private, no-store`;
  - retention.
- **Privacy:**
  - share and feed paths hide journal tasks;
  - account binding covers `/api/journal`;
  - no use of existing journal or notebook keys.

**Browser** (Chrome at 1280×900, plus emulated touch at 390×844 and 320×640;
real block, sync and journal routes and account binding on in-memory PGlite)
1. Quick add creates a journal; the itinerary reopens it.
2. Reload keeps the page.
3. A 500 stays dirty, then Retry syncs.
4. A 401 shows "sign in", then Retry syncs.
5. A conflict whose comparison fetch fails stays retryable.
6. A local save failure blocks close.
7. Replacement by another dialog keeps strokes in memory.
8. Offline while open, then reconnect drains.
9. Rapid A→B switching with delayed saves.
10. Escape or `pagehide` mid-stroke commits the stroke.
11. Account separation and switching.
12. Browser restart with the journal API unreachable.
13. Touch: pen pressure, palm, pan, two fingers, overflow.
14. An unknown format opens read-only.
15. Two tabs on one IndexedDB.
16. A remote refresh while the pen is down.
17. A remote refresh with typing pending, and "Saving…".
18. A conflict choice with typing pending and the pen down.
19. A conflict choice while the local write fails.

## Limitations (stated plainly)

- **No offline app restart was exercised.** DCC has no service worker.
  Section 12 restarted the browser with only the journal API unreachable.
- `pagehide` was dispatched synthetically. A real tab kill can end the IndexedDB
  write that `pagehide` starts. Strokes committed earlier are already durable.
- **Physical stylus: unrun.** Pen and touch behavior used Chrome DevTools
  Protocol emulation only.
- The review server stands in for production login with a cookie naming a
  synthetic user. Everything after `req.session` is production code.
- **On-device growth is unbounded.** Drafts and recovery copies have no cap by
  design. A device that runs out of room rejects the next write visibly.
- Shared-device residue: see the plan, open decision 5.
- Undo of the server's `previous` copy has an API but no UI.
- Concurrent duplicate journal ids: see above.

## Restrictions encountered

- (Historical) Earlier passes: `git add`, `git worktree add`, `git archive
  --output`, `tar` and env-prefixed commands needed approval. Node's `--env-file`
  was used, and no commit was made in those passes.
- (Historical) The final-review pass needed approval for:
  - `node20 --version`;
  - the mutation-runner script;
  - a new env file for the browser check;
  - `cp -R`.

  None was worked around. The one side effect is described under "Not run this
  pass".
- (Historical) Staging and committing waited for Codex's read-only review. After
  that review the user authorized a local commit, which was then made. Nothing
  was pushed.
