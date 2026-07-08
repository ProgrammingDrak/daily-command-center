# Daily Command Center - Changelog (historical PR notes)


> Renamed from TODO-README 2026-07-04: this file was a per-PR QA log, not a live
> TODO (it still described the SQLite era). Kept as history. Live conventions:
> ARCHITECTURE.md. Manual QA: QA-CHECKLIST.md.
## Current PR: Task-row radial menu + unified schedule popover + Completed quick-add + row-level bounty

### What Changed
- **Task-row radial**: the row arrow (`.btn-task-radial`, was `.btn-push-tmr`)
  fans a radial menu via a new generic engine (`public/js/radial-menu.js`,
  extracted from the #197 destination fan; fixes its stale trigger-highlight
  and Escape-listener leak). Top fan: Change task / Duration / Pomodoro /
  Lock-Unlock / Add task; the Change task spoke opens a sub-fan (Back /
  Schedule / Subtask / Delegate / Repeat / Backlog). Rows keep only done,
  notes, bounty, delete; meetings keep their direct buttons; the trigger is
  visible on mobile, giving phones full task actions for the first time.
- **One schedule popover**: `public/js/schedule-popover.js` unifies reschedule,
  quick-add create, and date-pick behind `openSchedulePopover({mode})`;
  the state.js popover pair is deleted with same-signature wrappers kept.
  Create mode stages duration/time and commits via insertTaskNow /
  commitScheduledTask / untimed persist (target day's Unscheduled section).
- **Completed destination**: new ✅ spoke on the add fan creates a task
  already checked off (retro-logging) through the normal toggleDone path.
- **Bounty on the row**: 🎯 button on every eligible row until the day's
  self bounty is placed, then all buttons vanish and the chosen task gets a
  golden glow (`.card-bounty` upgrade + `.it-list-item.row-bounty`; sponsor
  purple still wins). Replaces the gated radial spoke that read as missing.
- **Bug fix**: `persistAddedTask` persisted duration 0 for untimed items
  (dur() is end-start and pt("") is 0); now falls back to durMin.

### QA
- `npm test` 197/197 (4 new mutation-checked persistAddedTask regression
  tests); `npm run smoke` passed; 42-check headless E2E (both fan levels,
  all three popover modes, Completed flow, lock toggle, full bounty cycle
  with state restore, 375px clamping, guest page unaffected). Five-lane
  local pre-review + adversarial verification; findings fixed in-branch.

## Previous PR: Reschedule unification + radial task destinations + true-move hardening

### What Changed
- **Reschedule fixes**: undated task-bar blocks 400ed on every true move; the
  client now sends the viewed day as `fromDate`, the server accepts it as the
  origin fallback and stamps a real date (self-healing). Undated
  subtaskOf/wrapId-linked blocks join the subtree walk (filtered so delegated
  items stay out). Tombstones no longer fold into the day as lookalike task
  rows. WAL hardening: 400/404 rejections drop their entry (stamped
  `e.permanent`), buffered reschedules older than 15 min dead-letter
  (pre-#167 reversal guard). Full target day no longer refuses a move.
- **Placement standard**: `openPlacementPicker` generalizes the 2-step day →
  "After…" picker; `moveTaskViaPlacement` is the canonical mover (popover day
  buttons, custom date, move menu). `rescheduleTaskToDate` honors
  `opts.pinnedStart`; picker titles are editable and rename before the move.
- **Radial destinations**: `TASK_DESTINATIONS` registry (Urgent / Schedule /
  Backlog-Idea / Shell) drives every task-add bar; + Add or Enter fans out
  the options and picking commits in one gesture; hover shows a mini preview
  that expands on approach. Launcher FAB quick tap picks the type FIRST,
  then opens the compose armed with it. Blank titles raise a confirm toast.
- **App-wide toast visibility fix**: the legacy `.toast` opacity:0 rule hid
  every container toast after its entry animation; scoped override restores
  them.

### QA
- `npm test` 193/193 (6 new WAL contract tests, frozen vm clock);
  `npm run smoke` passed; every flow driven headlessly on desktop + mobile
  viewports (move with preset / after-task anchor / earliest, amber restore,
  radial adds to all four destinations, FAB choose-type-first, hover-promote,
  blank-title confirm, editable titles in both picker modes).

## Current PR: Shell task type + TASK_TYPES registry + universal add picker

### What Changed
- **TASK_TYPES registry** (`public/js/task-types.js`, UMD): declarative per-type
  rules (earnsOwnPoints, rollupMode, bonusPct, childEdge, movable, …) shared by
  the frontend and the backend scoring (`slot-scoring.js` derives
  NON_EARNING_TYPES from it). Future types with rules are config, not
  conditionals. Existing types are described; their historical call sites
  (isMeeting etc.) remain the live enforcement.
- **Shell type**: a container ("Work Day") whose points roll up from children.
  Children are full tasks on the wrap edge (own time, own duration points).
  Shell earns nothing itself (backend hard-zero, like ooo); when the last child
  completes it auto-completes and banks a 10% bonus of the children's estimated
  points via points_override (idempotent ledger sourceKey `<date>:<shellId>`).
  Manual check is blocked while children are open. No clawback on un-check.
  Silver bar + tinted `.card-shell` + `Σ pts · done/total · +bonus` chip.
- **Universal "+" picker**: every row's add button (next to the rank number in
  List view) opens Before / After / Subtask / Nested. Shells hide Subtask and
  default to Nested (`_placeInWrapWindow` lands children at the next free slot
  inside). The old add-subtask-only button is gone; ⚡ quick-complete shares the
  check cluster (hidden on shells).

### QA Checklist
- [x] `npm test` (167, incl. new task-types.test.js contract tests)
- [x] `npm run smoke http://localhost:8090` (no app-code console errors)
- [x] Headless walkthrough: create shell → 2 nested children sequence correctly
      → picker chips right on shell vs normal task → silver bar/tint/chip →
      manual check blocked with toast → auto-complete + bonus toast on last
      child → ledger shows 30/45/8(override) → uncheck/recheck = no double award

---

### What Changed
18 files, ~800 lines. Four major fix areas plus UI polish.

---

## QA Checklist - Must Pass Before Merge

### 1. Task Persistence (CRITICAL)
- [ ] Add 3 tasks via quick-add bar, refresh, all 3 still present (no ID collisions)
- [ ] Tasks appear at the **same times** after refresh (no shifting to 00:00 or wrong slot)
- [ ] Add 2 tasks, refresh, add 2 more, refresh, all 4 present with correct times
- [ ] `GET /api/blocks?date=YYYY-MM-DD` shows each `added_task` block with unique `local_id` and populated `start`/`end`
- [ ] Drag-reorder a task, refresh, task stays in its new position

### 2. Overflow Modal
- [ ] Add a task that fits before EOD, task appears immediately, no overflow modal
- [ ] Add a task that won't fit, overflow modal opens with pending task at top (amber row, labeled "New task")
- [ ] Close overflow modal (X / backdrop / Cancel), pending task is NOT added anywhere (no ghost)
- [ ] Check only the pending task's checkbox, "Push selected", task pushed to tomorrow
- [ ] Check an existing task (not pending), "Push selected", existing pushed, pending committed to schedule
- [ ] "I'm working late", pending task committed, EOD extended

### 3. Overflow Date-Awareness
- [ ] Navigate to archive day, no overflow modal fires
- [ ] Navigate to today, overflow fires with correct deficit for today's EOD
- [ ] Overflow label says "today's schedule" on today, shows the actual date on other days

### 4. Cascade Anchor
- [ ] Mark all morning tasks done, add new task, it slots into current time (not after evening meeting)
- [ ] Tasks fill gaps before meetings rather than piling up after them

---

## What Was Fixed (Technical Details)

### A. Task Persistence - IDs Collide + Times Lost on Refresh
**Root cause:** `nextId=200` in `state.js` reset every page load. Multiple sessions generated `qa-200`, `qa-201`, etc. Blockstore blocks collided on `local_id`, duplicates silently dropped. Additionally, `persistAddedTask()` stored `duration` but not `start`/`end` - tasks reloaded at `00:00` and got recascaded to wrong positions. Even after storing times, `recalcTimes()` overwrote them because tasks lacked `_pinnedStart`.

**Fix:**
- `state.js` - `qaId()` generates `"qa-" + Date.now() + "-" + random` (collision-proof)
- `schedule.js` - `persistAddedTask()` stores `start`/`end` in blockstore; `syncAddedTaskTimes()` updates blockstore after drag reorder
- `persistence.js` - `reloadPersistedEdits()` sets `_pinnedStart` on loaded tasks so `recalcTimes()` respects their positions
- `drag.js` - Clears `_pinnedStart` on dragged task (so drag works), syncs new times to blockstore
- `boot.js` - Moved `reloadPersistedEdits()` call to AFTER `blockStore.loadDay()` (cache must be populated first)

### B. Overflow Modal Redesign
**Root cause:** `insertTaskNow()` committed tasks to `scheduled` array before checking if they fit. Ghost tasks appeared in overflow list, no way to cancel.

**Fix:** `_pendingNewTask` staging pattern - simulate placement, check fit, only commit if it fits or user confirms via overflow modal. Close/cancel discards. Pending task shown separately at top of modal.

### C. Overflow Date-Awareness
**Root cause:** `EOD` calculated once at page load, never updated on date navigation. `checkOverflow()` ran on archive days.

**Fix:** `initKeys()` recalculates `EOD` from loaded `__state`. `checkOverflow()` guards against archive mode.

### D. Cascade Anchor
**Root cause:** `recalcTimes()` anchored at first undone INIT_SCHED item. If only undone item was an evening meeting, tasks piled up after it even when afternoon was free.

**Fix:** `Math.min(cursor, now())` on today's view pulls cascade anchor back to current time.

---

## Remaining Phases

### Phase 1 - Quick UI Polish (DONE)
| # | Note | Status |
|---|------|--------|
| 9 | Remove 25m timer option | Done |
| 13 | Blue time indicator on historical pages | Done |
| 16 | Remove Upcoming tab | Done |
| 17 | Report Card to far right | Done |
| 18 | Draggable timer circle | Done |

### Phase 2 - Bug Fixes (Partial)
| # | Note | Status |
|---|------|--------|
| 1 | Task notes not rendering in complete object modal | Not started |
| 2 | Silent fail on drag into small block | Done (toast added) |

### Phase 3 - Stats Bar & Time Block Rework
| # | Note | What |
|---|------|------|
| 8 | Swap Tasks/Time Left stat positions | Reorder `<div class="stat">` elements |
| 3 | Time Left = sum of undone durations | Rework `updateStats()`, hover breakdown |
| 4 | Work/personal time blocks | Add block config to `user-context.yaml`, rename "Day Ends" to "Current block ends" |

### Phase 4 - Schedule/Agenda Rework
| # | Note | What |
|---|------|------|
| 5 | Rename Schedule to Daily Agenda | Auto-populate meetings, pre-populate next 2 days |
| 7 | Task column formatting | Full-width tasks, indent overlaps, Plan/Actual toggle |

### Phase 5 - Timer & Urgent Task Flow
| # | Note | What |
|---|------|------|
| 10 | Timer task placement + auto-start | Conflict modal (complete/push/split), session groups |
| 11 | "I got distracted" button | Retroactive urgent task, distraction duration, time log |

### Phase 6 - Architecture Features
| # | Note | What |
|---|------|------|
| 6 | Fix scheduled task runner | Audit cron/OS hooks, diagnose why tasks don't fire |
| 16 | Conflict check on WAL replay | Before replaying a queued mutation, compare its `updated_at` to the server block's `updated_at`; skip the replay if the server is newer so a stale local queue doesn't clobber a cross-machine edit. Small lift, prevents silent data loss in multi-device use. |

### Phase 7 - Task Grouping (in progress, rolling out incrementally)

The umbrella vision is to give the user multiple lenses for grouping tasks. Each lens
is a separate increment so we don't boil the ocean.

| # | Note | What |
|---|------|------|
| Categories | UX upgrade on existing tag system | Tags get visual prominence on task cards (color stripe + chips) so the type of task is distinguishable at a glance. Sort/filter by category. The existing tag-block matching (`acceptedTags` on schedule blocks, ancestor-aware tag tree, `recalcTimesTagAware`) is already wired -- this is purely a visualization + selection layer. **Active increment.** |
| Pomodoro Groups | Contiguous task sessions | A user-defined group of tasks that share a session: drag/push as a unit, complete as a unit, optionally framed in pomodoro intervals (user does not have to actually run pomodoros). Touches `scheduled[]`, `recalcTimes`, drag, overflow, persistence. Likely supersedes Phase 5 #10 "session groups". |
| Projects | Persistent parent of subtasks across days | Today's "subtasks" stay; on top of them, a "Project" is a long-lived block whose subtasks are what get scheduled day-to-day. Sets up the substrate for the Expected Value / Thinking in Bets methodology -- eventually each project carries probability of success, expected value of outcomes, and required inputs (time, money), so the system can rank what's worth doing. **Visual:** subtasks rendered indented under their parent project on the agenda so the hierarchy reads at a glance; same indent treatment should apply to the existing subtask concept. |
| Commute / Buffer Time | Pre-event buffer with travel mode | Allow attaching a buffer/commute interval before a task or meeting so the agenda shows "leave by" vs "event starts". User picks the commute mode (walk / bike / car / transit / rideshare / etc.) so the buffer has visual + semantic meaning, and downstream features (e.g. driving-mode pomodoro suppression, weather-aware nudges) have something to hook into. |

---

## Architecture Notes

### Data Flow
```
User action -> scheduled[] array -> recalcTimes() -> render()
                    |
                    v
            persistAddedTask() -> blockStore.createBlock("added_task", {...})
                                        |
                                        v
                                  SQLite via REST API (POST /api/blocks)
```

### Boot Sequence
```
API fetch (11 endpoints) -> state init -> registries
    -> blockStore.loadDay() -> reloadPersistedEdits() -> render()
```

### Key Globals
- `scheduled` - Live task array, mutated by add/drag/complete/push
- `INIT_SCHED` - Original schedule from state file (immutable reference)
- `EOD` - End of day in minutes, from `__state.schedule.end_time`
- `viewMode` - "today" | "tomorrow" | "archive"
- `_pendingNewTask` - Staged task for overflow modal (not in scheduled until confirmed)

### BlockStore
- `createBlock(type, properties, {date})` - Optimistic cache + API POST to SQLite
- `getByType(type)` - Sync read from in-memory cache
- `updateBlock(id, properties)` - Optimistic cache + API PATCH
- `loadDay(dateStr)` - Async fetch all blocks for date into cache
