# Task workspace navigation

Base: `2d3b30f` (includes PR #448 and the compact header from #449).

## Goal

- Remove the Daily Command Center branding from view. Keep a visually hidden `h1`.
- One compact top cluster: clock, settings cog, sync dot.
- Top pages: **Tasks**, **Budget**, **Workouts & meals**.
- Tasks holds the view switch (Working Queue, List, Calendar), the Actual
  toggle, the date row with the Triage/Waiting/Unscheduled/Whenever pills, and
  Day Progress, in that order.
- Meeting Reviews, Pet Home, Social and Mycelium leave every ordinary route.
  Their records, APIs, pet courier and reminders stay.
- Out of scope: Add Tasks picker filtering.

## State contract

One controller, `DCC.nav` in `public/js/tabs.js`, backed by the pure
`public/js/nav-state.js`. No parallel task, timer or queue state.

```
NavState = { page: "tasks"|"budget"|"activity",
             view: "queue"|"list"|"calendar",
             actual: boolean }
panel:   tasks+queue -> #tab-working-queue
         tasks+list|calendar -> #tab-schedule
         budget -> #tab-budget, activity -> #tab-activity
schedView (state.js global) = view for list/calendar; never "actual" again.
```

### URL (explicit state wins)

- `?tab=tasks&view=queue|list|calendar[&actual=1|0]`, `?tab=budget`, `?tab=activity`.
- Every other query parameter (`device`, `task`, `tl`, `date`, filters) and the
  hash are preserved untouched.
- Page and view changes `pushState`. The Actual toggle `replaceState`s.
- `actual=1|0` is written only for an explicit choice (the toggle, or a URL
  that carried it), on any Tasks view, and is kept through canonicalization,
  reload and Back. A preference-derived or past-day value is never written.
- Each history entry stores `dccNav` (page, view, Actual) and
  `dccActualExplicit`. Budget and Workouts & meals URLs name only the page;
  their entry's `dccNav` keeps the Tasks view and Actual, so Back, Forward,
  reload and returning to Tasks restore them. An explicit Tasks URL wins over
  anything remembered.
- Back/forward re-parse the URL first; an entry without saved nav falls back
  to the in-memory state, because other modules call `replaceState(null, ...)`.

### Saved preferences

- `dcc-itinerary-view`: base view, `list` or `calendar` (existing key).
- `dcc-itinerary-actual`: `"1"` or `"0"` (new key).
- A stored legacy `"actual"` becomes base `list` plus `dcc-itinerary-actual=1`.
  The rewrite happens once and never changes a chosen base view.
- Archive (past) days default Actual on for that visit only, unless the URL or
  the user already chose Actual on or off. Never persisted, never changes the
  base view.

### Legacy links

| Incoming | Lands on |
|---|---|
| `?tab=working-queue` | Tasks, Working Queue |
| `?tab=schedule` | Tasks, saved base view |
| `?tab=schedule&view=actual` or `?view=actual` | Tasks, saved base view, Actual on |
| `?tab=meeting-reviews`, `pet-home`, `social`, `vault` | Tasks, Working Queue, retirement notice |
| unknown | Tasks, Working Queue |
| no `tab` | `history.state.dccNav`, then legacy `dccTab`, then Tasks, Working Queue |

Remapped URLs are rewritten canonically with `replaceState`. No data mutation.

### Compatibility adapter

`DCC.tabs.select(name)` maps the old panel names (`working-queue`, `schedule`,
`budget`, `activity`) onto `DCC.nav.go`. Retired names show the notice and
stay on Tasks. Callers that clicked `.tab[data-tab=...]` now call the adapter.

## Actual

Actual is a toggle on List and Calendar. It never replaces either view.

Shared pure projection: `public/js/actual-projection.js`. It reuses
`entryMatchesEvent` from `day-review.js` and classifies, per task:

- `none`: no recorded actual.
- `unknown`: `actualTimeUnknown`, no entries.
- `reallocated`: `actualMinutesFrom === "reallocated"`, no entries.
- `positioned`: `time_entry` segments with a readable clock start, not
  estimated or inferred. Only these are plotted.
- `unpositioned`: known minutes without a trustworthy position (no readable
  start, estimated/inferred, other-day start, legacy `_sessions`). Shown as
  minutes, never placed on a clock.
- Day extras: unmatched entries (unplanned activity) and `allocationKind:
  "unknown"` time (not focused effort, excluded from known minutes).

Each entry is credited to at most one task. Queue background elapsed time is
never read.

- Identity first: an entry with `blockId` or `calendarEventId` matches only
  the task with that identity (row id or local id), title ignored. A stale
  identity stays unmatched (unplanned activity). Only entries with no identity
  use Day Review's title fallback.
- One time zone: every clock reading uses `window.DCC_APP_TIME_ZONE`, else
  `America/New_York` (`ActualProjection.appTimeZone()`), for List and Calendar
  alike, never the device zone. An instant whose app-zone date differs from
  the entry's date is shown as minutes, not placed.

- **List + Actual**: a summary strip (known minutes, unplaced minutes, unknown
  time, unplanned activity, "Did these happen?", "Day review") and a per-row
  actual chip with a "+ time" editor entry point (`editTimeEntries`).
- **Calendar + Actual**: positioned segments as a separate bar inside each day
  column, unplaced and unknown minutes in the day header, the same
  move/split dialog for segments, and an Actual section in the inspector.
  Week controls, source filters and the inspector are unchanged. Toggling
  repaints the layer without re-reading the week.
- **Day review** (`buildDayReview`) stays reachable from the strip as an
  explicit panel.

## Drafts and conflicts

- Page switches only toggle panel visibility and run the panel's existing
  activation renderer. List and Calendar rebuild only when their view or the
  Actual toggle changes.
- That rebuild (`_buildUnlessDraft` in `schedule-tab.js`) is deferred while an
  editable control inside the view is focused or a task-add popover holds
  text, and runs once focus leaves.
- The calendar Actual toggle repaints a layer only, so an open inspector keeps
  its fields.
- Working Queue pending and conflict records stay in their account-keyed
  storage and surface on the sync dot. No auto-discard, reset or force-sync.
- Working Queue updates memory, then storage, then dispatches
  `dcc:working-queue-sync`, for send, success, conflict and clear. A transient
  failure changes nothing and announces nothing; retry resends the same
  `sourceEventId`.
- Unsaved task notes that fail to save stay in `blockStore.exportPending`
  across navigation and reload (verified by the orchestrator). The visible
  copy can briefly show the server version; export is the recovery path.

## Header

- Hidden `h1` "Daily Command Center".
- Left: `nav#tab-bar` with the three pages, `aria-current="page"`.
- Right: clock (also on phones), cog (`#dcc-settings-button`, same menu and
  every utility), sync dot (`#save-status`).
- Sync dot: name always states status; tooltip on hover and focus; click,
  Enter, Space or tap opens the existing popover. Popover adds Working Queue
  conflict review and commitment pending changes (retry, export, discard with
  confirmation), replacing the Social-only recovery path.
- Clock, cog and dot share one centre line with 44px, non-overlapping hit
  areas at every width. The legacy fixed `.save-status` insets are reset.
- Phones (≤760px): first row is clock left, cog and dot right; second row is
  the three pages in equal columns, labels wrapping instead of clipping. The
  bottom bar maps Today and Queue to Tasks views and More lists Budget and
  Workouts & meals.
- Glasses: the Full app link moves into the glasses navigation bar.

## Retired pages

- Buttons removed from the top bar, mobile More sheet and tutorial.
- Social's "Manage Pet Home", the Mycelium ⌘K switcher and note open bridge,
  and the share-target tab jump are gated.
- Load-time panel fetches gated: Meeting Reviews list, Social badge, Mycelium
  status/list. Pet Home state still loads because the pet courier, nudges and
  task awards read it.
- Panels and scripts stay in the page for a later removal.

## Tests

- `nav-state.test.js`: parsing, migration, legacy links, URL preservation,
  archive defaults.
- `actual-projection.test.js`: every classification, no double counting,
  no plotted guesses, list and calendar presentations.
- `task-workspace-nav.test.js`: markup and CSS contracts, plus the real
  `DCC.nav` controller from `tabs.js` and the List Actual helpers from
  `schedule-tab.js`, run in a VM against a small DOM stand-in.
- Updated fixtures and walkthroughs: `scripts/verify-working-queue.mjs`,
  `scripts/verify-work-completion.mjs`, `scripts/verify-completed-queue.mjs`,
  `scripts/smoke-ci.mjs`, `scripts/smoke.mjs`,
  `scripts/verify-ui-optimization.mjs`, `scripts/verify-glasses-working-queue.mjs`.
- Updated contracts: `mobile-loose-ends.test.js` (date row no longer
  header-scoped), `render-surface-registry.test.js` (Actual summary surface).
- `task-workspace-sync.test.js`: real `working-queue.js` with a controlled
  pending request (notification order for send, failure, retry, conflict,
  clear) and the real shell recovery rows (same-ID retry, two-step discard,
  queue conflict route).
- Browser fixture `scripts/verify-task-workspace-actual.mjs` (run against
  `DCC_REVIEW_ACTUAL=1 node scripts/ui-review-server.mjs`, UTC device clock):
  List chips and totals, Calendar segment geometry and day totals for
  positioned, unplaced, unknown, other-day, duplicate-title and near-midnight
  entries; date switch; toggle off/on with an open inspector; commitment
  recovery by keyboard across navigation and reload, export and two-step
  discard through an in-memory adapter; queue conflict review. Every overlay
  close is awaited (it fades before detaching and restoring focus) and every
  locator is scoped to the one open overlay. Under `DCC_REVIEW_ACTUAL=1` the
  review server also serves a synthetic `/public/js/app-config.js` (review
  account 1 / ws-1, New York, delta sync off; no credentials).
- New 44px minimums on the page buttons, view tabs, Actual toggle and summary
  buttons; the row "+ time" chip keeps its size with a 44px hit area. The
  sync tooltip can be hovered and is dismissed with Escape.

## Validation run so far

- In this worktree: full `node --test` and `npm run lint` (0 errors; existing
  warnings unchanged).
- By the orchestrator, against isolated servers: real-app CI smoke on an
  isolated database, no app console errors; independent navigation browser
  checks at six widths (320 to 1440) covering history, explicit-off reload
  and retired links; pet reminder (22 scenarios), work completion and
  completed queue suites; the Actual fixture through List chips and totals,
  Day review, date switch, Calendar geometry, time zone, unplaced minutes and
  toggle with inspector. The fixture's recovery section failed on test timing
  and missing review config; both are fixed here and await a rerun.
- `scripts/verify-working-queue.mjs` now loads `task-priority.js` and
  `queue-policy.js` like `index.html`; its full flow awaits a rerun.

## Known limitations

- `scripts/verify-ui-optimization.mjs` is not clean. The orchestrator
  reproduced the same failures on `main` at `2d3b30f` (small legacy controls,
  Task Details read mode, quick add), so they are baseline, not caused here.
  Its navigation sections were updated; the rest was not rewritten, and it is
  not claimed to pass.
- Past days: history entries store the Actual preference, and Back/Forward
  re-derive the past-day default for the day on screen. Explicit choices and
  the saved preference win; returning to today restores the preference.
- Fixture screenshots: `actual-calendar-1440.png` is taken on the Calendar
  with Actual on; `queue-conflict-1440.png` shows the queue conflict review.
- The calendar Actual segment is a narrow bar; its keyboard and pointer
  alternative is the inspector's 44px "Add or edit actual time" button.
- A draft deferral waits for focus to leave the view, and clicking navigation
  blurs an editor first, so the heuristic only protects focus-held drafts. A
  task-add popover still closes on an outside click, as before. An integration
  test of inline editors across switches is still worth adding.
- Retired panels and their scripts still load. Their boot reads are gated,
  except Pet Home, which the courier, nudges and task awards need.
- Social's commitment creation, friends and access controls, and Pet Home's
  owner controls, have no route now. Records and APIs are unchanged.
