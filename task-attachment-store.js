const { MAX_FILES, MAX_OWNER_FILES, MAX_OWNER_BYTES, fail, keyFor, assertKey } = require("./lib/task-attachment-policy");
const { isTaskRow } = require("./public/js/task-model");
const crypto = require("node:crypto");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_attachments (
  id UUID PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES blocks(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 10485760),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_parent ON task_attachments(block_id, user_id);
`;
function publicRow(row) {
  return { id: row.id, filename: row.filename, mime: row.mime, size: row.size, uploadedAt: row.created_at, removed: !!row.deleted_at, pending: row.state === "pending" };
}
function createStore({ pool, storage }) {
  // Writes lock the owner row (quota serialization) and the parent. Reads take no
  // row locks, so listing and downloads never stall block saves or FK checks.
  async function transaction(actor, blockId, run, { read = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!read) await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.userId]);
      // Owner only. Neither invited workspace members nor commitment roles grant private Notes access.
      const { rows } = await client.query(`SELECT b.* FROM blocks b JOIN workspaces w ON w.id=b.workspace_id
        WHERE b.id=$1 AND b.workspace_id=$2 AND w.owner_id=$3 AND (b.user_id IS NULL OR b.user_id=$3)
        AND b.deleted_at IS NULL${read ? "" : " FOR UPDATE OF b,w"}`, [blockId, actor.workspaceId, actor.userId]);
      if (!rows[0] || !isTaskRow(rows[0])) throw fail("Task or note unavailable", 404);
      const result = await run(client);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function find(client, actor, blockId, id) {
    const { rows } = await client.query("SELECT * FROM task_attachments WHERE id=$1 AND block_id=$2 AND user_id=$3 AND workspace_id=$4", [id, blockId, actor.userId, actor.workspaceId]);
    if (!rows[0]) throw fail("Attachment unavailable", 404);
    assertKey(rows[0], actor); return rows[0];
  }
  async function capacity(client, actor, blockId, size) {
    const { rows } = await client.query(`SELECT COUNT(*) FILTER (WHERE block_id=$2 AND deleted_at IS NULL) AS count,
      COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes FROM task_attachments WHERE user_id=$1`, [actor.userId, blockId]);
    if (Number(rows[0].count) >= MAX_FILES) throw fail("A task or note can hold at most 20 files", 409);
    if (size && Number(rows[0].total) >= MAX_OWNER_FILES) throw fail("Private file record limit reached (200, including removed files)", 409);
    if (Number(rows[0].bytes) + size > MAX_OWNER_BYTES) throw fail("Private file storage limit reached (200 MB, including removed files)", 409);
  }
  return {
    configured: storage.configured,
    async authorize(actor, blockId) { return transaction(actor, blockId, async () => true, { read: true }); },
    async list(actor, blockId) {
      return transaction(actor, blockId, async client => {
        const { rows } = await client.query("SELECT * FROM task_attachments WHERE block_id=$1 AND user_id=$2 AND workspace_id=$3 ORDER BY created_at", [blockId, actor.userId, actor.workspaceId]);
        return rows.map(publicRow);
      }, { read: true });
    },
    async upload(actor, blockId, id, meta, bytes) {
      if (!storage.configured) throw fail("Private task file storage is not configured", 503);
      // Commit a reservation BEFORE storing bytes. Crashes/failures retain a private,
      // quota-counted key; retries overwrite that same key rather than orphaning another.
      const reservation = await transaction(actor, blockId, async client => {
        const existing = await client.query("SELECT * FROM task_attachments WHERE id=$1", [id]);
        if (existing.rows[0]) {
          const row = await find(client, actor, blockId, id);
          if (row.deleted_at || row.sha256 !== meta.sha256 || row.filename !== meta.filename || row.mime !== meta.mime) throw fail("Upload identity already used; select the file again", 409);
          return row;
        }
        await capacity(client, actor, blockId, meta.size);
        const key = keyFor(actor.userId, actor.workspaceId, blockId, id);
        const { rows } = await client.query(`INSERT INTO task_attachments(id,block_id,workspace_id,user_id,object_key,filename,mime,size,sha256)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id,blockId,actor.workspaceId,actor.userId,key,meta.filename,meta.mime,meta.size,meta.sha256]);
        return rows[0];
      });
      if (reservation.state === "ready") return publicRow(reservation);
      await storage.put(reservation.object_key, bytes, meta.mime);
      return transaction(actor, blockId, async client => {
        const row = await find(client, actor, blockId, id);
        if (row.deleted_at) throw fail("Attachment removed", 409);
        const { rows } = await client.query("UPDATE task_attachments SET state='ready' WHERE id=$1 RETURNING *", [id]);
        return publicRow(rows[0]);
      });
    },
    async download(actor, blockId, id) {
      // Authorize in a short read, then fetch bytes with no connection or lock held.
      // A removal racing the fetch can at most serve the owner a file removed moments ago.
      const row = await transaction(actor, blockId, async client => {
        const found = await find(client, actor, blockId, id);
        if (found.deleted_at || found.state !== "ready") throw fail("Attachment unavailable", 404);
        return found;
      }, { read: true });
      const bytes = await storage.get(row.object_key);
      if (bytes.length !== row.size || crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw fail("Stored file failed its integrity check", 502);
      return { ...publicRow(row), bytes };
    },
    async remove(actor, blockId, id) {
      return transaction(actor, blockId, async client => {
        await find(client, actor, blockId, id);
        await client.query("UPDATE task_attachments SET deleted_at=COALESCE(deleted_at,NOW()) WHERE id=$1", [id]);
      });
    },
    async restore(actor, blockId, id) {
      return transaction(actor, blockId, async client => {
        const row = await find(client, actor, blockId, id);
        if (row.deleted_at) { await capacity(client, actor, blockId, 0); await client.query("UPDATE task_attachments SET deleted_at=NULL WHERE id=$1", [id]); }
      });
    },
  };
}
module.exports = { SCHEMA_SQL, createStore };
