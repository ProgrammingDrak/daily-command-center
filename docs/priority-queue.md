# Priority Queue

Priority Queue replaces Up Next in the Working Queue workspace. It contains the existing queue's selected, actionable tasks that have never started. Add existing tasks to select work; this does not enroll every historical backlog item. Itinerary remains the plan for when work happens.

- Explicit `taskPriority` uses High, Medium and Low, default Medium. The helper is reused verbatim from PR421/422. Retired urgency fields cannot silently promote a task. The broader unmerged priority/shared-view stack is not bundled here.
- High precedes Medium precedes Low. Within each level, existing queue order remains stable. Arrow keys, Alt+Arrow and drag reorder within the visible lane and priority. Change Priority to move between levels. All writes use the existing account coordinator, revision and retry envelope.
- Scheduling, adding, reading, filtering and priority changes never start or complete work, record actuals, or change dates, parents or planned times.
- Foreground and background starts leave durable evidence. Paused, unblocked and removed/re-added previously started tasks do not return to Priority Queue. Existing queue statuses, task start markers, ledger entries, delegated reports and ambiguous legacy actuals are interpreted conservatively. Ambiguous history is kept paused; no session or start timestamp is invented.
- Done (including legacy day overlays), cancelled, archived, skipped and deleted tasks cannot enter the priority lane. Definitions are excluded; a new recurring occurrence is independently eligible. Completed queue items remain in Completed.
- Membership removal preserves only a boolean prior-activity hint, not a fabricated event. No migration or schema change is required. Task identities, raw historical priority values and recorded activity are preserved.

Validation: pure classification/priority tests, real coordinator lifecycle tests on a disposable PostgreSQL database, existing Working Queue regressions, synthetic desktop/mobile UI checks. Production task data is not used as a test fixture.
