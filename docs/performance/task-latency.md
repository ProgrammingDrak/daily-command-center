# Task startup and interaction latency

2026-10-20 investigation, based on `71091e9c91100e99ba7b16bd2071de002fd7c37f`.

## Measured evidence

These are synthetic local measurements on this Mac, Node 20 and headless Google Chrome at a 390 × 844 viewport. The browser fixture contains seven fictional scheduled tasks. Requests were delayed by 100 ms, supporting startup requests by 1,500 ms, and mutation responses by 1,000 ms. This isolates waiting behavior; it does **not** reproduce the user's phone, network, full task history, CPU, Safari, or production query cost. Single-run numbers are indicative, not percentiles.

| Measurement | Baseline | Updated |
|---|---:|---:|
| Tasks ready event, legacy startup | 1,795 ms | 275 ms |
| Two animation frames after tasks ready | 1,817 ms | 295 ms |
| Five full renders, seven-task fixture | 11.1 ms | 8.3 ms |
| Completion visual feedback | 20.3 ms | 24.2 ms |
| Completion server acknowledgement | 1,018 ms | 1,017 ms |
| Pinned cross-date move visual feedback | after ack (~1,014 ms) | 24.5 ms |
| Pinned cross-date move server acknowledgement | 1,014 ms | 1,009 ms |
| Four independent property writes, 100 ms per mock write | 409 ms | 102 ms |
| Destination state + block reads, 100 ms each | 204 ms | 102 ms |

The completion animation was already optimistic. This patch improves its durability and race handling, not its measured paint time. The faster movement feedback is a **locally queued preview**, not instantaneous server persistence. Automatic placement still needs destination data before queuing; its two reads now run concurrently. The browser profile uses pinned placement to isolate mutation acknowledgement latency.

A permitted unauthenticated `GET /api/health` returned HTTP 200 in 753 ms (753 ms TTFB), database `ok`, uptime ~6.65 days, and revision `71091e9`. This one warm health sample neither measures authenticated boot/mutations nor diagnoses the reported 15–20 second phone startup. No production task writes, authenticated boot side effects, schema operations, or deployments were used for testing.

## Sources and changes

- `public/js/boot.js` waited for all nine API requests before hydrating/rendering any task. Slow archives, tomorrow, prep or brain responses controlled useful startup. Today now loads first; supporting data loads afterward and never resets the active task arrays or navigated date. The retired `/api/brain/recent` fetch is removed. Legacy day/global block reads run together; delta bootstrap still supplies both partitions. Failed or unavailable core reads keep an explicit stale/unavailable banner. This is not a new persistent task cache.
- `public/js/day-context.js` fetched destination state and blocks sequentially. They are independent and now run together, with existing slot computation and memoization preserved.
- `public/js/state.js` used a single global promise chain for every row-property writer. It now serializes per row, retaining read/merge/write ordering for the same row and allowing unrelated tasks to progress concurrently.
- Cross-date movement still uses the canonical server subtree transaction. Once its WAL write succeeds, the current source-day subtree disappears with a queued message. Rejection restores those exact row objects without reverting unrelated edits or adding old-day rows after navigation. Successful acknowledgement retains the existing pin cleanup and final notification. Review-guarded moves do not enter this optimistic/WAL path.
- `public/js/block-store.js` now records completion and movement intent **before** waiting behind another same-row request. Newer movement intent supersedes an older buffered destination. Movement replay shares its live serialization chain. Completion replay may rebase a conflict only when the server names a recorded predecessor from the same click sequence; a foreign completion still dead-letters. Mutation IDs and original completion times survive retries.
- Older update acknowledgements cannot overwrite newer queued properties. Delta/bootstrap responses check the mutation generation before replacing caches or advancing the cursor. Pending work cannot briefly show “All changes saved.”
- `public/js/schedule.js` tags completion/reopen UI intents so a late success or rejection cannot repaint a newer root-task choice. Failed older subtree snapshots transfer to the newest pending verdict, and rollback preserves independently newer child completions. Server completion contracts remain in place.

No backend, auth policy, schema, service-worker cache, account ownership, migration, or Guided Routines files changed. `index.html` is untouched; Guided Routines PR #414 remains separate.

## Reproduction

Use the existing synthetic review server, never the normal server connected to user data:

```sh
PORT=8314 DCC_REVIEW_TASK_DETAILS=1 node scripts/ui-review-server.mjs
node scripts/profile-task-latency.mjs http://127.0.0.1:8314
node scripts/profile-task-queues.js
```

The browser profiler refuses non-loopback URLs and requires `health.reviewOnly === true`. It intercepts mutation responses using fictional browser-local records, compares baseline files from Git with current files, checks fresh-read recovery after reload, and rejects page exceptions. Set `DCC_CHROMIUM_PATH` for another Chromium binary and `DCC_PROFILE_BASE` for a different comparison revision. The script does not simulate real database execution, packet loss, or mobile CPU throttling.

## Verification and remaining boundaries

- Full repository suite: 3,078 passed, 0 failed, 10 skipped on the final code (3,088 total).
- Full lint: 0 errors, 70 existing warnings; new profiling/test files lint cleanly. Browser files also pass Node syntax checks. No separate build/typecheck command exists for this plain-JavaScript app.
- New checks cover core-first and legacy-parallel boot, delayed secondary responses after editing/navigation, independent versus same-row writes, rapid completion/reopen WAL durability, ack loss/reload, known-predecessor versus foreign conflict, local quota failure, old delta responses, queued movement supersession, move rollback after unrelated edits/navigation, and late completion rejection.
- Existing tests continue covering offline replay, auth refusal, retries, same-row and cross-tab serialization, atomic subtree movement/deletion/restore, completion cascades, and canonical route/database contracts.
- Ten optional tests were not run: eight real PostgreSQL/PGlite-dependent integration cases and two external Mycelium-parser cases. No test database or parser was configured. The first sandbox-only full run encountered `listen EPERM` when local HTTP tests bound ports and was stopped; an approved unrestricted local run passed.
- Backend work remains on the acknowledgement path: bootstrap's scheduled-day preparation, repeatable-read snapshot and day projection; completion's database transaction, timing normalization, linked triage, cascade, feed post and Slack synchronization. These paths were inspected but not shortened without authenticated traces or a durable replacement for side effects. Large-history payload/query cost, production pool contention, physical-phone rendering, and cold starts remain unmeasured.
- Existing reschedule retry expiry (15 minutes), account-bound WAL/dead-letter policy, browser storage limits, and server CAS remain. A pending move can reappear as its authoritative source row during reload until replay settles; the queued sync status remains the durability signal. No cache reset or promise of a new offline shell is included.
