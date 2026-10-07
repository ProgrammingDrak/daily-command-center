# Waiting check-in prompt

Branch: `codex/waiting-checkin-prompt`, based on `f845ad6`.

Clicking **Checked in** opens a date and optional-note draft. Save records the check-in, sets the chosen next date, and creates one completed **Check in on [task]** entry on the app's current local day. The original remains Waiting. Cancel, Escape, and backdrop dismissal write nothing. A canceled prompt from Edit Waiting returns to that editor with its draft intact.

The canonical Waiting row owns `checkInHistory` (cycle key, completion timestamp, next date, optional plain-text note, completed-task block ID). Check-ins display in Edit Waiting and the linked task's existing History tab. Context notes remain intact. The completed entry carries `linkedBlockId`, `waitingItemId`, and the note; it is private, has no fabricated planned/tracked minutes, and creates no time-entry or reward event. It is independent of scheduled check-in reminder rows, so closing Waiting later does not remove the check-in log.

Save locks the Waiting row before checking the cycle and writes history, the completed block, and the next date in one database transaction. A captured history revision prevents duplicate saves even when an early check-in keeps the same future date. A changed cycle returns a no-op and refreshes the UI. The shared overlay controller owns focus trapping, inert background, Escape/backdrop dismissal, mobile sheets, and focus restoration; dismissal is blocked while Save is pending.

## Validation

- 190 focused Waiting, task projection/serialization, task modal, and work-session regression tests passed.
- Mutation checks detected removed note history, same-date replay protection, and the double-submit guard; each mutation was restored. JavaScript syntax checks and `git diff --check` passed.
- `node scripts/verify-waiting-checkin.mjs` runs actual prompt/controller functions in Chromium with fake requests at 1280, 390, and 320px. Covers Cancel, Escape, focus trap/restore, validation, failed-save recovery, Enter to save, repeat-submit guard, async caller results, escaped history, and mobile overflow. Screenshots go to `test-results/waiting-checkin/`.
- Fixture route tests cover transaction/row-lock usage, app-timezone day boundaries, one completed log on retry, no original-task completion, invalid inputs, failure rollback, and retained future-date check-ins.

## Boundaries

The prompt uses a native date field (opting out of the shared picker's hidden-input enhancement) to preserve required/min validation and keyboard editing. Next follow-up is a calendar date after today, using existing DCC date and app-timezone conventions; it is not a time-of-day reminder. Cadence settings remain intact, with the selected date overriding the next occurrence. History extends JSON properties and needs no migration. Browser QA is a focused fixture harness; no live Postgres records or production tasks were mutated. No deployment, push, or merge was performed, and the challenge-alarm checkout was untouched.
