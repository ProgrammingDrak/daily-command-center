/**
 * db.js — Postgres Block Database Layer
 *
 * Single source of truth for all user data in the Daily Command Center.
 * Uses pg (node-postgres) with async/await for all operations.
 *
 * Block model: every entity (task, note, action item, sticky note, etc.)
 * is a "block" with a type, parent, properties (JSONB), and sort order.
 */

const crypto = require("crypto");
const pool = require("./pg-pool");
// slot-scoring is standalone (it only pulls in public/js/task-types), so this
// stays acyclic; createItineraryTask uses it to stamp points at write time.
const { scoreTaskPoints } = require("./slot-scoring");
// lib/recurrence is pure (no db, no http), so requiring it here stays acyclic;
// updateBlock's completion hook uses it to reset a responsibility's cadence.
const recurrence = require("./lib/recurrence");
// The shared FE/BE task-type registry, UMD-wrapped for exactly this. getCarryoverPool
// derives its fixed-time skip set from isFixed() so the server and the carryover lane
// cannot drift apart on which types are never carried over.
const TaskTypes = require("./public/js/task-types");

// ── Workspace Bootstrap ──

async function ensureWorkspacesForAllUsers() {
  const { rows: users } = await pool.query("SELECT * FROM users");
  if (users.length === 0) return;
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const user of users) {
      if (!user.username) continue; // skip users without a DCC username (e.g. audit-angel users)
      const workspaceId = `ws-${user.id}`;
      const { rows: wsRows } = await client.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId]);
      if (wsRows.length === 0) {
        await client.query(
          `INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, 'free', $5, $6)`,
          [workspaceId, `${user.username}'s workspace`, user.username, user.id, now, now]
        );
        console.log(`[workspace] Created workspace ${workspaceId} for user '${user.username}'`);
      }
      const { rows: memberRows } = await client.query("SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, user.id]);
      if (memberRows.length === 0) {
        await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at, created_at) VALUES ($1, $2, 'owner', $3, $4)`, [workspaceId, user.id, now, now]);
      }
      const blocksResult = await client.query("UPDATE blocks SET workspace_id = $1 WHERE user_id = $2 AND workspace_id IS NULL", [workspaceId, user.id]);
      if (blocksResult.rowCount > 0) console.log(`[workspace] Stamped workspace_id on ${blocksResult.rowCount} blocks for '${user.username}'`);
      const dccResult = await client.query("UPDATE dcc_state SET workspace_id = $1 WHERE user_id = $2 AND workspace_id IS NULL", [workspaceId, user.id]);
      if (dccResult.rowCount > 0) console.log(`[workspace] Stamped workspace_id on ${dccResult.rowCount} dcc_state rows for '${user.username}'`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Block Type Validation ──

// ── Unified Block Architecture ──
// All user data uses type = 'block'. Properties JSONB is freeform.
// Code interprets blocks by checking property presence, not type labels.
// Legacy type names ('added_task', 'schedule_item', etc.) accepted for backward compat.
const BLOCK_SCHEMAS = { block: { required: [], optional: [] }, day_root: { required: ["date"], optional: [] } };
const VALID_TYPES = new Set(["block", "day_root",
  // time_entry — actual time-tracking segments (planned-vs-actual day review).
  // Stored under the day_root with a date, so it loads with getBlocksByDate/range.
  "time_entry",
  // Legacy types — accepted during migration transition, all treated as 'block'
  "schedule_item", "consider_item", "triage_item", "note", "action_item", "subtask",
  "pomo_state", "pomo_session", "engram", "mood_entry", "sticky_note", "trivial_task",
  "life_capture", "pending_task", "added_task", "schedule_block", "tag"
]);

function validateBlock(type, properties) {
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown block type: ${type}`);
  const size = JSON.stringify(properties).length;
  if (size > 100000) throw new Error(`Block properties exceed 100KB limit (${size} bytes)`);
}

// ── Block CRUD ──

