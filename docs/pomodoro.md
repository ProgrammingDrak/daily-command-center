# Foreground Pomodoro focus plans

The tomato beside Foreground opens one task-associated focus plan per account and
workspace on this browser. A plan contains four 20-minute sections. Set all four
objectives up front, or supply each before starting that section. Save objectives
explicitly; Start, Pause, Resume, and Prepare next section also save current edits.
Each countdown stops at zero and waits for explicit progression. Finish plan
acknowledges section four. Closing the dialog leaves the deadline running.
An early end requires confirmation and never marks a task complete.

Persistence is browser-local, not server-synced. A single localStorage record is
committed before the UI acknowledges success. Web Locks serialize writes across
tabs, and revision checks reject stale edits without discarding the visible draft.
Another account/workspace uses another namespace. Invalid stored records are
preserved and reported; failed writes leave the previous saved plan intact.
A browser without Web Locks cannot start or mutate a timer.

Deadline-based display survives reload, suspension and restart. Expiry is derived
from the saved deadline, so repeated ticks never advance a section or send a cue
twice. System-clock changes affect the displayed remaining time. There are no
background alarms or closed-browser notifications. Changing foreground does not
retarget the plan: its dialog continues to name the originally selected task.
Deleting that task likewise retains the plan as an independent title/id snapshot;
timer actions never recreate the deleted task.
The Foreground tomato shows current section, remaining time, pause or expiry.
Timer expiry is not measured work. This feature never writes task activity,
status, focused actuals, snoozes, or worker state.

Verification:

- `node --test pomodoro.test.js`
- `node scripts/verify-pomodoro.mjs` (synthetic localhost fixture with real queue,
  overlay and Pomodoro scripts; Chrome executable configurable via CHROME_PATH)
- `npm run lint` and `npm test`

No database or production migration is required. This does not cache the full app
for reopening offline or provide cross-device plan synchronization.
