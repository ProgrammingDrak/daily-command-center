# Daily Command Center - Changelog (historical PR notes)


> Renamed from TODO-README 2026-07-04: this file was a per-PR QA log, not a live
> TODO (it still described the SQLite era). Kept as history. Live conventions:
> ARCHITECTURE.md. Manual QA: QA-CHECKLIST.md.
## Current PR: Task Persistence + Overflow + UI Polish

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