// Postgres returns DATE columns as JS Date objects, which JSON-stringify to
// "YYYY-MM-DDT00:00:00.000Z". Clients compare block.date to the "YYYY-MM-DD"
// they pass in, so round-tripping the timestamp would silently drop every
// same-day block. Normalize to the bare date string here.
function normalizeDate(v) {
  if (!v) return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function parseBlock(row) {
  if (!row) return null;
  return {
    ...row,
    date: normalizeDate(row.date),
    properties: typeof row.properties === "string" ? JSON.parse(row.properties) : (row.properties || {}),
  };
}

// ── Canonical task model: create-time dual-write (Phase A1) ──
//
// Nothing reads these values yet; later phases flip the read paths one at a time.
// Keep it that way: a read-path change belongs in a later phase, not here.
//
// DELIBERATELY NOT STAMPED: properties.local_id.
// The plan called for stamping `local_id = id` on every task row as a
// "version-skew shield" so an old client bundle keeps resolving its lookups. That
// shield already exists and costs nothing: the client ALREADY falls back to the row
// id when local_id is absent — `persistence.js:274` is
// `const taskId = p.local_id || block.id;` ("API task blocks have no local_id; key
// on the row id"), and sync.js:360/369/380 do the same. So the invariant holds
// without writing anything.
//
// Worse, writing it is NOT inert. `persistence.js:262` admits a row into the
// itinerary fold when it has a local_id:
//   if(!p.local_id && p.kind!=="task" && !isShell && !isMeetingBlock) return false;
// In this codebase local_id does double duty as an identifier AND as the client's
// "this is a task, render it" flag, so stamping one onto a meeting transcript or an
// unapproved proposal silently promotes it to a task. Measured on a prod restore:
// the backfill made 245 non-task rows foldable, including 70 meeting-prep docs and
// 4 dateless rows that would appear on EVERY day viewed.
// See migrations/001_canonical_model.sql, "Step 1 (removed)".

// Is this row a "task" for canonical-model purposes? JS twin of the SQL
// dcc_is_task_row (pg-schema.js POST_SCHEMA_STATEMENTS) — the exclusion list is
// stated in both places and MUST stay in sync, so change them together.
// Exclusions: containers (day_root), time-tracking segments (time_entry), standing
// lists (delegated_item), responsibility scaffolding (responsibility*), group
// templates (task_group), move tombstones (reschedule_tombstone), and Slack
// reaction-order tombstones (slack_reaction_tombstone).
// Shells and meetings ARE task rows.
// `triage_suppression` joins the list for the same reason `reschedule_tombstone` is
// on it: it is a dateless bookkeeping row, not work. Left off, `isTaskRow` would be
// true for it, which costs a `nextSortOrderForDay` round trip per create AND walks
// the shared dateless sort space forward — the space the BACKLOG lives in (#268:
// date IS NULL is the Backlog). It would also get `status: "open"` stamped on it.
// It stays out of the client's Unscheduled list either way (TaskModel.selectUnscheduled
// requires a `title`, and suppressions deliberately store theirs as `itemTitle`), so
// this is about not polluting the task space rather than about a visible bug.
const NON_TASK_KINDS = new Set(["delegated_item", "task_group", "reschedule_tombstone", "triage_suppression", "slack_reaction_tombstone"]);
function isTaskRow(block) {
  if (!block) return false;
  const type = block.type;
  if (type === "day_root" || type === "time_entry") return false;
  const kind = ((block.properties || {}).kind) || "";
  if (NON_TASK_KINDS.has(kind)) return false;
  if (kind.startsWith("responsibility")) return false;
  return true;
}

// A day_root id is `day-root-<workspace>-<date>` or the legacy `day-root-<date>`
// (see ensureDayRoot), so "is my parent just my container?" is a string test — no
// extra query on the create path.
function isDayRootId(id) {
  return typeof id === "string" && id.startsWith("day-root-");
}

// Resolve a subtaskOf/wrapId reference into a real parent row id, or null when it is
// unresolvable OR ambiguous. Ambiguity is real: legacy local_ids are Date.now()-based
// and collide. Returning null leaves the row a root — exactly today's flat behavior,
// never worse — where guessing would silently re-parent someone's task.
// Shares ONE definition with the migration and the audit via the SQL function.
//
// The SAVEPOINT is load-bearing, not defensive noise. `dcc_resolve_local_id` is
// created by pg-schema's post-schema pass, which is non-fatal per statement by
// design, so a missing function is a REACHABLE trigger. Inside a caller's
// transaction a failed statement puts Postgres in the aborted state (25P02) and
// every later statement fails until rollback, so a bare try/catch here would turn
// "the edge could not be resolved" into "the whole batchOp died" — the exact
// opposite of what the catch promises. The savepoint keeps the failure local.
async function resolveParentRef(q, { ref, workspaceId, date, selfId }, inTx) {
  if (!ref) return null;
  if (inTx) {
    try { await q.query("SAVEPOINT dcc_resolve_ref"); } catch { return null; }
  }
  try {
    const { rows } = await q.query(
      "SELECT dcc_resolve_local_id($1, $2, $3) AS pid",
      [workspaceId || null, date || null, String(ref)]
    );
    if (inTx) await q.query("RELEASE SAVEPOINT dcc_resolve_ref");
    const pid = rows[0] && rows[0].pid;
    return pid && pid !== selfId ? pid : null;
  } catch (err) {
    // A create must never fail because the edge can't be resolved: leave parent_id
    // alone and the row is a root, as it is today.
    if (inTx) await q.query("ROLLBACK TO SAVEPOINT dcc_resolve_ref").catch(() => {});
    console.error(`[createBlock] parent resolution skipped: ${err.message}`);
    return null;
  }
}

// ══════════════════════ C6c: ONE `sort_order` NUMBER SPACE ══════════════════════
//
// `sort_order` is the itinerary's only persisted order (C6b moved pins and locks onto the row and
// left the three order LISTS on their day_root overlays precisely because this column was NOT one
// space). Measured on prod before this phase, over 1815 live task rows: **231** carried the
// 1000-spaced values a drag writes, **1005** carried minutes-of-day 0..1439 (`createItineraryTask`
// below), **289** were exactly 0 (this function's old `sort_order || 0` default), and 290 were
// other. **63 of 113 days held a mix**, so reading the column as the order would have sorted every
// server-created and every newly-added task ahead of everything the user had ever dragged.
//
// The rule now: **every writer uses ONE space, 1000-spaced, per (date, workspace).** A create with
// no explicit order lands at the END of its day, which is also the only correct UX -- a new task
// must not jump to the top of a half-finished day.
//
// Scoped to task rows and to the row's own (date, workspace) so a day_root, a time_entry or another
// tenant's rows cannot influence the number. A dateless row (the Backlog) shares one space, which is
// correct: it is day-agnostic by definition.
const SORT_STEP = 1000;
async function nextSortOrderForDay(q, { date, workspace_id }) {
  const { rows } = await q.query(
    `SELECT COALESCE(MAX(sort_order), 0) AS mx
       FROM blocks
      WHERE deleted_at IS NULL
        AND date IS NOT DISTINCT FROM $1
        AND workspace_id IS NOT DISTINCT FROM $2
        AND dcc_is_task_row(type, properties)`,
    [date || null, workspace_id || null]
  );
  const mx = Number(rows[0] && rows[0].mx) || 0;
  // Round UP to the next step so a legacy minutes-of-day value (0..1439) cannot leave the next
  // create colliding with it, and so the space stays readable.
  return (Math.floor(mx / SORT_STEP) + 1) * SORT_STEP;
}

async function createBlock({ id, type, parent_id, date, properties, sort_order, user_id, workspace_id }, client) {
  const blockId = id || crypto.randomUUID();
  const now = new Date().toISOString();
  // Copy rather than alias: this function now WRITES into props, and callers reuse a
  // single properties object across creates. responsibility-store.js applyForwardDiff
  // pushes the same `c.block.properties` reference once per future date into one
  // batchOp, so mutating in place would give N rows one row's stamped values.
  const props = typeof properties === "string" ? JSON.parse(properties) : { ...(properties || {}) };
  validateBlock(type, props);
  const q = client || pool;

  // C6c: no explicit order -> the END of this row's day, in the one 1000-spaced space. The old
  // default was `sort_order || 0`, which put every create at the head of the day and produced 289
  // of the 289 zeros on prod. Only task rows participate; a day_root or time_entry keeps 0, which
  // is what it has always had and what nothing orders by.
  // `== null` ONLY. Treating an explicit 0 as "unset" cannot distinguish "the caller said nothing"
  // from "the caller said FIRST", and three callers pass a 0-based loop index
  // (server.js seedScheduleBlocksFromYAML, schedule-tab.js _applyBlocksToday, sync.js
  // savePendingTasks) -- so item 0 would have been appended AFTER items 1..N-1. Those three are
  // converted to 1000-spaced in the same change.
  let sortOrderToUse = sort_order;
  if (sortOrderToUse == null && isTaskRow({ type, properties: props })) {
    sortOrderToUse = await nextSortOrderForDay(q, { date, workspace_id });
  }

  let parentId = parent_id || null;
  if (isTaskRow({ type, properties: props })) {
    if (props.status == null) props.status = "open";
    const ref = props.subtaskOf != null ? props.subtaskOf : props.wrapId;
    if (ref != null) {
      if (props.rel == null) props.rel = props.subtaskOf != null ? "subtask" : "ride_along";
      // Only claim parent_id when it holds nothing more specific than the row's
      // container. An explicit non-day_root parent was chosen deliberately.
      //
      // Two readers of a day_root's children exist, and neither breaks: the route
      // GET /api/blocks/:id/children has no caller anywhere, and reorderBlocks'
      // rebalance selects siblings by parent_id (db.js reorderBlocks) — which for an
      // itinerary task means "every task on that day". Repointing a subtask narrows
      // that rebalance to its parent's children. Harmless today because the branch
      // only fires when two items in one payload land within 0.001 and both
      // producers (schedule.js saveTaskOrder, persistence.js saveSubtaskOrder) send
      // (i+1)*1000, but it IS a second reader: do not repeat the claim that there is
      // only one.
      if (parentId === null || isDayRootId(parentId)) {
        parentId = await resolveParentRef(
          q, { ref, workspaceId: workspace_id, date, selfId: blockId }, !!client
        ) || parentId;
      }
    }
    validateBlock(type, props);
  }

  // ON CONFLICT (id) DO NOTHING makes a create with a CALLER-MINTED id idempotent:
  // replay the same create and you get the same row back instead of a 23505 that
  // aborts the caller's whole transaction. This is what B2 needs before the client
  // can mint its own ids — a lost ack today produces a duplicate task, because the
  // replay lands with a fresh server UUID and nothing links the two.
  //
  // DO NOTHING returns zero rows on a collision, so the SELECT below is what
  // actually answers the request. It is workspace-scoped on purpose, and that
  // scoping is load-bearing rather than tidy: ids here are caller-controlled and
  // guessable (day roots are literally `day-root-<workspace>-<date>`), so the
  // obvious `WHERE id = $1` would turn the create path into a cross-workspace READ
  // — post a create with a foreign id, get that row's contents back. Raised by
  // Track B against this exact line before it was written; it is the read-side twin
  // of the batch write hole #260 closed.
  //
  // A collision the caller does not own therefore FAILS rather than returning
  // anything, and fails as 404 "Block not found" to match assertBlockOwnership —
  // a 409 would confirm that the id exists, which is the fact being withheld.
  let inserted;
  try {
    inserted = await q.query(
      `INSERT INTO blocks (id, type, parent_id, date, properties, sort_order, user_id, workspace_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [blockId, type, parentId, date || null, props, sortOrderToUse || 0, user_id || null, workspace_id || null, now, now]
    );
  } catch (err) {
    // A3's UNIQUE idempotency index fired: another writer committed this key in the
    // window between the caller's dedupe lookup and this insert. Four routes create
    // keyed rows (quick-task, the two Day-in-Review writers, Slack reactions) and
    // every one of them already looks the key up first, so without this they would
    // answer a double-click with a 500 where they used to answer with a duplicate.
    // Resolving it HERE covers all four and anything added later, rather than four
    // copies of the same catch.
    //
    // Only outside a caller-supplied transaction. Inside one the error has already
    // aborted the tx, so no further query on that client can succeed and recovery is
    // necessarily the caller's — which is what routes/blocks.js /batch does by
    // re-resolving and re-running the whole batch.
    //
    // The row is always LIVE: the index is partial on `deleted_at IS NULL`, so a
    // tombstone never reserves its key and could not have raised this.
    if (client || !isIdempotencyConflict(err)) throw err;
    // snake_case ONLY, deliberately. idx_blocks_idem_unique indexes
    // properties->>'idempotency_key' and findByIdempotencyKey queries that field, so a
    // camelCase alias here could never name the key that raised this conflict — and at
    // the route layer it would hand a caller route-level dedupe with no index backstop,
    // i.e. silent best-effort idempotency for a key the database is not enforcing. The
    // dual-spelling normalization routes/dcc.js does is on the request BODY, one layer
    // up; by the time a key reaches the properties bag there is one spelling.
    const key = props.idempotency_key || null;
    const winner = key ? await findByIdempotencyKey(workspace_id || null, String(key)) : null;
    if (!winner) throw err;
    return { ...winner, _resolvedExisting: true };
  }
  if (!inserted.rows.length) {
    const { rows: found } = await q.query(
      "SELECT * FROM blocks WHERE id = $1 AND workspace_id IS NOT DISTINCT FROM $2",
      [blockId, workspace_id || null]
    );
    if (!found.length) { const err = new Error("Block not found"); err.statusCode = 404; throw err; }
    // No operations row: nothing was created, so the op log must not claim one.
    // Tombstone-inclusive, deliberately — the caller gets the row as it stands and
    // deleted_at tells it the truth. Refusing to resurrect is the route layer's
    // rule (lib/materialize-guard.js), not this primitive's.
    //
    // `_resolvedExisting` says "this row was found, not inserted". Callers that broadcast a
    // create, log an operation, or award points need that distinction, and inferring
    // it from timestamps is exactly the guesswork that produces phantom events.
    return { ...parseBlock(found[0]), _resolvedExisting: true };
  }
  await q.query(`INSERT INTO operations (block_id, op_type, after_data, timestamp) VALUES ($1, 'create', $2, $3)`, [blockId, props, now]);
  return { id: blockId, type, parent_id: parentId, date: date || null, properties: props, sort_order: sortOrderToUse || 0, created_at: now, updated_at: now, deleted_at: null };
}

// `client` lets a caller run this inside its own transaction (batchOp,
// rescheduleBlocks-style tx work). Without one, updateBlock owns a short
// transaction so the read/merge/write lifecycle stays under one row lock.
// Completion is a state transition, not an incidental member of a properties bag.
// Most callers still update that bag as a full replacement, and some reconcilers run
// after reading a slightly older copy of the row. Without this guard, any one of those
// writers can replace a just-completed task with its stale `status:"open"` snapshot.
//
// Normal writes therefore preserve an existing task completion. The two deliberate
// directions must identify themselves: completion writers pass `complete`, and their
// explicit undo paths pass `reopen`.
function isCompletedTaskProps(props) {
  const p = props || {};
  return p.status === "done" || p.done === true || p.completed === true || !!p.completedAt || !!p.doneAt;
}

function completedProps(props, existing, now, mutationId) {
  const prior = existing || {};
  const transition = !isCompletedTaskProps(prior);
  const next = { ...(props || {}) };
  next.status = "done";
  next.done = true;
  for (const key of ["completed", "completedAt", "doneAt", "completedBy"]) {
    if (prior[key] !== undefined) next[key] = prior[key];
  }
  if (!next.completedAt && !next.doneAt) next.completedAt = now;
  next._completionRevision = transition ? crypto.randomUUID() : (prior._completionRevision || crypto.randomUUID());
  next._completionMutationId = transition
    ? (mutationId || crypto.randomUUID())
    : (prior._completionMutationId || mutationId || crypto.randomUUID());
  return next;
}

function reopenedProps(props, existing, mutationId) {
  const prior = existing || {};
  const transition = isCompletedTaskProps(prior);
  const next = { ...(props || {}) };
  next.status = next.status && next.status !== "done" ? next.status : "open";
  delete next.done;
  delete next.completed;
  delete next.completedAt;
  delete next.doneAt;
  delete next.completedBy;
  next._completionRevision = transition ? crypto.randomUUID() : (prior._completionRevision || crypto.randomUUID());
  next._completionMutationId = transition
    ? (mutationId || crypto.randomUUID())
    : (prior._completionMutationId || mutationId || crypto.randomUUID());
  return next;
}

const COMPLETION_PROP_KEYS = ["status", "done", "completed", "completedAt", "doneAt", "completedBy", "_completionRevision", "_completionMutationId"];
function preserveCompletionProps(props, existing) {
  if (!isCompletedTaskProps(props) && !isCompletedTaskProps(existing)) {
    const next = { ...(props || {}) };
    delete next._completionRevision;
    delete next._completionMutationId;
    if (existing && existing._completionRevision !== undefined) {
      next._completionRevision = existing._completionRevision;
    }
    if (existing && existing._completionMutationId !== undefined) {
      next._completionMutationId = existing._completionMutationId;
    }
    return next;
  }
  const next = { ...(props || {}) };
  for (const key of COMPLETION_PROP_KEYS) delete next[key];
  for (const key of COMPLETION_PROP_KEYS) {
    if (existing && existing[key] !== undefined) next[key] = existing[key];
  }
  return next;
}

function applyCompletionIntent(existingProps, proposedProps, completionIntent, now, taskRow, completionMutationId) {
  if (!taskRow || !proposedProps) return proposedProps;
  if (completionIntent !== undefined && completionIntent !== "complete" && completionIntent !== "reopen") {
    throw new Error("Invalid completion intent");
  }
  if (completionIntent === "reopen") return reopenedProps(proposedProps, existingProps, completionMutationId);
  if (completionIntent === "complete") return completedProps(proposedProps, existingProps, now, completionMutationId);
  // Completion fields are owned by the durable row, in either direction. This
  // prevents both halves of the lost-update race: an old open snapshot cannot undo
  // a completion, and an old done snapshot cannot undo an explicit reopen.
  return preserveCompletionProps(proposedProps, existingProps);
}

function taskCompletionError(message, statusCode, publicCode, currentTask) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicCode = publicCode;
  if (currentTask) error.currentTask = currentTask;
  return error;
}

function validateTaskCompletionInput({ taskRef, completed, completedAt, taskDate, mutationId, expectedRevision }) {
  if (!taskRef || typeof taskRef !== "string" || taskRef.length > 256) {
    throw taskCompletionError("A valid task reference is required", 400, "COMPLETION_TASK_REQUIRED");
  }
  if (typeof completed !== "boolean") {
    throw taskCompletionError("completed must be a boolean", 400, "COMPLETION_STATE_REQUIRED");
  }
  if (!mutationId || typeof mutationId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(mutationId)) {
    throw taskCompletionError("A valid completion mutation id is required", 400, "COMPLETION_MUTATION_REQUIRED");
  }
  if (taskDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(taskDate))) {
    throw taskCompletionError("taskDate must be YYYY-MM-DD", 400, "COMPLETION_DATE_INVALID");
  }
  if (completedAt != null && !Number.isFinite(Date.parse(completedAt))) {
    throw taskCompletionError("completedAt must be an ISO timestamp", 400, "COMPLETION_TIME_INVALID");
  }
  if (expectedRevision != null
      && (typeof expectedRevision !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(expectedRevision))) {
    throw taskCompletionError("Invalid completion revision", 400, "COMPLETION_REVISION_INVALID");
  }
}

function completionWalkableRow(block) {
  if (!block || block.type !== "block" || block.deleted_at) return false;
  const props = block.properties || {};
  return !!props.local_id || props.kind === "task";
}

function collectCompletionSubtreeIds(rows, parent) {
  const parentLocalId = parent && parent.properties && parent.properties.local_id;
  const localIds = new Set(parentLocalId ? [String(parentLocalId)] : []);
  const rowIds = new Set(parent && parent.id ? [String(parent.id)] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!row || rowIds.has(String(row.id))) continue;
      const props = row.properties || {};
      // Ride-alongs use wrapId and remain independent work. The UI promotes them
      // out of a completed parent instead of completing them.
      if (props.wrapId && !props.subtaskOf) continue;
      const joined = (props.subtaskOf && localIds.has(String(props.subtaskOf)))
        || (row.parent_id && rowIds.has(String(row.parent_id)));
      if (!joined) continue;
      rowIds.add(String(row.id));
      if (props.local_id) localIds.add(String(props.local_id));
      changed = true;
    }
  }
  return rowIds;
}

// The durable completion boundary. Completion owns a small set of task fields and
// never replaces a caller's full properties snapshot. The target and its task
// descendants are locked and written in one transaction, so a completed parent
// cannot commit while one of its steps remains open.
async function setTaskCompletion({
  taskRef, completed, completedAt = null, taskDate = null, mutationId,
  expectedRevision = null, userId = null, workspaceId = null,
}) {
  validateTaskCompletionInput({ taskRef, completed, completedAt, taskDate, mutationId, expectedRevision });
  const q = await pool.connect();
  const at = completed ? (completedAt || new Date().toISOString()) : null;
  const now = new Date().toISOString();
  let beforeRows = [];
  let affected = [];
  let overlayBroadcastId = null;
  let target = null;
  try {
    await q.query("BEGIN");

    let { rows: directRows } = await q.query(
      `SELECT * FROM blocks
        WHERE id = $1 AND deleted_at IS NULL
          AND workspace_id IS NOT DISTINCT FROM $2
        FOR UPDATE`,
      [taskRef, workspaceId]
    );
    target = directRows[0] ? parseBlock(directRows[0]) : null;

    if (!target) {
      const params = [taskRef, workspaceId];
      let dateClause = "";
      if (taskDate) { params.push(taskDate); dateClause = " AND date = $3"; }
      const { rows } = await q.query(
        `SELECT * FROM blocks
          WHERE properties->>'local_id' = $1 AND deleted_at IS NULL
            AND workspace_id IS NOT DISTINCT FROM $2${dateClause}
          ORDER BY updated_at DESC, id ASC
          FOR UPDATE`,
        params
      );
      if (rows.length > 1) {
        throw taskCompletionError("Task reference is ambiguous", 409, "COMPLETION_TARGET_AMBIGUOUS");
      }
      target = rows[0] ? parseBlock(rows[0]) : null;
    }

    if (!target) {
      if (!taskDate) throw taskCompletionError("Task not found", 404, "COMPLETION_TARGET_NOT_FOUND");
      const rootId = await ensureDayRoot(taskDate, userId, workspaceId, q);
      const { rows } = await q.query("SELECT * FROM blocks WHERE id = $1 FOR UPDATE", [rootId]);
      const root = rows[0] ? parseBlock(rows[0]) : null;
      if (!root) throw taskCompletionError("Day container not found", 404, "COMPLETION_LEGACY_ROOT_NOT_FOUND");
      const rootProps = { ...(root.properties || {}) };
      const done = { ...((rootProps._done && typeof rootProps._done === "object") ? rootProps._done : {}) };
      const ids = Array.isArray(done.ids) ? done.ids.map(String) : [];
      const timestamps = { ...((done.at && typeof done.at === "object") ? done.at : {}) };
      const revisions = { ...((done.revisions && typeof done.revisions === "object") ? done.revisions : {}) };
      const mutations = { ...((done.mutations && typeof done.mutations === "object") ? done.mutations : {}) };
      const key = String(taskRef);
      const alreadyApplied = mutations[key] === mutationId
        && (completed ? ids.includes(key) : !ids.includes(key));
      const currentRevision = revisions[key] || null;
      if (!alreadyApplied && (expectedRevision || null) !== currentRevision) {
        throw taskCompletionError("Task completion changed since this edit was created", 409,
          "COMPLETION_CONFLICT", { id: key, date: taskDate, properties: { status: ids.includes(key) ? "done" : "open", _completionRevision: currentRevision } });
      }
      if (!alreadyApplied) {
        const nextIds = ids.filter(id => id !== key);
        if (completed) nextIds.push(key);
        if (completed) timestamps[key] = at; else delete timestamps[key];
        revisions[key] = crypto.randomUUID();
        mutations[key] = mutationId;
        rootProps._done = { ...done, ids: nextIds, at: timestamps, revisions, mutations };
        await q.query(
          "UPDATE blocks SET properties = $1, updated_at = $2 WHERE id = $3",
          [rootProps, now, root.id]
        );
        await q.query(
          `INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp)
           VALUES ($1, 'completion', $2, $3, $4)`,
          [root.id, root.properties, rootProps, now]
        );
      }
      await q.query("COMMIT");
      const revision = alreadyApplied ? currentRevision : revisions[key];
      return {
        task: { id: key, type: "legacy_task", date: taskDate, properties: {
          status: completed ? "done" : "open", ...(completed ? { done: true, completedAt: at } : {}),
          _completionRevision: revision, _completionMutationId: mutationId,
        } },
        affectedTasks: [], revision, persistenceTarget: "legacy_overlay",
        duplicate: alreadyApplied, broadcastIds: [root.id],
      };
    }

    if (target.type === "day_root" || !isTaskRow(target)) {
      throw taskCompletionError("The referenced block is not a task", 400, "COMPLETION_TARGET_INVALID");
    }

    const currentProps = target.properties || {};
    const currentRevision = currentProps._completionRevision || null;
    const sameMutation = currentProps._completionMutationId === mutationId
      && isCompletedTaskProps(currentProps) === completed;
    if (!sameMutation && (expectedRevision || null) !== currentRevision) {
      throw taskCompletionError("Task completion changed since this edit was created", 409,
        "COMPLETION_CONFLICT", target);
    }
    if (sameMutation) {
      await q.query("COMMIT");
      return {
        task: target, affectedTasks: [target], revision: currentRevision,
        persistenceTarget: "task_row", duplicate: true, broadcastIds: [target.id],
      };
    }

    let rowsToWrite = [target];
    if (completed) {
      const { rows } = await q.query(
        `SELECT * FROM blocks
          WHERE deleted_at IS NULL AND workspace_id IS NOT DISTINCT FROM $1
            AND date IS NOT DISTINCT FROM $2::date
          FOR UPDATE`,
        [workspaceId, target.date || null]
      );
      const poolRows = rows.map(parseBlock).filter(completionWalkableRow);
      const ids = collectCompletionSubtreeIds(poolRows, target);
      rowsToWrite = [target, ...poolRows.filter(row => row.id !== target.id && ids.has(row.id))];
    }

    beforeRows = rowsToWrite.map(row => ({ ...row, properties: { ...(row.properties || {}) } }));
    for (const row of rowsToWrite) {
      const before = row.properties || {};
      let props = completed
        ? completedProps(before, before, at, mutationId)
        : reopenedProps(before, before, mutationId);
      // Idempotency belongs to the request, including a same-state request. The
      // generic completion helpers intentionally preserve the prior mutation on a
      // no-op transition, so the dedicated endpoint stamps its own identity here.
      props._completionMutationId = mutationId;
      if (completed && userId != null) props.completedBy = String(userId);
      let date = row.date || null;
      if (completed && !date && taskDate) {
        date = taskDate;
        props._doneStampedDate = taskDate;
        if (props.kind === "backlog") { delete props.kind; props._wasBacklog = true; }
      } else if (!completed && date && props._doneStampedDate === date) {
        date = null;
        delete props._doneStampedDate;
        if (props._wasBacklog) { props.kind = "backlog"; delete props._wasBacklog; }
      }
      const { rows: written } = await q.query(
        `UPDATE blocks SET properties = $1, date = $2, updated_at = $3
          WHERE id = $4 RETURNING *`,
        [props, date, now, row.id]
      );
      const parsed = parseBlock(written[0] || { ...row, properties: props, date, updated_at: now });
      affected.push(parsed);
      await q.query(
        `INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp)
         VALUES ($1, 'completion', $2, $3, $4)`,
        [row.id, before, props, now]
      );
    }

    // Reopening also clears any legacy overlay that can still make the read path
    // project this canonical row as done after refresh. This stays inside the same
    // transaction as the row transition, so the two sources cannot disagree.
    if (!completed && (target.date || taskDate)) {
      const overlayDate = target.date || taskDate;
      const { rows: roots } = await q.query(
        `SELECT * FROM blocks WHERE type = 'day_root' AND date = $1
          AND deleted_at IS NULL AND workspace_id IS NOT DISTINCT FROM $2
          FOR UPDATE`,
        [overlayDate, workspaceId]
      );
      if (roots[0]) {
        const root = parseBlock(roots[0]);
        const rootProps = { ...(root.properties || {}) };
        const done = { ...((rootProps._done && typeof rootProps._done === "object") ? rootProps._done : {}) };
        const keys = new Set([taskRef, target.id, (target.properties || {}).local_id].filter(Boolean).map(String));
        const ids = Array.isArray(done.ids) ? done.ids.map(String) : [];
        const timestamps = { ...((done.at && typeof done.at === "object") ? done.at : {}) };
        const nextIds = ids.filter(id => !keys.has(id));
        let changed = nextIds.length !== ids.length;
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(timestamps, key)) { delete timestamps[key]; changed = true; }
        }
        if (changed) {
          rootProps._done = { ...done, ids: nextIds, at: timestamps };
          await q.query("UPDATE blocks SET properties = $1, updated_at = $2 WHERE id = $3", [rootProps, now, root.id]);
          await q.query(
            `INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp)
             VALUES ($1, 'completion-overlay-clear', $2, $3, $4)`,
            [root.id, root.properties, rootProps, now]
          );
          overlayBroadcastId = root.id;
        }
      }
    }
    await q.query("COMMIT");
  } catch (error) {
    try { await q.query("ROLLBACK"); } catch { /* preserve completion error */ }
    throw error;
  } finally {
    q.release();
  }

  // Cadence propagation is deliberately outside the task transaction and remains
  // non-fatal, matching updateBlock's existing completion contract.
  for (let i = 0; i < affected.length; i++) {
    const row = affected[i];
    const before = beforeRows.find(item => item.id === row.id);
    await propagateResponsibilityDone({
      id: row.id, before: before && before.properties, after: row.properties, at: now,
      date: row.date, workspaceId, completionRevision: row.properties && row.properties._completionRevision,
    });
  }
  const task = affected.find(row => row.id === target.id) || affected[0];
  return {
    task, affectedTasks: affected, revision: task && task.properties && task.properties._completionRevision,
    persistenceTarget: "task_row", duplicate: false,
    broadcastIds: [...affected.map(row => row.id), ...(overlayBroadcastId ? [overlayBroadcastId] : [])],
  };
}

async function updateBlock(id, fields, client) {
  const {
    properties, sort_order, parent_id, date, completionIntent,
    completionMutationId, completionBaseRevision,
  } = fields;
  if (completionIntent !== undefined && completionIntent !== "complete" && completionIntent !== "reopen") {
    throw new Error("Invalid completion intent");
  }
  if (completionMutationId !== undefined
      && (typeof completionMutationId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(completionMutationId))) {
    const error = new Error("Invalid completion mutation id");
    error.statusCode = 400;
    throw error;
  }
  if (completionBaseRevision !== undefined && completionBaseRevision !== null
      && (typeof completionBaseRevision !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(completionBaseRevision))) {
    const error = new Error("Invalid completion base revision");
    error.statusCode = 400;
    throw error;
  }
  // A row lock is the database boundary for this state transition. When no caller
  // owns a transaction, own one here so the read, property merge, write, and operation
  // record all observe the same completion state. Callers such as batchOp already pass
  // their transaction client and inherit the same FOR UPDATE lock.
  const ownsTransaction = !client && typeof pool.connect === "function";
  const q = ownsTransaction ? await pool.connect() : (client || pool);
  const now = new Date().toISOString();
  let existing;
  let writtenProps;
  let result;
  try {
    if (ownsTransaction) await q.query("BEGIN");
    const { rows } = await q.query("SELECT * FROM blocks WHERE id = $1 FOR UPDATE", [id]);
    existing = rows[0];
    if (!existing) throw new Error(`Block not found: ${id}`);
    if (existing.deleted_at) throw new Error(`Block is deleted: ${id}`);
    if (completionIntent && Object.prototype.hasOwnProperty.call(fields, "completionBaseRevision")) {
      const currentProps = existing.properties || {};
      const currentRevision = currentProps._completionRevision || null;
      const targetDone = completionIntent === "complete";
      const sameMutation = !!(completionMutationId
        && currentProps._completionMutationId === completionMutationId
        && isCompletedTaskProps(currentProps) === targetDone);
      if (!sameMutation && (completionBaseRevision || null) !== currentRevision) {
        const conflict = new Error("Task completion changed since this edit was created");
        conflict.statusCode = 409;
        conflict.publicCode = "COMPLETION_CONFLICT";
        throw conflict;
      }
    }
    let newProps = existing.properties;
    if (properties !== undefined) {
      const parsed = typeof properties === "string" ? JSON.parse(properties) : properties;
      validateBlock(existing.type, parsed);
      newProps = applyCompletionIntent(existing.properties, parsed, completionIntent, now,
        isTaskRow({ type: existing.type, properties: existing.properties }), completionMutationId);
    }
  // C6c: this is the OTHER day-changing writer, and the most-used one -- PATCH /api/blocks/:id is how
  // every promote/unschedule goes (state.js scheduleRowOnDay / unscheduleRow -> _writeRowDate).
  // Keeping the old number across a date change meant a Backlog row promoted onto today arrived
  // carrying the DATELESS space's number and sorted to the front of the day, which also steals the
  // earliest cascade slot and re-times everything after it. Re-slot into the target day, same rule
  // as rescheduleBlocks.
    let newSortOrder = sort_order !== undefined ? sort_order : existing.sort_order;
    const newParentId = parent_id !== undefined ? parent_id : existing.parent_id;
    const newDate = date !== undefined ? date : existing.date;
    if (sort_order === undefined
        && normalizeDate(newDate) !== normalizeDate(existing.date)
        && isTaskRow({ type: existing.type, properties: typeof newProps === "string" ? JSON.parse(newProps) : newProps })) {
      newSortOrder = await nextSortOrderForDay(q, { date: newDate, workspace_id: existing.workspace_id });
    }
    const { rows: writtenRows } = await q.query(
      `UPDATE blocks SET properties = $1, sort_order = $2, parent_id = $3, date = $4, updated_at = $5 WHERE id = $6 RETURNING properties`,
      [newProps, newSortOrder, newParentId, newDate, now, id]
    );
    writtenProps = writtenRows[0] && writtenRows[0].properties !== undefined
      ? (typeof writtenRows[0].properties === "string" ? JSON.parse(writtenRows[0].properties) : writtenRows[0].properties)
      : newProps;
    await q.query(`INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp) VALUES ($1, 'update', $2, $3, $4)`, [id, existing.properties, writtenProps, now]);
    result = { id, type: existing.type, parent_id: newParentId, date: normalizeDate(newDate), properties: writtenProps, sort_order: newSortOrder, created_at: existing.created_at, updated_at: now, deleted_at: null };
    if (ownsTransaction) await q.query("COMMIT");
  } catch (error) {
    if (ownsTransaction) {
      try { await q.query("ROLLBACK"); } catch { /* preserve the write error */ }
    }
    throw error;
  } finally {
    if (ownsTransaction) q.release();
  }
  // D1 (Track D): if this row is an INSTANCE of a recurring responsibility and it
  // just crossed the done line, reset its definition's cadence here rather than
  // asking four separate UI paths to remember to. See propagateResponsibilityDone.
  await propagateResponsibilityDone({
    id, before: existing.properties, after: writtenProps, at: now, client,
    date: result.date, workspaceId: existing.workspace_id,
    completionRevision: writtenProps && writtenProps._completionRevision,
  });
  return result;
}

// ── Recurrence completion propagation (dcc-canonical-task-model D1) ──
//
// The EAGER half of the one-open-instance invariant. When a block carrying
// properties.responsibilityId flips to done (or back), the responsibility
// definition's cadence clock is reset (or restored) right here, so no caller has
// to remember. Today this fires for the row-level completion writers -- the
// quick-task API and the Slack ✅ timer -- and once C5 makes status='done' the
// universal completion signal it fires for everything.
//
// It is deliberately NOT the only guarantee. Itinerary completions currently
// persist to day_root.properties._done rather than to the task row, so
// responsibility-store's resolveOpenInstances() reconciles from the instance's
// actual persisted state on every responsibilities read. That derived pass is
// what makes the pause safe to rely on; this one just makes it instant.
//
// Two deliberate limits, both covered by that reconciler:
//   - skipped when running inside a CALLER's transaction (batchOp,
//     rescheduleBlocks). A failure there would abort the caller's whole tx and
//     block a task write over a cadence stamp, which is the wrong trade. No
//     tx-borne caller writes task completion today.
//   - never throws. A responsibility row we cannot update must not stop a task
//     from being marked done.
//
// TENANCY: `properties.responsibilityId` is client-supplied on PATCH
// /api/blocks/:id, so the definition it names must be ownership-checked exactly
// like assertBlockOwnership would. Without that check a caller could aim this at
// another workspace's responsibility and either forge a completion (silencing
// their reminder for a full cadence) or stamp an open instance they control onto
// it, which the reconciler would then keep reading as "open" -- a permanent,
// self-sustaining suppression of someone else's recurring work.
async function propagateResponsibilityDone({ id, before, after, at, date, client, workspaceId, completionRevision }) {
  if (client) return;
  let q;
  let ownsTransaction = false;
  try {
    const beforeProps = typeof before === "string" ? JSON.parse(before) : (before || {});
    const afterProps = typeof after === "string" ? JSON.parse(after) : (after || {});
    const respId = afterProps.responsibilityId || beforeProps.responsibilityId;
    if (!respId) return;
    const isDone = isCompletedTaskProps;
    const wasDone = isDone(beforeProps);
    const nowDone = isDone(afterProps);
    if (wasDone === nowDone) return;

    // Completion propagation runs after the task write commits so a broken cadence
    // row cannot block completion. Serialize it through a fresh lock on the task,
    // then verify this transition is still current. Without this check, a delayed
    // completion side effect can land after a newer reopen and clear its restored
    // responsibility pointer.
    ownsTransaction = typeof pool.connect === "function";
    q = ownsTransaction ? await pool.connect() : pool;
    if (ownsTransaction) await q.query("BEGIN");
    const { rows: taskRows } = await q.query("SELECT * FROM blocks WHERE id = $1 FOR UPDATE", [id]);
    const currentTask = taskRows[0];
    const currentProps = currentTask && (currentTask.properties || {});
    if (!currentTask || isDone(currentProps) !== nowDone
        || (completionRevision && currentProps._completionRevision !== completionRevision)) {
      if (ownsTransaction) await q.query("COMMIT");
      return;
    }

    const { rows: definitionRows } = await q.query("SELECT * FROM blocks WHERE id = $1 FOR UPDATE", [respId]);
    const definition = definitionRows[0] ? parseBlock(definitionRows[0]) : null;
    if (!definition || definition.deleted_at) {
      if (ownsTransaction) await q.query("COMMIT");
      return;
    }
    if (definition.workspace_id && workspaceId && definition.workspace_id !== workspaceId) {
      if (ownsTransaction) await q.query("COMMIT");
      return;
    }
    const defProps = definition.properties || {};
    if (defProps.kind !== "responsibility_item") {
      if (ownsTransaction) await q.query("COMMIT");
      return;
    }

    const next = nowDone
      ? recurrence.applyCompletion(defProps, { completedAt: afterProps.completedAt || at, taskId: id })
      // `date` is the block's date COLUMN, threaded in from the caller. Reading it
      // off properties (where it does not live) left openInstanceDate null, which
      // disabled BOTH the day-overlay lookup and the past-dated safety valve and
      // made the restored pause unexpirable.
      : recurrence.applyUncompletion(defProps, { blockId: id, localId: afterProps.local_id || null, date: date || null });

    // Reuse updateBlock rather than hand-rolling the UPDATE + operations pair: it
    // owns that pairing everywhere else in this file. Re-entry is bounded because
    // a responsibility_item carries no responsibilityId of its own, so the nested
    // call returns at the `!respId` guard above.
    await updateBlock(respId, { properties: next }, q);
    if (ownsTransaction) await q.query("COMMIT");
  } catch (e) {
    if (ownsTransaction && q) {
      try { await q.query("ROLLBACK"); } catch { /* preserve non-fatal behavior */ }
    }
    console.warn("[db:propagateResponsibilityDone] non-fatal", e && e.message);
  } finally {
    if (ownsTransaction && q) q.release();
  }
}

async function deleteBlock(id, client) {
  const q = client || pool;
  const now = new Date().toISOString();
  const { rows } = await q.query("SELECT * FROM blocks WHERE id = $1", [id]);
  const existing = rows[0];
  if (!existing) throw new Error(`Block not found: ${id}`);
  await q.query("UPDATE blocks SET deleted_at = $1, updated_at = $2 WHERE id = $3", [now, now, id]);
  await q.query(`INSERT INTO operations (block_id, op_type, before_data, timestamp) VALUES ($1, 'delete', $2, $3)`, [id, existing.properties, now]);
  return { id, deleted_at: now };
}

// ── Canonical task model primitives (Phase A1) ──
//
// Added ALL AT ONCE, deliberately WITH NO CALLERS except the audit endpoint. That is
// what keeps Tracks B, C and D out of db.js entirely, which is what makes the
// parallel tracks safe. Resist deferring one until its consumer needs it.

// Clear a tombstone. This is the server side of undo: because it is a real call and
// not a client-side 8-second timer, an undo survives a reload and a device switch —
// which is exactly what makes immediate deletion SAFER than the timer it replaces.
// Idempotent: undeleting a live row is a no-op that returns the row.
async function undeleteBlock(id, client) {
  const q = client || pool;
  const now = new Date().toISOString();
  const { rows } = await q.query("SELECT * FROM blocks WHERE id = $1", [id]);
  const existing = rows[0];
  if (!existing) throw new Error(`Block not found: ${id}`);
  if (!existing.deleted_at) return parseBlock(existing);
  // Clearing deleted_at moves the row INTO idx_blocks_idem_unique's partial predicate
  // (`... AND deleted_at IS NULL`), so if a live row already holds this key the UPDATE
  // raises 23505 — and a raw one would surface as a 500 from POST /:id/undelete. Not
  // hypothetical: the prod restore has 32 duplicate key groups, every one of them a
  // live row plus tombstones, which is exactly this shape.
  //
  // 409, not a silent success: the tombstone genuinely cannot be restored while its
  // twin is live, and the caller has to be told rather than shown an undo that did
  // nothing. B2 is the phase that wires this route to the client, so it lands there.
  try {
    await q.query("UPDATE blocks SET deleted_at = NULL, updated_at = $1 WHERE id = $2", [now, id]);
  } catch (err) {
    // Same rule as createBlock: inside a caller's transaction the 23505 has already
    // aborted it, so recovery belongs to whoever owns the tx and the raw error must
    // survive. No caller passes a client today; this keeps the two functions from
    // diverging the moment one does.
    if (client || !isIdempotencyConflict(err)) throw err;
    const conflict = new Error("Another live block already holds this idempotency key");
    conflict.statusCode = 409;
    // Carry the classification through. Every recovery site in this phase keys off
    // isIdempotencyConflict(), which reads code + constraint — drop them and a wrapped
    // undelete stops being recognisable as the conflict it is.
    conflict.code = err.code;
    conflict.constraint = err.constraint;
    throw conflict;
  }
  await q.query(
    `INSERT INTO operations (block_id, op_type, before_data, timestamp) VALUES ($1, 'update', $2, $3)`,
    [id, existing.properties, now]
  );
  return parseBlock({ ...existing, deleted_at: null, updated_at: now });
}

// Fetch a row tombstone included. getBlock() happens to behave identically today,
// but the two have DIFFERENT contracts and A2 splits them: the route-level
// GET /api/blocks/:id starts 404-ing on a tombstone, while getBlock stays the
// ownership pre-check for PATCH/DELETE/reschedule — where seeing the deleted row is
// the correct behavior. Call this one when you mean "I want it even if deleted."
async function getBlockIncludingDeleted(id) {
  const { rows } = await pool.query("SELECT * FROM blocks WHERE id = $1", [id]);
  return rows[0] ? parseBlock(rows[0]) : null;
}

// Look up a row by its idempotency key WITHOUT filtering tombstones. The omission is
// the entire point: filtering `AND deleted_at IS NULL` is the resurrection bug —
// delete a quick-task and the next agent retry, finding no live match, recreates it.
// Callers decide what to do with a soft-deleted hit; they must not re-create it.
//
// A LIVE row wins over a tombstone, matching the existing routes/dcc.js findBriefBlock
// (`ORDER BY deleted_at IS NULL DESC`) that later phases will migrate onto this
// function. Ordering by created_at alone would hand back an older user tombstone in
// preference to the live row — and that case is real, because this migration's step 6
// partitions only over live rows, so a pre-existing tombstone can be older than the
// surviving row it shares a key with.
// Did this error come from A3's unique idempotency index (pg-schema.js
// idx_blocks_idem_unique)? The index is the backstop UNDERNEATH the route-level
// dedupe lookup, and it only fires in the window that lookup cannot cover: two
// genuinely concurrent writers holding the same key. A caller that already ran the
// lookup uses this to turn the raw 23505 back into the same "already there" answer,
// instead of surfacing a 500 for a case the API has a defined response for.
//
// Matches on the constraint NAME, not the message — verified against Postgres 17.6
// that a violation of a bare CREATE UNIQUE INDEX (no table constraint behind it)
// still reports the index name in err.constraint.
const IDEM_UNIQUE_INDEX = "idx_blocks_idem_unique";
function isIdempotencyConflict(err) {
  return !!(err && err.code === "23505" && err.constraint === IDEM_UNIQUE_INDEX);
}

async function findByIdempotencyKey(workspaceId, key) {
  if (!key) return null;
  const { rows } = await pool.query(
    `SELECT * FROM blocks
      WHERE properties->>'idempotency_key' = $1
        AND workspace_id IS NOT DISTINCT FROM $2
      ORDER BY (deleted_at IS NULL) DESC, created_at ASC
      LIMIT 1`,
    [String(key), workspaceId || null]
  );
  return rows[0] ? parseBlock(rows[0]) : null;
}

// ── Carryover pool ───────────────────────────────────────────────────────────
// The structural half of the carryover/catch-up lane, moved off the client. This
// REPLACES the zero-caller getOpenTasksBefore A1 added speculatively for this
// phase: that predicate was `type='block' AND status='open'`, which on a prod
// restore returned 1576 rows where the lane shows 47. Measured, C2:
//   - 1137 of them were meetings/breaks/focus, which the client drops via skipType
//   -  264 were finished, because itinerary completion writes day_root._done and
//          NOT the row's status (only quick-task and slack-events set status)
//   -  226 carried no start and were not nested
//   -  and `parent_id IS NULL` as the root test hid 1084 of 1548 real roots,
//          because a root task's parent IS its day_root
// So the predicate below is the client's own, not a simplification of it.
//
// Deliberately NOT here: the done filter. Done-ness still lives in the day_root
// `_done` overlay until C5 collapses completion onto `status`, and this codebase
// already carries four done-predicates that disagree (lib/task-timing isBlockDone,
// lib/recurrence resolveInstanceState, propagateResponsibilityDone, the poller's).
// A fifth, in SQL, is the last thing it needs. The caller reads the overlays this
// returns and applies ONE predicate to roots and children alike.
const CARRYOVER_ROW_TYPES = ["block", "schedule_item", "added_task"];
// Raw calendar block types that never became first-class registry entries. The
// registry owns the rest via isFixed, so this cannot drift from the client's copy
// in unfinished-tasks.js skipType() — same two halves, same source for the first.
const SKIP_RAW_TYPES = ["focus", "focus_time", "free_time", "prep"];
function carryoverSkipTypes() {
  return Array.from(new Set(TaskTypes.fixedTypes().concat(SKIP_RAW_TYPES)));
}

// Every task row dated strictly before `beforeDate` and inside the lookback window,
// plus the day_root overlay slice the caller needs to decide done-ness and locks.
//
// This returns the POOL, not the roots. That distinction is the whole correction the
// review forced, and it is worth stating plainly because the plan said otherwise:
// "roots only, enforced in SQL" sounds safer than it is. A nested row whose parent is
// NOT in the pool has to render top-level -- schedule-tab.js says so outright
// ("standalone work must never disappear") and C1 pinned it with a test -- so
// membership can never depend on the parent qualifying. Seeding from roots and
// walking down dropped exactly those rows: measured on a prod restore, 1 row was
// already unreachable and 158 past-day untimed parents have children, and an untimed
// parent is never a root. `rootsOf()` on the client is what decides rendering, which
// is where that decision has always lived and where the three surfaces share it.
//
// So there is no getSubtree walk here either. Once nested rows are admitted directly,
// the walk could only add descendants from OUTSIDE the window -- rows the old day scan
// physically could not see -- and it was also returning undated and future-dated
// children, which land in `overlays[null]`, read as permanently open, and cannot be
// cleared by any action.
//
// `days` bounds the lookback and may be null for the unbounded sweep behind the
// modal's "Show older". `limit` is a blast-radius guard applied BEFORE the caller's
// done filter, not the lane's MAX_ROWS -- the caller still caps the filtered pool
// exactly as it did when it scanned days itself.
async function getCarryoverPool(workspaceId, beforeDate, opts = {}) {
  const days = opts.days === null ? null : (opts.days || 14);
  const limit = opts.limit || 500;
  const ws = workspaceId || null;

  // dcc_is_task_row excludes `kind LIKE 'responsibility%'`, which is right for the
  // `responsibility_item` scaffolding and WRONG for `responsibility_task`: those are
  // real dated, timed itinerary rows minted by createItineraryTask, and the client
  // scan (which had no kind filter at all) always collected them. 19 exist on the prod
  // restore. They are all finished today, so this is latent rather than live, but an
  // unfinished recurring task is precisely what a carryover lane is for.
  const { rows } = await pool.query(
    `SELECT b.* FROM blocks b
      WHERE b.workspace_id IS NOT DISTINCT FROM $1
        AND b.deleted_at IS NULL
        AND b.type = ANY($4::text[])
        AND (dcc_is_task_row(b.type, b.properties)
             OR COALESCE(b.properties->>'kind', '') = 'responsibility_task')
        AND COALESCE(b.properties->>'type', '') <> ALL($5::text[])
        AND (COALESCE(b.properties->>'start', '') <> ''
             OR b.properties->>'subtaskOf' IS NOT NULL
             OR b.properties->>'wrapId' IS NOT NULL)
        AND b.date IS NOT NULL AND b.date < $2
        AND ($3::int IS NULL OR b.date >= ($2::date - ($3::int * INTERVAL '1 day')))
      ORDER BY b.date DESC, b.sort_order ASC, b.created_at ASC
      LIMIT $6`,
    [ws, beforeDate, days, CARRYOVER_ROW_TYPES, carryoverSkipTypes(), limit]
  );
  const pool_ = rows.map(parseBlock);

  // One overlay read for every date in play, replacing the per-day day_root lookup
  // the client did inside its scan loop. Locks live on the ORIGIN day's day_root
  // (_lockedTasks), never on the block, which is why they have to come from here.
  const dates = Array.from(
    new Set(pool_.map((b) => b.date).filter(Boolean))
  );
  const overlays = {};
  // The raw day_root rows ride along beside the reduced `overlays` slice, because
  // lib/task-timing.js reconcileTiming rebuilds its completion map from day_root rows
  // IN the array it is handed and reads `_done.at` (completionMsOf) as well as
  // `_done.ids`. The slice carries ids only, so a caller that reconciles has to have
  // these. They are NOT part of the lane's rows -- see the route.
  const dayRoots = [];
  if (dates.length) {
    const { rows: rootBlocks } = await pool.query(
      `SELECT * FROM blocks
        WHERE type = 'day_root' AND deleted_at IS NULL
          AND workspace_id IS NOT DISTINCT FROM $1 AND date = ANY($2::date[])`,
      [ws, dates]
    );
    for (const r of rootBlocks) {
      // parseBlock, not a hand-rolled parse: it is the one place in this file that
      // turns a raw row into parsed properties AND a normalized date string. The date
      // half is load-bearing here -- `date` is a real date column, so pg hands back a
      // JS Date, and a Date used as an object key stringifies to "Wed Jul 30 2026 …",
      // which no caller can look up.
      const parsed = parseBlock(r);
      dayRoots.push(parsed);
      const { date, properties: p } = parsed;
      const locked = p._lockedTasks;
      // `_done.ids` only, deliberately. lib/task-timing.js doneIdsFromOverlay also
      // unions `_done.at`, and it is the better long-term reader, but unioning here
      // would mark rows done that the client scan considered open -- a behavior change
      // on a phase whose acceptance criterion is none. C5 owns collapsing these.
      overlays[date] = {
        done: Array.isArray(p._done && p._done.ids) ? p._done.ids : [],
        locked: Array.isArray(locked) ? locked : (locked ? Object.keys(locked) : [])
      };
    }
  }

  return { rows: pool_, overlays, dayRoots, scanned: dates.length };
}

// Every descendant of `rootIds` through parent_id, roots included, live rows only.
// Stops at day_roots in both directions: a day_root is a container, not a task, so
// walking through one would drag in every unrelated task on that date.
// depth-capped because a cycle that slipped in after the migration's scrub must not
// spin this forever.
async function getSubtree(rootIds, workspaceId) {
  const ids = (Array.isArray(rootIds) ? rootIds : [rootIds]).filter(Boolean);
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `WITH RECURSIVE tree AS (
       SELECT b.*, 0 AS depth FROM blocks b
        WHERE b.id = ANY($1::text[])
          AND b.workspace_id IS NOT DISTINCT FROM $2
          AND b.deleted_at IS NULL
          AND b.type <> 'day_root'
       UNION ALL
       SELECT c.*, t.depth + 1 FROM blocks c
         JOIN tree t ON c.parent_id = t.id
        WHERE c.workspace_id IS NOT DISTINCT FROM $2
          AND c.deleted_at IS NULL
          AND c.type <> 'day_root'
          AND t.depth < 32
     )
     SELECT DISTINCT ON (id) * FROM tree ORDER BY id, depth ASC`,
    [ids, workspaceId || null]
  );
  return rows.map(parseBlock);
}

// ── Query ──

async function getBlocksByDate(date, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE workspace_id = $2 AND deleted_at IS NULL
        AND (date = $1 OR (properties->>'all_day' = 'true'
          AND CASE WHEN properties->>'all_day_start' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_start')::date END <= $1
          AND CASE WHEN properties->>'all_day_end' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_end')::date END > $1))
        ORDER BY date ASC, sort_order ASC, created_at ASC`, [date, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE deleted_at IS NULL
        AND (date = $1 OR (properties->>'all_day' = 'true'
          AND CASE WHEN properties->>'all_day_start' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_start')::date END <= $1
          AND CASE WHEN properties->>'all_day_end' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_end')::date END > $1))
        ORDER BY date ASC, sort_order ASC, created_at ASC`, [date]);
  return rows.map(parseBlock);
}

// Like getBlocksByDate but keeps soft-deleted rows. The meeting materializer
// needs these: a meeting the user deleted must NOT be resurrected when the next
// calendar sweep re-ingests the same event, so we look it up by source_id even
// once it's soft-deleted. parseBlock preserves deleted_at for the caller.
async function getBlocksByDateIncludingDeleted(date, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE date = $1 AND workspace_id = $2 ORDER BY sort_order ASC, created_at ASC`, [date, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE date = $1 ORDER BY sort_order ASC, created_at ASC`, [date]);
  return rows.map(parseBlock);
}

// Date-independent calendar identity lookup, plus every row on the matching
// meeting dates. A calendar event can move backward or forward beyond the
// current feed horizon; the materializer needs the old parent and its nested
// task rows in order to move them without changing ids or orphaning children.
// Tombstones are included so user deletion remains authoritative.
async function getCalendarMeetingContextBySourceIds(sourceIds, workspaceId) {
  const ids = (Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean);
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `WITH meeting_dates AS (
       SELECT DISTINCT date
         FROM blocks
        WHERE workspace_id IS NOT DISTINCT FROM $2
          AND properties->>'source' = 'calendar'
          AND properties->>'type' IN ('meeting','oneone')
          AND properties->>'source_id' = ANY($1::text[])
     )
     SELECT b.*
       FROM blocks b
       JOIN meeting_dates md ON b.date = md.date
      WHERE b.workspace_id IS NOT DISTINCT FROM $2
      ORDER BY b.date ASC, b.sort_order ASC, b.created_at ASC`,
    [ids, workspaceId || null]
  );
  return rows.map(parseBlock);
}

// The candidate pool for a reschedule subtree walk (lib/reschedule.js): every task row
// on the origin date, PLUS undated rows carrying a subtaskOf/wrapId link.
//
// Undated rows are in scope because they exist (task-bar pending_tasks live on a day only
// via day-state) and a move stamps a real date on them, healing the anomaly. They are
// narrowed to LINKED rows on purpose: the broader date-IS-NULL set also matches every
// delegated item (type='block', date null, kind='delegated_item'), a standing list that
// would ride along on every reschedule.
//
// The task test is `local_id IS NOT NULL OR kind = 'task'`. It is deliberately NOT
// `dcc_is_task_row`, and not the fold's `isFoldableTask` either, so do not "unify" it
// without re-measuring:
//   - `dcc_is_task_row` is LOOSER here in the one way that matters: it admits meeting
//     artifacts (meeting_prep / meeting_summary / meeting_transcript /
//     proposed_action_item), which are genuine parent_id children of a meeting. Now that
//     the walk reads parent_id, admitting them would let a task move re-date a meeting's
//     prep doc. Neither half of this OR matches them, and that exclusion is the only thing
//     preventing it.
//   - `isFoldableTask` (public/js/persistence.js) has four branches; this is two of them.
//     It drops shells and materialized meetings, which is correct here: a meeting has no
//     local_id, so nothing can be nested under it by local-id link, and its parent_id
//     children are exactly the artifacts above. A meeting can still BE the moved row —
//     the route passes the parent in separately, it does not come from this pool.
// The `kind = 'task'` half is load-bearing: 6 live rows on the prod restore are kind:'task'
// with no local_id. The fold renders them, so a walk that cannot see them strands them
// when their parent moves.
//
// One query, not two: this replaces a getBlocksByDate + getUndatedTaskBlocks pair the
// route used to concatenate (getUndatedTaskBlocks is deleted — this was its only caller).
async function getRescheduleSubtreePool(fromDate, workspaceId) {
  const isTask = `(b.properties->>'local_id' IS NOT NULL OR b.properties->>'kind' = 'task')`;
  const linked = `(b.properties->>'subtaskOf' IS NOT NULL OR b.properties->>'wrapId' IS NOT NULL)`;
  const { rows } = await pool.query(
    `WITH RECURSIVE task_pool AS (
       SELECT b.* FROM blocks b
        WHERE b.workspace_id IS NOT DISTINCT FROM $2
          AND b.deleted_at IS NULL
          AND b.type = 'block'
          AND ${isTask}
          AND (b.date = $1 OR (b.date IS NULL AND ${linked}))
       UNION
       SELECT c.* FROM blocks c
         JOIN task_pool p ON (
           c.parent_id = p.id OR
           c.properties->>'subtaskOf' = p.properties->>'local_id' OR
           c.properties->>'wrapId' = p.properties->>'local_id'
         )
        WHERE c.workspace_id IS NOT DISTINCT FROM $2
          AND c.deleted_at IS NULL
          AND c.type = 'block'
          AND (c.properties->>'local_id' IS NOT NULL OR c.properties->>'kind' = 'task')
     )
     SELECT * FROM task_pool ORDER BY sort_order ASC, created_at ASC`,
    [fromDate, workspaceId || null]
  );
  return rows.map(parseBlock);
}

// The origin day's existing move tombstone for `movedBlockId`, if it already has one.
//
// Its own lookup on purpose. The route used to find this by scanning the subtree pool,
// which worked only because a tombstone carries a `local_id` and so slipped through the
// pool's task filter — while `reschedule_tombstone` is in NON_TASK_KINDS and is not a task
// by any other definition in this file. That coupling meant tightening the pool's predicate
// would silently break the one-tombstone-per-(row, day) rule and start piling up a new
// amber entry on every repeat reschedule. Asking for the thing you want is cheaper than
// that trap, and it reads one row instead of filtering a day.
async function getRescheduleTombstone(fromDate, movedBlockId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM blocks
      WHERE date = $1
        AND workspace_id IS NOT DISTINCT FROM $3
        AND deleted_at IS NULL
        AND properties->>'kind' = 'reschedule_tombstone'
        AND properties->>'movedBlockId' = $2
      LIMIT 1`,
    [fromDate, movedBlockId, workspaceId || null]
  );
  return rows[0] ? parseBlock(rows[0]) : null;
}

async function getBlocksByTypes(types, workspaceId) {
  const placeholders = types.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND workspace_id = $${types.length + 1} AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [...types, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE type IN (${placeholders}) AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, types);
  return rows.map(parseBlock);
}

// PIN 10.A: delegated items are type="block" with properties.kind="delegated_item".
// Sorted by checkInAt ascending (nulls last) so upcoming check-ins surface first.
async function getDelegatedItems(workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' = 'delegated_item'
           AND workspace_id = $1
           AND deleted_at IS NULL
         ORDER BY (properties->>'checkInAt') ASC NULLS LAST, created_at DESC`,
        [workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' = 'delegated_item'
           AND deleted_at IS NULL
         ORDER BY (properties->>'checkInAt') ASC NULLS LAST, created_at DESC`
      );
  return rows.map(parseBlock);
}

async function getChildren(parentId, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE parent_id = $1 AND workspace_id = $2 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [parentId, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`, [parentId]);
  return rows.map(parseBlock);
}

async function getBlock(id) {
  const { rows } = await pool.query("SELECT * FROM blocks WHERE id = $1", [id]);
  return rows[0] ? parseBlock(rows[0]) : null;
}

// ── Batch Operations ──

async function batchOp(operations) {
  const batchId = crypto.randomUUID();
  const results = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const op of operations) {
      switch (op.op) {
        case "create": results.push(await createBlock(op, client)); break;
        case "update": results.push(await updateBlock(op.id, op, client)); break;
        case "delete": results.push(await deleteBlock(op.id, client)); break;
        case "reorder": await reorderBlocks(op.items, client); results.push({ reordered: op.items.length }); break;
        default: throw new Error(`Unknown batch operation: ${op.op}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { batchId, blocks: results };
}

// ── Reschedule (atomic subtree move) ──

// Move a parent block and its whole subtask subtree to another date in ONE
// transaction, optionally creating side blocks (a "rescheduled away" tombstone)
// in the same commit. This replaces the old clone-new-id + soft-delete-old
// design, which could half-fail and strand or duplicate subtasks. `moves` is
// [{ id, date, properties? }] (properties omitted => keep existing). `creates`
// is [createBlock-shaped payloads] run on the same client.
//
// NOTE: not reused via batchOp() — this needs SELECT ... FOR UPDATE row locks
// on each move and a distinct moves/creates contract + return shape that
// batchOp doesn't model. (batchOp itself is now genuinely transactional: its
// update/delete/reorder branches run on the tx client, not the pool.)
async function rescheduleBlocks(moves, creates) {
  const now = new Date().toISOString();
  const client = await pool.connect();
  const results = [];
  try {
    await client.query("BEGIN");
    for (const m of moves) {
      const { rows } = await client.query("SELECT * FROM blocks WHERE id = $1 FOR UPDATE", [m.id]);
      const existing = rows[0];
      if (!existing) throw new Error(`Block not found: ${m.id}`);
      if (existing.deleted_at) throw new Error(`Block is deleted: ${m.id}`);
      // The route discovers the subtree before entering this transaction. Another
      // reschedule can commit between that read and this lock, leaving `moves` based
      // on the old day. Applying that stale plan can move the parent alone and strand
      // its children. Compare the parent snapshot after taking the row lock and make
      // the client rebuild the request from current state instead.
      const hasExpectedDate = Object.prototype.hasOwnProperty.call(m, "expectedDate");
      const expectedDate = normalizeDate(m.expectedDate);
      const actualDate = normalizeDate(existing.date);
      const expectedUpdatedAt = m.expectedUpdatedAt == null ? null : new Date(m.expectedUpdatedAt).getTime();
      const actualUpdatedAt = existing.updated_at == null ? null : new Date(existing.updated_at).getTime();
      const dateChangedSinceRead = hasExpectedDate && expectedDate !== actualDate;
      const versionChangedSinceRead = expectedUpdatedAt != null && actualUpdatedAt != null && expectedUpdatedAt !== actualUpdatedAt;
      if (dateChangedSinceRead || versionChangedSinceRead) {
        const err = new Error("Task changed while it was being moved");
        err.statusCode = 409;
        err.code = "RESCHEDULE_STALE";
        throw err;
      }
      let newProps = existing.properties;
      if (m.properties !== undefined) {
        const parsed = typeof m.properties === "string" ? JSON.parse(m.properties) : m.properties;
        validateBlock(existing.type, parsed);
        newProps = parsed;
      }
      const newDate = m.date !== undefined ? m.date : existing.date;
      // C6c: a row that CHANGES DAY joins the target day's space at the end. It used to keep the
      // originating day's `sort_order`, so an arriving task landed wherever it happened to sit on
      // the day it came from -- which under a `sort_order` read means a carryover can insert itself
      // into the middle of today. A same-day re-slot keeps its number (nothing moved).
      let newSortOrder = existing.sort_order;
      const dayChanged = normalizeDate(newDate) !== normalizeDate(existing.date);
      if (dayChanged && isTaskRow({ type: existing.type, properties: typeof newProps === "string" ? JSON.parse(newProps) : newProps })) {
        newSortOrder = await nextSortOrderForDay(client, { date: newDate, workspace_id: existing.workspace_id });
      }
      await client.query(`UPDATE blocks SET properties = $1, date = $2, sort_order = $3, updated_at = $4 WHERE id = $5`, [newProps, newDate, newSortOrder, now, m.id]);
      await client.query(`INSERT INTO operations (block_id, op_type, before_data, after_data, timestamp) VALUES ($1, 'update', $2, $3, $4)`, [m.id, existing.properties, newProps, now]);
      results.push({ id: m.id, type: existing.type, parent_id: existing.parent_id, date: normalizeDate(newDate), properties: typeof newProps === "string" ? JSON.parse(newProps) : newProps, sort_order: newSortOrder, created_at: existing.created_at, updated_at: now, deleted_at: null });
    }
    for (const c of (creates || [])) {
      results.push(await createBlock(c, client));
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { blocks: results };
}

// ── Reorder with Auto-Rebalance ──

async function reorderBlocks(items, client) {
  const q = client || pool;
  const now = new Date().toISOString();
  for (const item of items) {
    await q.query("UPDATE blocks SET sort_order = $1, updated_at = $2 WHERE id = $3", [item.sort_order, now, item.id]);
  }
  if (items.length > 1) {
    const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order);
    let needsRebalance = false;
    for (let i = 1; i < sorted.length; i++) { if (sorted[i].sort_order - sorted[i - 1].sort_order < 0.001) { needsRebalance = true; break; } }
    if (needsRebalance) {
      // The sibling sweep is scoped to the reordered row's OWN workspace. It used to
      // select every row sharing the parent_id, which is the one parent_id read in
      // this file with no workspace predicate (getChildren and getSubtree both have
      // one), so a row parented onto another workspace's container turned a rebalance
      // into a cross-tenant write that renumbered that workspace's whole subtree.
      // routes/blocks.js authorizes parent_id on the batch path now, but the blindness
      // was the actual mechanism, so it is closed here too: any future caller reaching
      // reorderBlocks with a stray parent edge cannot renumber someone else's rows.
      // Same behavior for legitimate data, where siblings share a workspace.
      const { rows } = await q.query("SELECT parent_id, workspace_id FROM blocks WHERE id = $1", [items[0].id]);
      if (rows[0] && rows[0].parent_id) {
        const { rows: siblings } = await q.query(
          `SELECT id FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL
             AND workspace_id IS NOT DISTINCT FROM $2 ORDER BY sort_order ASC`,
          [rows[0].parent_id, rows[0].workspace_id]
        );
        for (let i = 0; i < siblings.length; i++) { await q.query("UPDATE blocks SET sort_order = $1, updated_at = $2 WHERE id = $3", [(i + 1) * 1000, now, siblings[i].id]); }
      }
    }
  }
}

// ── Day Root ──

async function ensureDayRoot(date, userId, workspaceId, client) {
  const q = client || pool;
  const newId = workspaceId ? `day-root-${workspaceId}-${date}` : `day-root-${date}`;
  const legacyId = `day-root-${date}`;
  const { rows: newRows } = await q.query("SELECT id FROM blocks WHERE id = $1", [newId]);
  if (newRows.length > 0) return newId;
  if (workspaceId === "ws-1") {
    const { rows: legacyRows } = await q.query("SELECT id FROM blocks WHERE id = $1", [legacyId]);
    if (legacyRows.length > 0) return legacyId;
  }
  await createBlock({ id: newId, type: "day_root", date, properties: { date }, sort_order: 0, user_id: userId || null, workspace_id: workspaceId || null }, client);
  return newId;
}

// One place that turns a task's properties into a persisted itinerary block:
// ensure the day root exists, optionally score it, derive sort_order from the
// start time (unless an explicit slot is passed), then insert. The four route
// copies that used to hand-roll this sequence — quick-task, brief/materialize,
// task-group schedule, responsibility auto-schedule — funnel through here.
// Options keep each caller's existing behavior:
//   score      run scoreTaskPoints and stamp points/pointsBreakdown (quick-task)
//   ensureRoot ensure the day_root row first; pass false inside a batch that
//              already ensured it once, so we don't re-SELECT per item
//   sortOrder  explicit slot in minutes; defaults to start-derived minutes
//   client     a pg client to run inside a caller's transaction
// The canonical dual-write (local_id, status, parent_id/rel) is NOT repeated here —
// this funnels through createBlock, which owns it. One insertion point, not two.
async function createItineraryTask({ date, properties, userId = null, workspaceId = null, sortOrder, score = false, ensureRoot = true, client } = {}) {
  if (ensureRoot) await ensureDayRoot(date, userId, workspaceId);
  const props = { ...(properties || {}) };
  if (score) {
    try {
      const durationMinutes = props.durationMinutes != null ? props.durationMinutes
        : (props.estimatedMinutes != null ? props.estimatedMinutes : props.duration);
      const scored = scoreTaskPoints({ ...props, durationMinutes });
      props.points = scored.awardPoints;
      props.pointsBreakdown = scored;
    } catch (scoreErr) {
      console.error("[createItineraryTask] scoring failed (non-fatal):", scoreErr.message);
    }
  }
  // C6c: the minutes-of-day `derivedSort` is GONE. A start time is not an order -- it produced
  // 1005 of prod's 1815 sort_orders in the 0..1439 range, every one of them sorting ahead of every
  // 1000-spaced drag value, which is what made the column unreadable as an order. Passing no
  // sort_order lets createBlock append to the day in the one space. The itinerary still renders
  // timed rows by their `start`; that is a separate axis and always was.
  return createBlock({ type: "block", date, properties: props, sort_order: sortOrder, user_id: userId, workspace_id: workspaceId }, client);
}

// Batch-create itinerary tasks atomically. The store owns the transaction (per
// the repo's store-owns-transactions idiom, like rescheduleBlocks/batchOp), so
// callers hand over a list of items instead of driving pool clients themselves.
// Each distinct day root is ensured once up front (idempotent), then every item
// is inserted on one pooled client inside a single BEGIN/COMMIT.
// items: [{ date, properties, sortOrder?, score? }]; opts apply to every item.
async function createItineraryTasks(items, { userId = null, workspaceId = null, score = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const dates = [...new Set(items.map((it) => it.date).filter(Boolean))];
  for (const d of dates) await ensureDayRoot(d, userId, workspaceId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = [];
    for (const it of items) {
      created.push(await createItineraryTask({
        date: it.date, properties: it.properties, userId, workspaceId,
        sortOrder: it.sortOrder, score: it.score != null ? it.score : score,
        ensureRoot: false, client,
      }));
    }
    await client.query("COMMIT");
    return created;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── DCC State ──

async function ensureDccStateTable() {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.dcc_state') IS NULL AND to_regclass('public.pa_state') IS NOT NULL THEN
        ALTER TABLE pa_state RENAME TO dcc_state;
      END IF;
      IF to_regclass('public.idx_pa_state_workspace') IS NOT NULL AND to_regclass('public.idx_dcc_state_workspace') IS NULL THEN
        ALTER INDEX idx_pa_state_workspace RENAME TO idx_dcc_state_workspace;
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dcc_state (
      date         DATE NOT NULL,
      state_json   JSONB NOT NULL,
      user_id      INTEGER REFERENCES users(id),
      workspace_id TEXT NOT NULL DEFAULT 'ws-1',
      updated_at   TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (date, workspace_id)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_dcc_state_workspace ON dcc_state(workspace_id, date)");
}

// One-time-compatible bridge from the date-scoped overlays that predated durable
// triage suppressions. It is safe on every startup: the generated id is stable and
// the NOT EXISTS guard also respects suppressions created through the API.
async function backfillLegacyTriageSuppressions() {
  const { rows } = await pool.query(`
    WITH dismissed AS (
      SELECT b.workspace_id, b.user_id, entry.key AS triage_id,
             CASE
               WHEN COALESCE(entry.value->>'dismissed_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                 THEN (entry.value->>'dismissed_at')::timestamptz
               ELSE b.updated_at
             END AS handled_at,
             lower(COALESCE(entry.value->>'trivial', 'false')) IN ('true', 't', '1') AS trivial,
             COALESCE(entry.value->>'note', '') AS note,
             ''::text AS item_title,
             'done'::text AS reason
        FROM blocks b
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(b.properties->'_dismissed') = 'object'
            THEN b.properties->'_dismissed' ELSE '{}'::jsonb END
        ) entry
       WHERE b.type = 'day_root' AND b.deleted_at IS NULL
    ), deleted_overlay AS (
      SELECT b.workspace_id, b.user_id, entry.triage_id, b.updated_at AS handled_at,
             false AS trivial, ''::text AS note, ''::text AS item_title,
             'deleted'::text AS reason
        FROM blocks b
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(b.properties->'_triageDeleted') = 'array'
            THEN b.properties->'_triageDeleted' ELSE '[]'::jsonb END
        ) entry(triage_id)
       WHERE b.type = 'day_root' AND b.deleted_at IS NULL
    ), state_deleted AS (
      SELECT s.workspace_id, s.user_id, item->>'id' AS triage_id,
             CASE
               WHEN COALESCE(item->>'deleted_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                 THEN (item->>'deleted_at')::timestamptz
               ELSE s.updated_at
             END AS handled_at,
             false AS trivial, ''::text AS note, COALESCE(item->>'title', '') AS item_title,
             'deleted'::text AS reason
        FROM dcc_state s
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.state_json#>'{triage,deleted_items}') = 'array'
            THEN s.state_json#>'{triage,deleted_items}' ELSE '[]'::jsonb END
        ) item
    ), state_resolved AS (
      SELECT s.workspace_id, s.user_id, item->>'id' AS triage_id,
             CASE
               WHEN COALESCE(item->>'resolved_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                 THEN (item->>'resolved_at')::timestamptz
               ELSE s.updated_at
             END AS handled_at,
             false AS trivial,
             CASE WHEN lower(COALESCE(item->>'resolved_reason', '')) = 'replied'
               THEN 'Replied at source' ELSE '' END AS note,
             COALESCE(item->>'title', '') AS item_title,
             CASE WHEN lower(COALESCE(item->>'resolved_reason', '')) = 'deleted'
               THEN 'deleted' ELSE 'done' END AS reason
        FROM dcc_state s
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s.state_json#>'{triage,resolved_items}') = 'array'
            THEN s.state_json#>'{triage,resolved_items}' ELSE '[]'::jsonb END
        ) item
       WHERE lower(COALESCE(item->>'resolved_reason', '')) IN ('replied', 'done', 'deleted')
    ), candidates AS (
      SELECT * FROM dismissed
      UNION ALL SELECT * FROM deleted_overlay
      UNION ALL SELECT * FROM state_deleted
      UNION ALL SELECT * FROM state_resolved
    ), deduped AS (
      SELECT DISTINCT ON (workspace_id, triage_id)
             workspace_id, user_id, triage_id, handled_at, trivial, note, item_title, reason
        FROM candidates
       WHERE workspace_id IS NOT NULL AND COALESCE(triage_id, '') <> ''
       ORDER BY workspace_id, triage_id, handled_at DESC, (reason = 'deleted') DESC
    )
    INSERT INTO blocks
      (id, type, parent_id, date, properties, sort_order, created_at, updated_at, deleted_at, user_id, workspace_id)
    SELECT 'triage-suppression-legacy-' || md5(d.workspace_id || '|' || d.triage_id),
           'block', NULL, NULL,
           jsonb_build_object(
             'kind', 'triage_suppression',
             'triage_id', left(d.triage_id, 300),
             'key', '',
             'itemTitle', left(d.item_title, 220),
             'reason', d.reason,
             'trivial', d.trivial,
             'note', left(d.note, 1000),
             'at', d.handled_at::text,
             'conversation_id', CASE WHEN d.triage_id ~ '^gmail:[^:]+$' THEN split_part(d.triage_id, ':', 2) ELSE '' END,
             'received_at', '',
             'itemSnapshot', '{}'::jsonb,
             'active', true,
             'reopenedAt', ''
           ),
           0, d.handled_at, NOW(), NULL, d.user_id, d.workspace_id
      FROM deduped d
     WHERE NOT EXISTS (
       SELECT 1 FROM blocks live
        WHERE live.workspace_id = d.workspace_id
          AND live.deleted_at IS NULL
          AND live.properties->>'kind' = 'triage_suppression'
          AND live.properties->>'triage_id' = d.triage_id
     )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  return rows.length;
}

async function saveDccState(date, stateJson, userId, workspaceId) {
  const now = new Date().toISOString();
  const wsId = workspaceId || (userId ? `ws-${userId}` : "ws-1");
  const stateObj = typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson;
  await pool.query(
    `INSERT INTO dcc_state (date, state_json, user_id, workspace_id, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(date, workspace_id) DO UPDATE SET state_json = EXCLUDED.state_json, user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at`,
    [date, stateObj, userId || null, wsId, now]
  );
}

async function getDccState(date, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query("SELECT * FROM dcc_state WHERE date = $1 AND workspace_id = $2", [date, workspaceId])
    : await pool.query("SELECT * FROM dcc_state WHERE date = $1", [date]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { ...row, state_json: typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json };
}

async function purgeSoftDeleted(olderThanDays = 30) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - olderThanDays);
  const result = await pool.query("DELETE FROM blocks WHERE deleted_at IS NOT NULL AND deleted_at < $1", [cutoff.toISOString()]);
  return result.rowCount;
}

async function getOperations(blockId, limit = 50) {
  const { rows } = await pool.query(`SELECT * FROM operations WHERE block_id = $1 ORDER BY id DESC LIMIT $2`, [blockId, limit]);
  return rows;
}

async function getBlocksByDateRange(startDate, endDate, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE workspace_id = $3 AND deleted_at IS NULL
        AND ((date >= $1 AND date <= $2) OR (properties->>'all_day' = 'true'
          AND CASE WHEN properties->>'all_day_start' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_start')::date END <= $2
          AND CASE WHEN properties->>'all_day_end' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_end')::date END > $1))
        ORDER BY date ASC, sort_order ASC, created_at ASC`, [startDate, endDate, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE deleted_at IS NULL
        AND ((date >= $1 AND date <= $2) OR (properties->>'all_day' = 'true'
          AND CASE WHEN properties->>'all_day_start' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_start')::date END <= $2
          AND CASE WHEN properties->>'all_day_end' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (properties->>'all_day_end')::date END > $1))
        ORDER BY date ASC, sort_order ASC, created_at ASC`, [startDate, endDate]);
  return rows.map(parseBlock);
}

async function getDccStateRange(startDate, endDate, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM dcc_state WHERE date >= $1 AND date <= $2 AND workspace_id = $3 ORDER BY date ASC`, [startDate, endDate, workspaceId])
    : await pool.query(`SELECT * FROM dcc_state WHERE date >= $1 AND date <= $2 ORDER BY date ASC`, [startDate, endDate]);
  return rows.map(row => ({ ...row, state_json: typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json }));
}

// ── Responsibility / task-group / apply-forward queries ──
// SQL moved out of routes/blocks.js (dcc-improvements P8) so the router holds no
// raw pool.query. These are verbatim moves — same predicates, same params, same
// parseBlock shaping. Callers layer domain normalization on top (see
// responsibility-store.js).

// Responsibility items + their triggers, oldest first. Rows are parseBlock'd but
// NOT score-normalized here (the store adds importanceScore).
async function getResponsibilityBlocks(workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' IN ('responsibility_item','responsibility_trigger')
           AND workspace_id = $1
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type = 'block'
           AND properties->>'kind' IN ('responsibility_item','responsibility_trigger')
           AND deleted_at IS NULL
         ORDER BY created_at ASC`
      );
  return rows.map(parseBlock);
}

async function findResponsibilityBySlug(slug, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(
        `SELECT * FROM blocks
         WHERE type='block' AND properties->>'kind'='responsibility_item'
           AND properties->>'slug'=$1 AND workspace_id=$2 AND deleted_at IS NULL
         LIMIT 1`,
        [slug, workspaceId]
      )
    : await pool.query(
        `SELECT * FROM blocks
         WHERE type='block' AND properties->>'kind'='responsibility_item'
           AND properties->>'slug'=$1 AND deleted_at IS NULL
         LIMIT 1`,
        [slug]
      );
  return rows[0] ? parseBlock(rows[0]) : null;
}

// Generic "all type='block' rows of this kind", oldest first (task_menu, task_group).
async function getBlocksByKind(kind, workspaceId) {
  const { rows } = workspaceId
    ? await pool.query(`SELECT * FROM blocks WHERE type='block' AND properties->>'kind'=$1 AND workspace_id=$2 AND deleted_at IS NULL ORDER BY created_at ASC`, [kind, workspaceId])
    : await pool.query(`SELECT * FROM blocks WHERE type='block' AND properties->>'kind'=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [kind]);
  return rows.map(parseBlock);
}

// /responsibilities/capture: does this workspace already have the trigger for a
// given slug? Existence check only — returns the id row or null.
async function findResponsibilityTriggerBySlug(slug, workspaceId) {
  const { rows } = await pool.query(
    `SELECT id FROM blocks WHERE type='block' AND properties->>'kind'='responsibility_trigger' AND properties->>'slug'=$1 AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL LIMIT 1`,
    [slug, workspaceId || null]
  );
  return rows[0] || null;
}

// /responsibilities/capture: dedupe an alert-sourced task by its alertKey.
async function findResponsibilityTaskByAlertKey(alertKey, workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM blocks WHERE type='block' AND properties->>'kind'='responsibility_task' AND properties->>'alertKey'=$1 AND ($2::text IS NULL OR workspace_id=$2) AND deleted_at IS NULL LIMIT 1`,
    [alertKey, workspaceId || null]
  );
  return rows[0] ? parseBlock(rows[0]) : null;
}

// Find a block by the CLIENT-minted id the browser stores in properties.local_id.
// Same shape as findResponsibilityTaskByAlertKey above. Deliberately keeps
// soft-deleted rows: the recurrence reconciler treats "deleted" as a signal, and a
// row it cannot see at all is indistinguishable from one that was never created.
// Date-independent on purpose, so an instance dragged to another day is still
// found (nothing re-stamps the definition when a task is rescheduled).
async function findBlockByLocalId(localId, workspaceId) {
  const { rows } = await pool.query(
    `SELECT * FROM blocks WHERE properties->>'local_id'=$1 AND ($2::text IS NULL OR workspace_id=$2) ORDER BY updated_at DESC LIMIT 1`,
    [localId, workspaceId || null]
  );
  return rows[0] ? parseBlock(rows[0]) : null;
}

// apply-forward: distinct future dates (after fromDate) that still have live
// blocks in this workspace, ascending. Returns bare YYYY-MM-DD strings.
async function getFutureDatesWithBlocks(fromDate, workspaceId) {
  const { rows } = await pool.query(
    "SELECT DISTINCT date FROM blocks WHERE deleted_at IS NULL AND date > $1 AND ($2::text IS NULL OR workspace_id = $2) ORDER BY date ASC",
    [fromDate, workspaceId || null]
  );
  return rows.map(r => r.date instanceof Date ? r.date.toISOString().split("T")[0] : String(r.date).split("T")[0]);
}

module.exports = {
  pool, BLOCK_SCHEMAS, VALID_TYPES, validateBlock,
  createBlock, updateBlock, deleteBlock,
  // Canonical task model primitives (A1) — no callers yet except the audit endpoint.
  undeleteBlock, getBlockIncludingDeleted, findByIdempotencyKey, isIdempotencyConflict,
  getCarryoverPool, carryoverSkipTypes, getSubtree, isTaskRow,
  isCompletedTaskProps, applyCompletionIntent, setTaskCompletion, propagateResponsibilityDone,
  getBlocksByDate, getBlocksByDateIncludingDeleted, getCalendarMeetingContextBySourceIds, getRescheduleSubtreePool, getRescheduleTombstone, getBlocksByTypes, getChildren, getBlock,
  getDelegatedItems,
  batchOp, rescheduleBlocks, reorderBlocks, ensureDayRoot, createItineraryTask, createItineraryTasks,
  ensureDccStateTable, backfillLegacyTriageSuppressions, saveDccState, getDccState, purgeSoftDeleted, getOperations,
  parseBlock, getBlocksByDateRange, getDccStateRange, ensureWorkspacesForAllUsers,
  getResponsibilityBlocks, findResponsibilityBySlug, getBlocksByKind,
  findResponsibilityTriggerBySlug, findResponsibilityTaskByAlertKey, findBlockByLocalId, getFutureDatesWithBlocks
};
