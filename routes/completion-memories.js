const { UUID, fail } = require("../lib/task-attachment-policy");
const { isTaskRow } = require("../public/js/task-model");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS completion_memories (
  block_id TEXT NOT NULL REFERENCES blocks(id),
  revision TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  completed_on DATE NOT NULL,
  reflection TEXT NOT NULL DEFAULT '',
  photos JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (block_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_completion_memories_owner
  ON completion_memories (workspace_id, user_id, completed_on DESC);
`;

function mount(app, { pool }) {
  const base = "/api/completion-memories";
  function route(run, write = false) {
    return async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        const userId = Number(req.session?.userId);
        const workspaceId = req.workspaceId;
        if (!Number.isSafeInteger(userId) || userId < 1 || !workspaceId) throw fail("Sign in to see task memories", 401);
        if (write && (req.get("x-dcc-memory") !== "1" || req.get("sec-fetch-site") === "cross-site")) {
          throw fail("Use the task memory controls in DCC", 403);
        }
        await run(req, res, [workspaceId, userId]);
      } catch (error) {
        res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : "Task memories are temporarily unavailable" });
      }
    };
  }

  app.get(base, route(async (_req, res, actor) => {
    const { rows } = await pool.query(`
      SELECT m.* FROM completion_memories m
      JOIN workspaces w ON w.id=m.workspace_id AND w.owner_id=m.user_id
      JOIN blocks b ON b.id=m.block_id AND b.workspace_id=m.workspace_id
      WHERE m.workspace_id=$1 AND m.user_id=$2 AND b.deleted_at IS NULL
        AND (b.user_id IS NULL OR b.user_id=$2)
      ORDER BY m.completed_on DESC, m.block_id, m.revision`, actor);
    res.json(rows);
  }));

  app.post(base, route(async (req, res, actor) => {
    const { blockId, revision, reflection, photo, remove } = req.body || {};
    if (typeof blockId !== "string" || blockId.length > 255 ||
        typeof revision !== "string" || revision.length > 64 ||
        [reflection, photo, remove].filter(value => value !== undefined).length !== 1) throw fail("Invalid memory update");
    if (reflection !== undefined && (typeof reflection !== "string" || reflection.length > 10000)) throw fail("Reflection is too long");
    if (photo !== undefined && (!photo || typeof photo.id !== "string" || !UUID.test(photo.id) ||
        typeof photo.deviceId !== "string" || !UUID.test(photo.deviceId) ||
        typeof photo.deviceName !== "string" || !photo.deviceName.trim() || photo.deviceName.length > 80)) throw fail("Invalid photo details");
    if (remove !== undefined && (typeof remove !== "string" || !UUID.test(remove))) throw fail("Invalid photo identity");

    const taskPhotos = revision === "task-photos";
    if (taskPhotos && reflection !== undefined) throw fail("Invalid task photo update");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const keys = [...actor, blockId, revision];
      const { rows: [block] } = await client.query(`
        SELECT b.* FROM blocks b JOIN workspaces w ON w.id=b.workspace_id
        WHERE b.workspace_id=$1 AND w.owner_id=$2 AND b.id=$3
          AND b.deleted_at IS NULL AND (b.user_id IS NULL OR b.user_id=$2)
        FOR UPDATE OF b`, keys.slice(0, 3));
      if (!block || !isTaskRow(block)) throw fail("Task unavailable", 404);

      let { rows: [entry] } = await client.query(`
        SELECT * FROM completion_memories WHERE workspace_id=$1 AND user_id=$2 AND block_id=$3 AND revision=$4`, keys);
      if (!entry) {
        const p = block.properties || {};
        if (!taskPhotos && (!(p.done || p.status === "done" || p.completedAt) ||
            revision !== (p._completionRevision || p.completedAt || "original"))) throw fail("Completion unavailable", 409);
        const date = String(p.completedAt || "").slice(0, 10);
        ({ rows: [entry] } = await client.query(`
          INSERT INTO completion_memories(workspace_id,user_id,block_id,revision,title,completed_on)
          VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,$7::date,CURRENT_DATE)) RETURNING *`,
        [...keys, String(p.title || "Completed task"), /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, block.date]));
      }
      if (photo && !entry.photos.some(item => item.id === photo.id)) {
        if (entry.photos.length >= 10) throw fail("This photo collection can hold up to 10 photos", 409);
        entry.photos.push({ id: photo.id, deviceId: photo.deviceId, deviceName: photo.deviceName.trim() });
      }
      if (remove) entry.photos = entry.photos.filter(item => item.id !== remove);
      const { rows: [saved] } = await client.query(`
        UPDATE completion_memories SET reflection=$5, photos=$6
        WHERE workspace_id=$1 AND user_id=$2 AND block_id=$3 AND revision=$4 RETURNING *`,
      [...keys, reflection ?? entry.reflection, JSON.stringify(entry.photos)]);
      await client.query("COMMIT");
      res.json(saved);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }, true));
}

module.exports = { mount, SCHEMA_SQL };
