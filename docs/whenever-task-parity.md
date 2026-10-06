# Whenever task parity

Whenever was already a normal persisted task with `date: null`, `kind: backlog`, and `stage: Whenever`. Its reduced row and backlog projection hid normal task controls and dropped tree/provenance fields. Moving a parent there was explicitly refused.

The drawer now uses the shared itinerary row, normal task editor and normal add picker. Subtasks, nested tasks and grandchildren stay dateless, retain their two canonical edges, and inherit the parent's visibility. The badge counts roots. Expand/collapse, keyboard details, duration changes, source links, nest-under picker and drag nesting work in the pool. Normal delete/undo uses the same transactional soft-delete and original-row revival path.

Scheduling or completing any pool child schedules its whole root tree; completion then calls normal `toggleDone` for the selected task. Moving scheduled parents to Whenever and releasing pool branches into Task Library use the existing reschedule endpoint, canonical subtree collector, optimistic row versions and one database transaction. A moved branch detaches its root only; descendant identities, notes, tags, privacy, sources, provenance and internal edges survive. Failed moves retain the visible tree. No schema migration, external fetch, file grant or production mutation is introduced.

Validation: 300 passing targeted Node tests across affected task model, serialization, source, carryover, tree deletion, route, subtree collection, SQL pool and optimistic-lock regressions; synthetic browser checks at 1280px and 390px. `node scripts/verify-whenever-tree.cjs` uses only synthetic data, real shared rendering/creator code and the pure server planner. Set `CHROME_PATH` if Chrome is elsewhere. A mutation check confirmed removing descendant ownership validation fails its acceptance test. Canonical pool rows also suppress old day-state seeds on refold so they cannot render on the original schedule after moving. Screenshots land in `/tmp/whenever-tree-{width}.png`. This harness does not authenticate or contact production.

Existing normal undo revives each deleted row separately; its partial-restore behavior on a permanent failure is retained. This change does not redesign that shared API. Durable file uploads remain the separate storage decision described in `task-source-references.md`.

Local only: no push, PR, merge or deployment.
