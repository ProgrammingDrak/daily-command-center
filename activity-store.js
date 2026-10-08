const Model = require("./public/js/activity-model");

// Kept outside block JSON, operations, day-state, vault sync, and public exports.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_activity_records (
  task_id TEXT PRIMARY KEY REFERENCES blocks(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  task_type TEXT NOT NULL CHECK (task_type IN ('workout','meal')),
  record JSONB NOT NULL,
  occurred_on DATE,
  revision INTEGER NOT NULL DEFAULT 1,
  previous JSONB,
  archived_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_owner_date
  ON task_activity_records(workspace_id, owner_user_id, occurred_on);
`;
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function revision(v) { if (!Number.isInteger(v) || v < 0) throw error("Expected revision is required"); return v; }
function shape(block, record) {
  const p = block.properties || {};
  return { taskId: block.id, title: p.title || "Untitled task", date: block.date ? String(block.date).slice(0, 10) : null,
    completed: p.status === "done" || !!p.completedAt, removed: !!block.deleted_at,
    archived: !!record?.archived_at, revision: record?.revision || 0,
    canUndo: !!record?.previous, updatedAt: record?.updated_at || null,
    record: record?.record || Model.empty(p.type) };
}

// Runs inside the block-create transaction. Only plans are copied, never actuals.
async function readPlanSource(q, sourceId, workspaceId, userId) {
  const { rows } = await q.query(`SELECT r.* FROM task_activity_records r
    JOIN blocks b ON b.id=r.task_id
    WHERE r.task_id=$1 AND r.workspace_id=$2 AND r.owner_user_id=$3
      AND b.workspace_id=$2 AND b.deleted_at IS NULL AND r.archived_at IS NULL`, [sourceId, workspaceId, userId]);
  if (!rows[0]) throw error("Activity plan not found", 404);
  return Model.planOnly(rows[0].record);
}
async function insertPlan(q, block, plan) {
  await q.query(`INSERT INTO task_activity_records (task_id,workspace_id,owner_user_id,task_type,record)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (task_id) DO NOTHING`, [block.id, block.workspace_id, block.user_id, plan.taskType, plan]);
}

function createActivityStore({ pool, blockDB, crypto = require("node:crypto") }) {
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (e) { await c.query("ROLLBACK"); throw e; }
    finally { c.release(); }
  }
  async function block(q, id, owner, lock = false) {
    const { rows } = await q.query(`SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2
      AND (user_id=$3 OR user_id IS NULL)${lock ? " FOR UPDATE" : ""}`, [id, owner.workspaceId, owner.userId]);
    const b = rows[0];
    if (!b || !blockDB.isTaskRow(b)) throw error("Task not found", 404);
    if (b.date instanceof Date) b.date = b.date.toISOString().slice(0, 10);
    return b;
  }
  async function record(q, id, owner) {
    const { rows } = await q.query("SELECT * FROM task_activity_records WHERE task_id=$1 AND workspace_id=$2 AND owner_user_id=$3", [id, owner.workspaceId, owner.userId]);
    return rows[0] || null;
  }
  async function get(id, owner) {
    const b = await block(pool, id, owner), r = await record(pool, id, owner);
    if (!r && !Model.TYPES.includes(b.properties.type)) throw error("Choose Workout or Meal to start a record", 404);
    return shape(b, r);
  }
  async function save(id, body, owner) {
    const value = Model.validate(body.record), expected = revision(body.expectedRevision);
    return tx(async q => {
      const b = await block(q, id, owner, true), old = await record(q, id, owner);
      if (b.deleted_at) throw error("Restore the removed task before editing its record", 409);
      if ((old?.revision || 0) !== expected) throw error("This record changed elsewhere. Reload it before saving", 409);
      if (old?.archived_at) throw error("Restore the archived record before editing", 409);
      if (old && old.task_type !== value.taskType) throw error("A recorded task cannot change activity type", 409);
      if (Model.TYPES.includes(b.properties.type) && b.properties.type !== value.taskType) throw error("Activity type must match the task", 409);
      if (!old && !["task", "focus", "habit", ...Model.TYPES].includes(b.properties.type || "task")) throw error("This task type cannot hold an activity record");
      const previous = old ? { record: old.record, archivedAt: old.archived_at } : null;
      const { rows } = await q.query(`INSERT INTO task_activity_records
        (task_id,workspace_id,owner_user_id,task_type,record,occurred_on,revision,previous)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7)
        ON CONFLICT (task_id) DO UPDATE SET record=EXCLUDED.record,occurred_on=EXCLUDED.occurred_on,
          previous=EXCLUDED.previous,revision=task_activity_records.revision+1,updated_at=NOW()
        WHERE task_activity_records.workspace_id=EXCLUDED.workspace_id AND task_activity_records.owner_user_id=EXCLUDED.owner_user_id
        RETURNING *`, [id, owner.workspaceId, owner.userId, value.taskType, value, value.occurredOn, previous]);
      if (!rows.length) throw error("Record not found", 404);
      // Normal task state stays authoritative; logging never completes a task.
      const updated = await blockDB.updateBlock(id, { properties: { ...b.properties, type: value.taskType, publicVisibility: "private" } }, q);
      return shape(updated, rows[0]);
    });
  }
  async function change(id, body, owner, action) {
    const expected = revision(body.expectedRevision);
    return tx(async q => {
      const b = await block(q, id, owner, true), old = await record(q, id, owner);
      if (!old) throw error("Record not found", 404);
      if (old.revision !== expected) throw error("This record changed elsewhere. Reload it first", 409);
      let value = old.record, archivedAt = old.archived_at;
      if (action === "archive") archivedAt = new Date().toISOString();
      if (action === "restore") archivedAt = null;
      if (action === "undo") {
        if (!old.previous) throw error("No previous edit to restore", 409);
        value = old.previous.record; archivedAt = old.previous.archivedAt;
      }
      const { rows } = await q.query(`UPDATE task_activity_records SET record=$4,occurred_on=$5,archived_at=$6,
        previous=$7,revision=revision+1,updated_at=NOW()
        WHERE task_id=$1 AND workspace_id=$2 AND owner_user_id=$3 RETURNING *`,
      [id, owner.workspaceId, owner.userId, value, value.occurredOn, archivedAt, { record: old.record, archivedAt: old.archived_at }]);
      return shape(b, rows[0]);
    });
  }
  async function list({ from, to, includeArchived = false }, owner) {
    Model.dateRange(from, to);
    const { rows } = await pool.query(`SELECT b.*, r.record AS activity_record,r.task_type AS activity_type,
      r.revision AS activity_revision,r.previous IS NOT NULL AS activity_can_undo,r.archived_at AS activity_archived_at,
      r.updated_at AS activity_updated_at
      FROM blocks b LEFT JOIN task_activity_records r ON r.task_id=b.id
        AND r.workspace_id=$1 AND r.owner_user_id=$2
      WHERE b.workspace_id=$1 AND (b.user_id=$2 OR b.user_id IS NULL)
        AND (b.date BETWEEN $3::date AND $4::date OR r.occurred_on BETWEEN $3::date AND $4::date)
        AND (r.task_id IS NOT NULL OR b.properties->>'type' IN ('workout','meal'))
        AND ($5::boolean OR r.archived_at IS NULL)
      ORDER BY b.date,b.sort_order,b.id`, [owner.workspaceId, owner.userId, from, to, includeArchived]);
    return rows.filter(b => blockDB.isTaskRow({ ...b, deleted_at: null })).map(b => {
      if (b.date instanceof Date) b.date = b.date.toISOString().slice(0, 10);
      const r = b.activity_record ? { record: b.activity_record, revision: b.activity_revision, previous: b.activity_can_undo, archived_at: b.activity_archived_at, updated_at: b.activity_updated_at } : null;
      return shape(b, r);
    });
  }
  async function create(body, owner) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 160) throw error("A title of up to 160 characters is required");
    if (!Model.validDate(body.date)) throw error("A valid task date is required");
    const minutes = body.duration == null ? 30 : body.duration;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw error("Duration must be 1–1440 minutes");
    const value = body.sourceId ? null : Model.validate(body.record);
    return tx(async q => {
      const plan = body.sourceId ? await readPlanSource(q, body.sourceId, owner.workspaceId, owner.userId) : value;
      const id = crypto.randomUUID();
      const parent = await blockDB.ensureDayRoot(body.date, owner.userId, owner.workspaceId, q);
      const b = await blockDB.createItineraryTask({ id, date: body.date, parent_id: parent, userId: owner.userId,
        workspaceId: owner.workspaceId, ensureRoot: false, client: q, score: true,
        properties: { title: body.title.trim(), type: plan.taskType, kind: "manual_task", local_id: id, duration: minutes,
          all_day: true, all_day_start: body.date, all_day_end: new Date(Date.parse(body.date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10),
          publicVisibility: "private", source: "manual", status: "open" } });
      await q.query(`INSERT INTO task_activity_records (task_id,workspace_id,owner_user_id,task_type,record,occurred_on)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, owner.workspaceId, owner.userId, plan.taskType, plan, plan.occurredOn]);
      return shape(b, await record(q, id, owner));
    });
  }
  return { get, save, change, list, create };
}
module.exports = { SCHEMA_SQL, createActivityStore, readPlanSource, insertPlan };
