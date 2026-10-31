# Journal task type: implementation plan

Branch `feat/journal-handwriting`, base `bf1c8c6` (#445). Author: Claude.
The input was Codex's inspected integration brief. Claude wrote this plan early
in implementation, after one preparatory edit (extracting the shared ink
validator). It was then revised after an independent review; the revision notes
are at the end. Results are in [journal-task-verification.md](journal-task-verification.md).

## Goal

A **Journal** task type. Opening a Journal task opens a handwritten page (Mycelium
Ink strokes) plus optional typed notes. The page belongs to the task forever:
date moves, completion, reload, offline edits and later edits all reopen the
same page. Content is private to its owner and never travels with ordinary task
data, shares, feeds or exports.

## Building-block contract (confirmed against code)

| Mechanic | Canonical reuse | Where |
|---|---|---|
| Type registry | `TaskTypes` entry, one place | `public/js/task-types.js` |
| One projection, many surfaces | `TaskModel.fromBlock` carries `journalId` | `public/js/task-model.js` |
| Private linked record | Same shape as workout/meal `task_activity_records` | `activity-store.js`, `routes/activity.js` |
| Overlay lifecycle | `DCC.overlay.open` (focus trap, inert, restore) | `public/js/core-ui.js` |
| Ink strokes/canvas | DCC `InkStrokes` + `InkCanvas`, unmodified | `public/js/ink/strokes.js`, `canvas.js` |
| Local-first save | Account-bound IndexedDB, resolve on `oncomplete` | pattern from `public/js/ink/store.js` |
| Ink validation | One server validator for vault and journal | `lib/ink-page-validation.js` |
| Guard your guards | Mutations prove each guard's test fails | verification doc |

`strokes.js` and `canvas.js` are byte-identical in DCC and the standalone Mycelium
Ink checkout (`ce6d60f8…`, SHA-256 verified), so DCC's copies were reused as-is.
The standalone's auth, runtime, store and sync were not copied. Neither repo has
a LICENSE/NOTICE; both are ProgrammingDrak-owned and reuse was authorized. No
third-party ink library is vendored.

The vault notebook ingest is **not** used for storage: it is admin-only,
single-tenant and git-synced. Journal tasks must work for every DCC account, so
pages live in DCC Postgres.

## Data model

- **Block properties** (ordinary task metadata): `type: "journal"`,
  `publicVisibility: "private"`, `journalId: "jr_<uuid>"`. No content. The client
  mints `journalId` at creation, so offline-created tasks have one. The server
  mints one if a path omitted it, pins it on every later write, and gives a copied
  journal (repeat/template/duplicate) a fresh id.
- **`task_journal_pages`** (`journal-store.js`, idempotent DDL from `pg-schema.js`):
  `task_id` PK → `blocks.id`, `journal_id` UNIQUE, `workspace_id`, `owner_user_id`,
  `ink` JSONB (Ink v1), `body` TEXT (≤20k), `revision`, `previous` (one-step undo),
  `last_mutation_id`/`last_payload_hash` (idempotent replay), timestamps.
- **Retention**: deletion tombstones the block; `purgeSoftDeleted` keeps blocks
  that own a page. Completion never touches the page. The type is pinned.
- **Existing journals untouched**: `journal.js` mood keys, the vault journal
  workspace and `ink.html` notebooks are not read, migrated or adopted.

## Server

- `routes/journal.js`: `GET`/`PUT /api/journal/tasks/:id`, `POST …/undo`. Session
  user + workspace `owner` role; bearer/service tokens and viewers rejected;
  another owner's task is 404; `Cache-Control: private, no-store`.
- `lib/account-binding.js` requires the tab's captured account headers on
  `/api/journal`.
- Save: `{journalId, ink, body, expectedRevision, mutationId}`. Stale revision →
  409 `JOURNAL_CONFLICT`. Replayed `mutationId` with same payload → stored result.
  Undo has the same removed-task and type guards as save.
- `TaskTypes.privateRecord` (workout, meal, guided, journal) drives `db.js`
  create/update/reschedule, the public share filter and the feed hook.

## Client

- `page-store.js`: database `dcc-journal:v1:u<userId>:<encoded workspace>`, an
  injective name, plus the owner stamped in a `meta` store and on every record.
  Each edit is one read-modify-write transaction resolving on `oncomplete`.
  Unknown stroke versions and pages over 2 MB fail locally.
- `page-sync.js`: per-page outbox. Waits for pen idle. Acknowledges only the
  accepted mutation. Backoff on network/5xx/404; 401 pauses; 409 conflict fetches
  the saved copy and asks the user; if that fetch fails it stays retryable.
- **Revision contract** (added after the second review): `localRev` is the
  version of the device content and changes only when content changes (edit,
  newer server copy, conflict/recovery choice), never on acknowledgements. Each
  editor names the version it displays when it saves. A save naming an older
  version (another tab saved, or a newer server copy arrived while the pen was
  down or typing was pending) is a stale whole-page snapshot: it is kept in
  `drafts`, never written over content it did not display, and never inherits
  that content's `baseRevision`. The user chooses "Keep my version" or "Use the
  newer page"; the other side is kept as a recovery copy.
- **Retention**: drafts and recovery copies have no cap. They leave the record
  only through an explicit choice or "Delete copy". A device that runs out of
  room rejects the write visibly instead of evicting anything.
- **Unsupported formats**: `display()` is the only path into Ink and refuses a
  stroke format other than v1. Any path that meets one (open, background
  refresh, conflict or recovery choice) shows the same read-only error, and the
  store never adopts such content.
- **Conflict policy**: "Keep this device's page" (server keeps the overwritten
  copy in `previous`, and a recovery copy stays on the device) or "Use the saved
  page" (device copy kept as recovery). Every choice first commits the stroke
  under the pen and pending typing and waits for queued writes; a failed local
  write aborts the choice with nothing changed. Choices are compare-and-set on
  the content version.
- `editor.js` (`DCC.JournalTask`): lazy-loads Ink, mounts in a `DCC.overlay`.
  Pen, highlighter, eraser, colors, undo/redo, finger mode, typed notes, status
  line, Retry.
- Entry points: Quick add/launcher **Journal**; Convert…; task detail
  ("Open journal page" / "Use as Journal"); `openAddModal` interception; itinerary
  title click and "Open journal" chip.

## Out of scope

Production migration, deploy, real journal data, OCR, mirroring into the
Mycelium vault, multi-page journals, an offline app shell (service worker).
Physical Apple Pencil validation needs hardware.

## Open architectural decisions

1. **Mirror to the Mycelium vault?** Pages stay in DCC Postgres only.
2. **Multi-page journals.** One page per task; `journal_id` is separate from
   `task_id` so a pages table can hang off it later.
3. **Non-owner workspace members** cannot use journal tasks (same as activity
   records). Opening this to editors is a product decision.
4. **Offline app shell.** DCC has no service worker, so DCC itself does not load
   without network. Adding one is an app-wide change, not a journal change.
5. **Shared-device residue.** A signed-out account's unsynced pages stay in that
   account's on-device database until it signs in again and syncs. Another
   account cannot open them through DCC, but they are on disk. Clearing on
   sign-out would lose unsynced writing; this trade-off needs a product call.

## Revision after independent review (2026-10-31)

- Account namespace was a 32-bit FNV hash; two synthetic accounts collided.
  Replaced with an injective name plus database and record owner checks.
- Conflict fetch failure no longer parks the page; it retries.
- A blocking dialog that replaces the editor now gets its own handle; unsaved
  strokes are kept in memory, retried, restored on reopen, and guarded by
  `beforeunload`.
- Finger panning added: after a pen (or with finger mode off), one finger on the
  paper scrolls the dialog; two fingers neither ink nor pan.
- Closed editors' dirty pages drain on reconnect, visibility and startup.
- Undo gained the save route's guards; unknown stroke versions open as an error.
- Browser testing found two more bugs, both fixed: timers invoked as methods
  ("Illegal invocation") meant no save ever left the device; Quick add passed the
  local task id, so sync now resolves the server row by `journalId`.
