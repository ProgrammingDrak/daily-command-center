# Daily Command Center — QA Checklist

Comprehensive verification that all features work after the migration to local repo.

## Automated preamble (run first)

Before working through the manual checklist, run the scripted smoke test against
a running local server (`npm start` on :3987, then in another shell):

```
npm run smoke              # or: node scripts/smoke.mjs [baseURL] [user] [pass]
```

It logs in, loads the app, and asserts: `window.DCC` core present; every top-bar
tab activates + renders; `DCC.modal`/`DCC.sheet` open and Escape-close; no
horizontal overflow at 375px on any tab; no app-code console errors (JS
exceptions or failed `/public/` asset loads — API/SSE transport noise is out of
scope). Exit 0 = green. Run it before merging any UI PR; it captures ~90% of the
manual checks below in a few seconds.

---

## 1. SCHEDULE MANAGEMENT

- [ ] **Drag reorder**: Drag a task by its grip handle to a new position. Times should auto-cascade (tasks flow around fixed meetings).
- [ ] **Mark task done (modal)**: Click checkmark on a task. Done Modal opens with notes field, action items section, time sessions (clock-face picker), subtask resolution. Confirm marks it done.
- [ ] **Quick complete**: Click the lightning bolt on a task. Instantly toggles done without modal. Flash animation.
- [ ] **Duration +/- buttons**: Click + or - on a task. Duration changes by 15m (min 15m). Downstream times recascade.
- [ ] **Duration preset popover**: Click the duration badge (e.g. "30m"). Popover with presets (15m-6h, paginated). Clicking a preset sets duration.
- [ ] **Start time pin/unpin**: Click the start time on a task. Popover appears. "Set" pins to a time (survives recalc). "Auto" removes pin.
- [ ] **Push to tomorrow**: Click arrow button on a task. Task LEAVES today entirely (no copy left behind) and appears on tomorrow; today shows it under the amber "Rescheduled away" section.
- [ ] **Restore from a move**: Click the arrow on an amber "Rescheduled away" entry. Task returns to this day, with its subtasks, and the amber entry disappears.
- [ ] **Delete from schedule**: Click X on a task. Confirmation dialog shows source context. Confirm removes it.
- [ ] **Uncheck (restore from done)**: Click checkmark on a completed task at top. Returns to active schedule.
- [ ] **Quick-add urgent task**: Type task name in "Add urgent task" bar, click Add or Enter. Task appears after current active task. Times recalculate.
- [ ] **Add from consider/backlog**: Click "Schedule" on a Consider or Backlog item. Appends to schedule, recalculates times.
- [ ] **Overflow detection**: Add enough tasks to exceed EOD. Overflow modal opens showing deficit, task checkboxes to push. "Push Selected" works. "Work Late" extends EOD.
- [ ] **Plan/Actual toggle**: Click "Plan" vs "Actual" buttons. Plan shows editable timeline. Actual shows planned vs actual comparison.
- [ ] **Detail panel expand**: Click a task card body. Detail panel expands with description, links, side project marker, subtasks.
- [ ] **Subtasks**: Click "+sub", add subtask text, press Enter. Checkbox toggles done. X deletes. Incomplete subtasks prompt resolution in Done Modal.
- [ ] **Side project marker**: Click "Move to side projects" on a task card. Task leaves the schedule and appears in Side Projects.
- [ ] **Prep edge tab**: Click "Prep N" above a meeting. Prep items expand. Local files open in Prep Viewer overlay; external links open in new tab.
- [ ] **Follow-up actions edge tab**: Click "N Actions" below a meeting. Action items expand with "Schedule" buttons.

## 2. NOTES & ACTION ITEMS

- [ ] **Notes drawer**: Click notes icon on any schedule/consider/backlog/upcoming item. Drawer slides out with rich-text editor and action items.
- [ ] **Rich text formatting**: Bold, italic, underline, strikethrough, checkbox, bullets, numbered list all work in notes.
- [ ] **Action item in notes**: Click "+ Add Action Item". Type text, select priority, optionally "Schedule today" with duration. "Add" creates it.
- [ ] **Schedule action today**: Action item's "Today" option inserts it into the schedule immediately.
- [ ] **Action Items tab (aggregated)**: Click "Action Items" tab. Shows items from: pending tasks, schedule task notes, upcoming meeting notes.
- [ ] **Add action from tab**: Type in Action Items tab input, click "+ Add". Creates pending task with selected priority.
- [ ] **Toggle/delete action items**: Checkbox toggles done, X deletes, from both notes drawer and Action Items tab.

## 3. TRIAGE

- [ ] **Triage display**: Click "Triage" tab. Items grouped by priority (High/Medium/Low) with escalation indicators, cycle counts, source badges, links.
- [ ] **Dismiss triage item**: Click dismiss button. Modal opens. Use instant dismiss, or add note and save. Item moves to Resolved section.
- [ ] **Complete triage item**: Click done on triage item. Done Modal opens (without time sessions). Parent-task linking dropdown works.
- [ ] **Side projects section**: Add a side project from the task bar or move a task into Side Projects. Checkbox toggles, X deletes. Done items collapse.
- [ ] **Notifications**: If state.notifications exist, notification cards render in triage tab.

