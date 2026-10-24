# DCC for glasses — local prototype

## Scope and base

Entry: `/glasses.html`. Today’s itinerary comes first, with current/next items, a paginated full itinerary, an open to-do list, task detail, and explicit completion. `/glasses-routine.html` is a secondary focused view linked from workout task detail.

Isolated branch: `feature/meta-itinerary`, based on current fetched `origin/main` **8391073** (2026-10-24). Worktree: `.worktrees/meta-guided-routines` (folder retains the original scope name). This includes the existing guided-routine implementation from 76f97ff. It does **not** depend on or modify PR421/a40a9e1 or PR422/68a5d2b. Their security hold remains separate. Nothing was pushed, published, merged, deployed, or migrated against production. No Meta account, agreements, credentials, or permissions were changed.

## Verified Meta requirements

Official source checked 2026-10-24: https://developers.meta.com/wearables/web-apps/

The public page confirms Meta Ray-Ban Display web apps, a **600×600 additive display**, standard **arrow-key and Enter events**, ordinary fetch/WebSocket connectivity, and service-worker/Cache API capability. Dark backgrounds fall away; bright high-contrast content is recommended. Neural Band is optional. Pinch-and-drag is an opt-in capability; this implementation does not use it.

The linked detailed documentation https://wearables.developer.meta.com/docs/develop/webapps/ returned **Not Logged In**. No login or account creation was attempted. Device-specific storage quotas, user-agent behavior, actual gesture timing, authentication redirects, and detailed browser API restrictions remain unverified. This prototype uses ordinary DOM/CSS, keyboard events, fetch, same-origin cookie auth, sessionStorage, Intl, and AbortController; it requests no sensors, microphone, camera, notifications, or experimental Meta APIs.

## Reuse and semantics

- Existing `/public/js/app-config.js` supplies DCC’s timezone. `/api/sync/bootstrap` supplies the server-selected day, workspace-scoped saved blocks and globals. `/api/tasks/open` supplies earlier tasks and their completion overlays.
- `TaskModel.fromBlock`, `fromBacklogBlock`, `backlogParentKeys`, `selectUnscheduled`, `selectDay`, `selectTree`, and existing waiting filters own task projection, membership and hierarchy. Persisted `sort_order`, creation time and ID supply the same tie breaks as DCC’s canonical row order.
- Completed state is the union of canonical row status and legacy day-root overlays. Detail uses the same overlay as the list. Current/next uses saved task times and DCC’s timezone, refreshing every 30 seconds without resetting focus or scroll. It does not reschedule tasks.
- Dated tasks complete through **POST `/api/tasks/:taskRef/completion`**, carrying the existing completion revision and a stable mutation ID. The UI performs no full-document task write. Existing linked-step/dependency side effects remain server-owned.
- Dateless/Whenever tasks are visible with correct hierarchy but are **view-only**. DCC normally moves their tree onto today before completion. This initial surface explicitly directs the user to schedule them in full DCC instead of changing that meaning.
- Secondary guidance uses `WorkoutModel.guide` / `PromptedSequence`, the frozen plan, and GET/PUT `/api/activity/tasks/:id` with `expectedRevision` and `mutationId`. Guidance navigation never fabricates reps, holds, actual dates or timing events. Guidance finish and itinerary completion remain separate actions.

## Input, recovery and privacy

Arrow keys move focus through the card, items and actions. Up/down scroll long card content while the card has focus. Enter activates normal buttons/links; held-key repeats are ignored. Completion first opens a confirmation screen focused on **Cancel**. Busy guards reject concurrent actions; successful navigation restores card focus, and returning from detail restores the task’s list focus when still present.

Only confirmed server state is shown as complete. A per-account, **per-tab sessionStorage retry receipt** is stored before a write. If storage fails, no write is sent. Lost responses, reload and same-tab login return reuse the original mutation ID. Retry is explicit; reconnection never silently completes a task. A fresh identity check precedes every write/retry; account changes clear the visible data and block the old receipt. A 409 requires explicit refresh/review. A permanent 403/404 offers **Leave unresolved**, retaining a diagnostic receipt for that tab session while releasing forced navigation; it never reports success.

There is no separate task database. The browser keeps only the current fetched view in memory plus small completion receipts (and the existing activity-record payload for an unconfirmed guidance save). Server-saved routine position survives reload. Selected task, list page and view are in the URL.

Offline within an open page shows the last confirmed view and disables completion. **Offline cold launch/reload is not implemented**: no service worker or personalized API cache is added. Receipts survive reload but expire when the browser tab session is discarded; server state remains authoritative on the next visit. Hardware sessionStorage persistence still needs verification.

## Local preview and reproducible checks

No normal `npm start`, `.env`, production DB, or live task API was used. The fixture server binds **127.0.0.1:8396**, seeds fictional tasks into PGlite memory, and mounts real DCC activity, block, sync and completion routes. It has a same-origin CSP and is never imported by `server.js`.

```sh
# Use an already installed PGlite module; no application credentials required.
DCC_GLASSES_REVIEW=1 DCC_PGLITE_MODULE=/tmp/dcc-glasses-deps/node_modules/@electric-sql/pglite PORT=8396 node scripts/glasses-review-server.mjs
node --test glasses.test.js
DCC_PGLITE_MODULE=/tmp/dcc-glasses-deps/node_modules/@electric-sql/pglite node --test --test-concurrency=2 movement-card-postgres.test.js activity-postgres.test.js
DCC_QA_OUTPUT=/absolute/output/path node scripts/verify-glasses.mjs
npm run lint
node --test --test-concurrency=4
```

Results on the final implementation:

- Focused regression tests: **15/15 passed** (projection/order/hierarchy, timezone, legacy status, storage failure, offline refusal, serial completion, auth/account isolation, revision conflict, lost response/reload/retry, historical receipt after reopen, and canonical guidance).
- Reused PostgreSQL activity/movement API tests: **10/10 passed**, disposable PGlite only.
- Full repository suite: **3,110 passed, 11 skipped, 0 failed** (3,121 total). The first run had one intermittent `triage-task-lifecycle.test.js` undelete 404; the isolated test passed both here and on clean base 8391073, and the final full run passed. No unrelated test was changed.
- ESLint: **0 errors**, 69 existing warnings. Browser scripts additionally load and execute in Chromium QA. This plain-JavaScript repo has no separate build or typecheck script.
- Browser QA: **600×600**, **375×812**, **1440×1000**; current/next, arrow/Enter focus, safe confirmation, offline state, a real local completion with a lost acknowledgement then reload/retry, auth interruption, alias-less backlog read-only behavior, two-tab receipt isolation, server conflict, long-content scrolling, visible controls and secondary routine pause/reload/resume. No page errors.
- Independent reviewer inspected code and reproduced defects; fixes added for backlog membership/hierarchy, consistent completion overlays, current/next refresh, cross-tab recovery, unreachable task recovery, and Whenever completion semantics.

## Exact limitations before release

This is a tested **local prototype**, not a Meta device-certified release. Real glasses, Neural Band pinch mapping, additive-optics legibility, the official simulator extension, and on-device authentication have not been tested. QA used Chromium viewport/keyboard simulation, not those systems.

The itinerary presents saved canonical task rows and times. Legacy day-state timeline items without a canonical row are counted with a visible full-DCC notice; they are not resurrected as actionable tasks, because the bootstrap does not carry their tombstone identities. Earlier-task retrieval is limited to 2,000 records and shows truncation. The compact surface does not create, schedule, reorder, edit or reopen tasks, and does not run a parallel assistant. Existing app-wide security/release holds remain release prerequisites; this feature does not waive them.
