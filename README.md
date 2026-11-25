# Daily Command Center

## Mycelium Ink

`/library` is the admin-only home for daily journals and handwritten notebooks.
The permanent Journals book collects existing dated entries. Other notebooks
keep their original account-scoped IndexedDB records and stable sync identities.
The old `/ink` address redirects to Library.

Journal sketches share Ink's live renderer and pointer controller, all nine
implements, fifteen configurable paper layouts, finger drawing, and recovery
guards. Journal drafts save locally before background vault sync. Conflicts
preserve the local draft and expose the vault copy for review.

See [Library behavior and validation](docs/library-journal-ink.md).

The existing canvas is also a reusable [drawable-layer building block](docs/ink-drawable-layer.md).
Its integration contract preserves the iPad/Pencil behavior validated in `ink-v7`.

- IndexedDB stores strokes before any network request.
- Each account workspace uses a separate local database.
- The service worker caches shell files only. It never caches APIs or ink.
- Sync stores editable stroke JSON and a rendered image in the Mycelium vault.
- A stable notebook ID prevents title collisions and survives renames.
- The server validates stroke structure before storage.
- Retries acknowledge the exact page version sent.
- Failed pages do not block later healthy pages.

OCR is a derived-data boundary. This release sends no page to an external OCR
provider. Initial pages persist with `ocr_status: pending`. A later trusted OCR
worker can resubmit identical ink with `complete` or `partial` output. That
update replaces the pending section without duplicating media or pages.

The image remains authoritative. Ink remains editable truth. OCR can never
replace either source.

Page and notebook deletion are local-only today. The UI does not expose them.
A future deletion flow needs durable tombstones before it can safely ship.

## Duration stepping

Task durations support any positive whole-minute value.

- Presets set exact values.
- Custom fields preserve off-grid values.
- Plus snaps upward to the next 15-minute increment.
- Minus snaps downward without reaching zero.
- Repeated presses continue across the 15-minute grid.
- Every duration stepper uses `stepDuration()` from `public/js/state.js`.

## Ship It

| Setting | Value |
|---|---|
| Reviewers | `none` |
| Feature reports | `none` |
| Feature report channel | `none` |
| Closing post | `none` |