## 4. ACTIVE WORK

- [ ] **Start from itinerary**: Click Start on a task. The task appears in Active Work and Slack gains an hourglass when linked.
- [ ] **Pause and resume**: Pause saves the current session. Start begins a new session without changing the planned slot.
- [ ] **Complete from itinerary**: An active task shows Complete under Pause. Completing removes it from Active Work immediately.
- [ ] **Complete from Active Work**: Complete checks off the task, closes the active session, and removes it from the dock.
- [ ] **Multiple active tasks**: Start two tasks. Both remain visible and independently controllable.
- [ ] **Task picker**: Use Start work in the launcher. Search Schedule, Consider, and Backlog tasks.
- [ ] **Work history**: Open task details. Planned, actual, active time, and individual sessions render correctly.
- [ ] **Reload persistence**: Refresh while work is active. Active Work restores from the task row.
- [ ] **Slack parity**: Adding or removing bookmark, hourglass, and check reactions produces the same lifecycle as DCC controls.
- [ ] **Slack deletion parity**: Removing a bookmark deletes the DCC task. Re-adding restores the same task instead of duplicating it.
- [ ] **Meeting rule**: Completing a meeting later records completion at its planned end and actual time as its planned window.

## 5. DATE NAVIGATION & ARCHIVES

- [ ] **Previous/next arrows**: Click left/right arrows. Navigates to adjacent dates with data.
- [ ] **Date picker calendar**: Click date label. Calendar grid opens. Days with data highlighted. Today marked. Click a day to navigate.
- [ ] **Today/Tomorrow buttons**: Visible when on a different date. Click returns to today/tomorrow.
- [ ] **Archive read-only**: Navigate to a past date. Schedule shows in read-only mode. Actual view is default.
- [ ] **Tomorrow pre-plan**: Navigate to tomorrow. Shows pre-planned schedule (if evening-envision has run).
- [ ] **Date switch preserves edits**: Make edits on today, navigate away, navigate back. Edits are preserved (done, deleted, reordered, duration changes, notes).

## 6. SYNC & PERSISTENCE

- [ ] **Three-tier save**: Make an edit → localStorage immediate, IndexedDB after 2s, File DB (HTTP POST) after 5s. Check server logs for "[sync] Saved day-state" messages.
- [ ] **Cold-start restoration**: Clear localStorage for today's date. Reload. Data restores from IndexedDB or File DB.
- [ ] **Copy for Claude**: Click "Copy" in Second Brain menu. Clipboard gets text summary of all changes.
- [ ] **Undo**: Click "Undo". Last action reverses (uncheck, re-check, or restore order).
- [ ] **Reset All**: Click "Reset". Schedule/consider/backlog restore to initial API state.

## 9. ACTIVE WORK SURFACES

- [ ] **Dock placement**: Active Work sits above the itinerary and is hidden when nothing is running.
- [ ] **Itinerary controls**: Idle tasks show Start. Active tasks show Pause with Complete underneath.
- [ ] **Compact utility rail**: Rank dead space is gone. Navigation, drag, and completion controls occupy one narrow rail.
- [ ] **Responsive controls**: Active Work and itinerary controls remain reachable on narrow screens.

## 10. UPCOMING MEETINGS TAB

- [ ] **Upcoming board**: Click "Upcoming" tab. Shows meetings for next 10 business days, grouped by date.
- [ ] **Meeting notes**: Click notes icon on an upcoming meeting. Notes drawer opens (separate localStorage store).
- [ ] **Push to doc**: Click "Push to Doc" on a meeting with linked doc. Markdown summary copied to clipboard. Toast confirms.

## 11. STICKY NOTES

- [ ] **Open panel**: Click "Notes" button in header. Side panel shows all sticky notes.
- [ ] **Create note**: Click "+ New Note". Rich-text editor opens. Save persists.
- [ ] **Edit note**: Click "Edit" on existing note. Editor opens with content.
- [ ] **Delete note**: Click "Delete". Note removed.

## 12. SSE LIVE UPDATES

- [ ] **Real-time refresh**: Modify day-state.json externally (e.g. `echo` to it). Dashboard updates without reload. "Updated!" indicator appears.
- [ ] **Edit-aware deferral**: Focus an input, then trigger SSE update. Update should be deferred until input loses focus.
- [ ] **Reconnection**: Kill and restart server. SSE reconnects within 5 seconds.
- [ ] **Fallback poll**: If SSE stays disconnected, data refreshes every 5 minutes.

## 13. PREP VIEWER

- [ ] **Open prep doc**: Click a local prep link on a meeting card. Full-screen overlay shows HTML content.
- [ ] **Close**: Click X, click background, or press Escape. Overlay closes.

## 13a. BUDGET TANK (aquarium)

