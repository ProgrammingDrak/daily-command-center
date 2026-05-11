# Daily Command Center — QA Checklist

Comprehensive verification that all features work after the migration to local repo.

---

## 1. SCHEDULE MANAGEMENT

- [ ] **Drag reorder**: Drag a task by its grip handle to a new position. Times should auto-cascade (tasks flow around fixed meetings).
- [ ] **Mark task done (modal)**: Click checkmark on a task. Done Modal opens with notes field, action items section, time sessions (clock-face picker), subtask resolution. Confirm marks it done.
- [ ] **Quick complete**: Click the lightning bolt on a task. Instantly toggles done without modal. Flash animation.
- [ ] **Duration +/- buttons**: Click + or - on a task. Duration changes by 15m (min 15m). Downstream times recascade.
- [ ] **Duration preset popover**: Click the duration badge (e.g. "30m"). Popover with presets (15m-6h, paginated). Clicking a preset sets duration.
- [ ] **Start time pin/unpin**: Click the start time on a task. Popover appears. "Set" pins to a time (survives recalc). "Auto" removes pin.
- [ ] **Push to tomorrow**: Click arrow button on a task. Task moves to "pushed" section. Removed from active schedule.
- [ ] **Restore from tomorrow**: Click arrow on a pushed task. Returns to active schedule.
- [ ] **Delete from schedule**: Click X on a task. Confirmation dialog shows source context. Confirm removes it.
- [ ] **Uncheck (restore from done)**: Click checkmark on a completed task at top. Returns to active schedule.
- [ ] **Quick-add urgent task**: Type task name in "Add urgent task" bar, click Add or Enter. Task appears after current active task. Times recalculate.
- [ ] **Add from consider/backlog**: Click "Schedule" on a Consider or Backlog item. Appends to schedule, recalculates times.
- [ ] **Overflow detection**: Add enough tasks to exceed EOD. Overflow modal opens showing deficit, task checkboxes to push. "Push Selected" works. "Work Late" extends EOD.
- [ ] **Plan/Actual toggle**: Click "Plan" vs "Actual" buttons. Plan shows editable timeline. Actual shows planned vs actual comparison.
- [ ] **Detail panel expand**: Click a task card body. Detail panel expands with description, links, trivial checkbox, subtasks.
- [ ] **Subtasks**: Click "+sub", add subtask text, press Enter. Checkbox toggles done. X deletes. Incomplete subtasks prompt resolution in Done Modal.
- [ ] **Trivial flag**: Check "Mark as trivial" in detail panel. Visual indicator appears on card.
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
- [ ] **Dismiss triage item**: Click dismiss button. Modal opens. "Trivial" instant dismiss, or add note and save. Item moves to Resolved section.
- [ ] **Complete triage item**: Click done on triage item. Done Modal opens (without time sessions). Parent-task linking dropdown works.
- [ ] **Trivial tasks section**: Click "+ Add" in trivial tasks. Type text, Enter. Checkbox toggles, X deletes. Done items collapsible.
- [ ] **Notifications**: If state.notifications exist, notification cards render in triage tab.

## 4. POMODORO TIMER

- [ ] **Start from schedule**: Click clock icon on any task card. Timer tab activates, task name set, duration set.
- [ ] **Start/Pause/Resume**: "Start to Focus" starts countdown. "Pause" pauses. "Resume" resumes.
- [ ] **Reset**: Click "Reset". Timer resets to current mode's full duration.
- [ ] **Skip phase**: Click "Skip". Ends current phase, triggers completion logic.
- [ ] **Mode switch**: Click Focus/Short Break/Long Break. Timer resets to new duration.
- [ ] **+1 minute**: Click "+1". Adds 60 seconds.
- [ ] **Sound toggle**: Click "Sound: On/Off". Toggles beep on phase completion.
- [ ] **Phase auto-progression**: Timer hits 0 → logs session, beep plays, session dots update, mode switches.
- [ ] **Task completion modal**: Click checkmark on timer task. Modal shows schedule + pomodoros for attribution.
- [ ] **Task picker**: Click task area in timer (not checkmark). Searchable picker overlay with Schedule/Consider/Backlog items.
- [ ] **Report sub-tab**: Click "Report" in timer. Shows focus time, session count, per-task bars, session log.
- [ ] **Timer badge**: While running, Timer tab shows pulsing badge.
- [ ] **State persists across reload**: Refresh page. Timer resumes where it was (accounts for elapsed time).

## 5. DATE NAVIGATION & ARCHIVES

- [ ] **Previous/next arrows**: Click left/right arrows. Navigates to adjacent dates with data.
- [ ] **Date picker calendar**: Click date label. Calendar grid opens. Days with data highlighted. Today marked. Click a day to navigate.
- [ ] **Today/Tomorrow buttons**: Visible when on a different date. Click returns to today/tomorrow.
- [ ] **Archive read-only**: Navigate to a past date. Schedule shows in read-only mode. Actual view is default.
- [ ] **Tomorrow pre-plan**: Navigate to tomorrow. Shows pre-planned schedule (if evening-envision has run).
- [ ] **Date switch preserves edits**: Make edits on today, navigate away, navigate back. Edits are preserved (done, pushed, deleted, reordered, duration changes, notes).

## 6. SYNC & PERSISTENCE

- [ ] **Three-tier save**: Make an edit → localStorage immediate, IndexedDB after 2s, File DB (HTTP POST) after 5s. Check server logs for "[sync] Saved day-state" messages.
- [ ] **Cold-start restoration**: Clear localStorage for today's date. Reload. Data restores from IndexedDB or File DB.
- [ ] **Copy for Claude**: Click "Copy" in Second Brain menu. Clipboard gets text summary of all changes.
- [ ] **Undo**: Click "Undo". Last action reverses (uncheck, re-check, or restore order).
- [ ] **Reset All**: Click "Reset". Schedule/consider/backlog restore to initial API state.

## 9. SIDEBAR (Timer Tab)

- [ ] **Mini schedule**: Timer tab sidebar shows remaining tasks with color bars, times, pomodoro start buttons.
- [ ] **Done panel**: Click "Done" tab in sidebar. Shows completed tasks with planned vs focused time.
- [ ] **Consider panel**: Click "Consider" tab. Shows consider items with metadata and pomodoro buttons.
- [ ] **Backlog panel**: Click "Backlog" tab. Shows backlog items with stage badges and pomodoro buttons.

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
- [ ] **Pomodoro restores**: If timer was running before reload, it resumes with elapsed time accounted for.
- [ ] **SSE connects**: Console shows "[SSE] Connected to live update stream".

---

## CRITICAL MIGRATION ITEMS

These are specific to the Google Drive → local migration and MUST be verified:

- [ ] **Scheduled tasks write path**: The `clever-assistant` SKILL.md references `.clever-pa/state/day-state.json` on Google Drive. These paths need updating to write to the local `data/state/` directory, OR a sync mechanism needs to be set up.
- [ ] **Archive dual-write**: `POST /api/save-day` writes to both `data/brain/recent/` and `data/brain/archive/`. Verify the archive path structure: `archive/{year}/Q{n}/{MM}-{MonthName}/{date}.json`.
- [ ] **Recent file pruning**: Files older than 30 days in `data/brain/recent/` are auto-pruned on save.
- [ ] **No Google Drive dependencies remain**: `server.js` should have NO references to Google Drive paths. All paths should be relative to `data/`.
