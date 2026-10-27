# Manual task switching

In Active work, choose **Switch tasks**, select the next task, and optionally set a pet check-back (5, 15, 30, or 1–1440 custom minutes). Cancel/Escape makes no change. If older Start controls left several timers running, pause the extras first.

The previous task appears in Background work; its focused-effort timer is closed. Background elapsed minutes are informational and do not add effort or points. Return opens the same switch dialog. Snooze re-arms the reminder for five minutes. Dismiss removes the background entry without completing or deleting the task. Task nesting, dates, recurrence, and ordering are unchanged.

Guided targets preview their current instructions and retain existing definition/context/session checks. Switches use one transaction and one transition timestamp, including guided work. If the previous timer is overdue for automatic pause, its effort ends at the existing missed-check-in cutoff; the next task starts at the actual switch time. Completion still requires the existing explicit action.

Check-backs persist in the private `work_rotations` table and survive reload/sleep. One server-side claim suppresses repeat pet presentation across tabs. The due entry stays reachable if animation is suppressed, the tab closes during presentation, or a claim response is lost. Completing/deleting/resuming a task invalidates its old check-back.

Switching requires connectivity. The exact pending operation is saved locally before sending; a lost response can be retried after reload without repeating the switch. A pending operation is visibly unconfirmed, never described as saved. The cached background list remains visible offline. Pet delivery is in-app while a visible DCC tab is open; there are no closed-browser notifications or assistant integrations.

## Schema and verification

`pg-schema.js` adds `work_rotations` with user/workspace ownership, RLS and no public API role grants. No backfill, new credentials, or external setup is needed. Schema bootstrap is required before enabling the endpoint. No migration was applied to live data during implementation.

- `npm test`
- `npm run lint`
- `DCC_TEST_DATABASE_URL=<disposable localhost database> npm run test:postgres`
- `DCC_TEST_DATABASE_URL=<disposable localhost database> node --test guided.test.js work-rotation.test.js work-session-route.test.js block-store-wal.test.js`
- `DCC_TEST_DATABASE_URL=<disposable localhost database> node scripts/verify-work-rotation.mjs`

The browser harness seeds only its isolated schema, mounts only test routes, launches a separate headless Chrome process, and never starts the production server. `CHROME_PATH` overrides the local Chrome executable. `DCC_ROTATION_SCREENSHOT` overrides its default `/tmp/dcc-work-rotation-mobile.png` image output.