- [ ] **Renders**: Budget tab shows the aquarium (glass, water, gravel bed = necessities, decoration blocks). No error card.
- [ ] **Add block**: Edit → + add block → category + optional item + amount + recurring toggle → saves; lands on TOP of the stack (lowest priority).
- [ ] **Drag reprioritize**: Drag a block/row above or below another. Order persists after reload; lock states + thresholds reflow (bottom fills first).
- [ ] **Waterline rises**: Complete a task (or convert points) → banked total rises → blocks it crosses become claimable bottom-up. Waterline never drops on a claim.
- [ ] **Claim**: A claimable block's Claim button → block shows "claimed", reserve debits by its amount, and it appears in the rewards queue. Double-claim is a no-op.
- [ ] **Schedule the reward**: From the toast "Schedule now" (or the rewards queue), the claimed reward places on the itinerary; completing that task redeems it.
- [ ] **Machine agreement**: On the Slots tab, tank rewards show 🐠 below-waterline / claimed-this-month locks and only go eligible once the tank unlocks them.
- [ ] **Money Changer**: Enter points → live preview → Convert credits bank at the rate, waterline rises, points drop. Retrying an in-flight convert never double-spends. Edit mode exposes the rate.
- [ ] **Rollover**: On a new period, a modal offers Carry / Fresh. Carry sinks unhit one-shots to the bottom, envelopes persist, claimed one-shots leave. Leftover sweeps to Investments and a "Transfer $X to brokerage" task appears on today. Re-running doesn't double-invest.
- [ ] **Reduced motion**: With `prefers-reduced-motion`, the water/fish/bubbles hold still (no animation).

## 14. API ENDPOINTS

- [ ] `GET /api/state/day` — returns day-state.json
- [ ] `GET /api/state/tomorrow` — returns tomorrow-state.json (or null)
- [ ] `GET /api/state/upcoming` — returns upcoming meetings array
- [ ] `GET /api/state/archives` — returns last 7 archived day states
- [ ] `GET /api/state/local` — returns local-ui-state.json (or null)
- [ ] `GET /api/brain/recent` — returns all recent day states
- [ ] `GET /api/brain/globals` — returns globals.json
- [ ] `GET /api/prep` — returns all meeting prep HTML files
- [ ] `GET /api/prep/:filename` — returns single prep file
- [ ] `GET /api/health` — returns status with SSE clients, dates, uptime
- [ ] `GET /api/events` — SSE stream connects
- [ ] `POST /api/save-day` — saves to brain/recent/ + brain/archive/ (dual-write)
- [ ] `POST /api/save-globals` — saves globals.json
- [ ] `POST /api/ingest/day-state` — section-level merge (PA sections overwrite, user sections preserved)

## 15. SCHEDULED TASKS

- [ ] **All 6 tasks scheduled**: Verify with `list_scheduled_tasks`. pa-offpeak, pa-morning, pa-midmorning, pa-midafternoon, pa-wrapup, pa-board-cleanup all enabled.
- [ ] **Correct cron schedules**: pa-offpeak (7AM Tue-Sat), pa-morning (9AM Mon-Fri), pa-midmorning (~11AM Mon-Fri), pa-midafternoon (~2:30PM Mon-Fri), pa-wrapup (~5PM Mon-Fri), pa-board-cleanup (7AM 1st of month).
- [ ] **Tasks write to local data**: SKILL.md state paths point to local `data/state/` directory, NOT Google Drive. *(CRITICAL — needs verification/update)*
- [ ] **SSE triggers on task write**: After a scheduled task writes to day-state.json, the dashboard picks up the change via SSE.

## 16. BOOT SEQUENCE

- [ ] **Loading banner**: "Loading data from API..." banner appears on load.
- [ ] **All 11 endpoints fetched**: Console shows "[API Boot] All data loaded from API" with date, upcoming count, archive count, prep count.
- [ ] **Green success banner**: Banner turns green "Data loaded!" and auto-removes after 1.2s.
- [ ] **Error fallback**: If API is down, banner shows red "API load failed" and auto-removes after 3s. Cached data used.
- [ ] **Active work restores**: Tasks with an open work session reappear in Active Work after reload.
- [ ] **SSE connects**: Console shows "[SSE] Connected to live update stream".

---

## CRITICAL MIGRATION ITEMS

These are specific to the Google Drive → local migration and MUST be verified:

- [ ] **Scheduled tasks write path**: The `clever-assistant` SKILL.md references `.clever-pa/state/day-state.json` on Google Drive. These paths need updating to write to the local `data/state/` directory, OR a sync mechanism needs to be set up.
- [ ] **Archive dual-write**: `POST /api/save-day` writes to both `data/brain/recent/` and `data/brain/archive/`. Verify the archive path structure: `archive/{year}/Q{n}/{MM}-{MonthName}/{date}.json`.
- [ ] **Recent file pruning**: Files older than 30 days in `data/brain/recent/` are auto-pruned on save.
- [ ] **No Google Drive dependencies remain**: `server.js` should have NO references to Google Drive paths. All paths should be relative to `data/`.
