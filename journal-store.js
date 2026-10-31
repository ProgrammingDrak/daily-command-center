const { validateInkPage, INK_PAGE_MAX_BYTES } = require("./lib/ink-page-validation");

// Private journal task pages. Like task_activity_records, the content lives
// outside block JSON, operations, day-state, vault sync and every share/export
// path. The block only carries type "journal", forced-private visibility and a
// stable journalId reference (see TaskTypes.journalId / db.js).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_journal_pages (
  task_id TEXT PRIMARY KEY REFERENCES blocks(id),
  journal_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  ink JSONB,
  body TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  previous JSONB,
  last_mutation_id TEXT,
  last_payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_journal_pages_owner
  ON task_journal_pages(workspace_id, owner_user_id);
`;
const JOURNAL_ID_RE = /^jr_[a-z0-9-]{8,64}$/i;
const BODY_MAX = 20000;

function error(message, statusCode = 400, publicCode) {
  return Object.assign(new Error(message), { statusCode }, publicCode ? { publicCode } : {});
}
function revision(v) { if (!Number.isInteger(v) || v < 0) throw error("Expected revision is required"); return v; }
function validJournalId(id) { return typeof id === "string" && JOURNAL_ID_RE.test(id); }

// Ink is optional (a typed-only entry is valid); an ink page must pass the same
// validator the vault notebook ingest uses.
function validate(body) {
  const text = body.body == null ? "" : body.body;
  if (typeof text !== "string" || text.length > BODY_MAX) throw error(`Typed notes must be text of up to ${BODY_MAX} characters`);
  let ink = null;
  if (body.ink != null) {
    if (Buffer.byteLength(JSON.stringify(body.ink)) > INK_PAGE_MAX_BYTES) throw error("Handwritten page is too large", 413);
    try { ink = validateInkPage(body.ink); } catch (e) { throw error(e.message); }
  }
  return { ink, body: text };
}

function shape(block, row) {
  const p = block.properties || {};
  return { taskId: block.id, journalId: row?.journal_id || p.journalId || null,
    revision: row?.revision || 0, ink: row?.ink || null, body: row?.body || "",
    canUndo: !!row?.previous, updatedAt: row?.updated_at || null,
    removed: !!block.deleted_at };
}

function createJournalStore({ pool, blockDB, crypto = require("node:crypto") }) {
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (e) { await c.query("ROLLBACK"); throw e; }
    finally { c.release(); }
  }
  // Same block ownership rule as activity records. A miss, including another
  // owner's task, is a 404 so ids do not leak across accounts.
  async function block(q, id, owner, lock = false) {
    const { rows } = await q.query(`SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2
      AND (user_id=$3 OR user_id IS NULL)${lock ? " FOR UPDATE" : ""}`, [id, owner.workspaceId, owner.userId]);
    const b = rows[0];
    if (!b || !blockDB.isTaskRow(b)) throw error("Task not found", 404);
    return b;
  }
  async function page(q, id, owner) {
    const { rows } = await q.query("SELECT * FROM task_journal_pages WHERE task_id=$1 AND workspace_id=$2 AND owner_user_id=$3",
      [id, owner.workspaceId, owner.userId]);
    return rows[0] || null;
  }
  async function get(id, owner) {
    const b = await block(pool, id, owner), r = await page(pool, id, owner);
    if (!r && (b.properties || {}).type !== "journal") throw error("This task is not a journal", 404);
    return shape(b, r);
  }
  async function save(id, body, owner) {
    const value = validate(body), expected = revision(body.expectedRevision);
    const mutationId = body.mutationId || null;
    if (mutationId && !/^[-\w]{1,80}$/.test(mutationId)) throw error("Invalid save identifier");
    if (!validJournalId(body.journalId)) throw error("A valid journal id is required");
    const hash = crypto.createHash("sha256").update(JSON.stringify([value.ink, value.body])).digest("hex");
    return tx(async q => {
      const b = await block(q, id, owner, true), old = await page(q, id, owner);
      const p = b.properties || {};
      // Idempotent replay: the client may resend a save whose response it lost.
      if (mutationId && old?.last_mutation_id === mutationId) {
        if (old.last_payload_hash !== hash) throw error("Save identifier reused with different data", 409);
        return shape(b, old);
      }
      if (b.deleted_at) throw error("Restore the removed task before editing its journal", 409);
      if (p.type !== "journal") throw error("Only a Journal task can hold a journal page", 409);
      if (p.journalId !== body.journalId || (old && old.journal_id !== body.journalId)) throw error("This page belongs to a different journal", 409);
      if (!old) {
        const { rows: claimed } = await q.query("SELECT 1 FROM task_journal_pages WHERE journal_id=$1", [body.journalId]);
        if (claimed.length) throw error("This page belongs to a different journal", 409);
      }
      if ((old?.revision || 0) !== expected) throw error("This journal changed on another device", 409, "JOURNAL_CONFLICT");
      const previous = old ? { ink: old.ink, body: old.body, revision: old.revision } : null;
      const { rows } = await q.query(`INSERT INTO task_journal_pages
        (task_id,journal_id,workspace_id,owner_user_id,ink,body,revision,previous,last_mutation_id,last_payload_hash)
        VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)
        ON CONFLICT (task_id) DO UPDATE SET ink=EXCLUDED.ink,body=EXCLUDED.body,previous=EXCLUDED.previous,
          revision=task_journal_pages.revision+1,last_mutation_id=EXCLUDED.last_mutation_id,
          last_payload_hash=EXCLUDED.last_payload_hash,updated_at=NOW()
        WHERE task_journal_pages.workspace_id=EXCLUDED.workspace_id AND task_journal_pages.owner_user_id=EXCLUDED.owner_user_id
        RETURNING *`, [id, body.journalId, owner.workspaceId, owner.userId,
        value.ink == null ? null : JSON.stringify(value.ink), value.body, previous, mutationId, hash]);
      if (!rows.length) throw error("Task not found", 404);
      return shape(b, rows[0]);
    }).catch(e => {
      // Two tasks racing to claim one journal id: the unique index decides.
      if (e && e.code === "23505") throw error("This page belongs to a different journal", 409);
      throw e;
    });
  }
  // One-step server undo of the last accepted save, behind the same revision check.
  async function undo(id, body, owner) {
    const expected = revision(body.expectedRevision);
    return tx(async q => {
      const b = await block(q, id, owner, true), old = await page(q, id, owner);
      if (!old) throw error("Journal page not found", 404);
      // Same task guards as save(): no edits to a removed task or a non-journal row.
      if (b.deleted_at) throw error("Restore the removed task before editing its journal", 409);
      if ((b.properties || {}).type !== "journal") throw error("Only a Journal task can hold a journal page", 409);
      if (old.revision !== expected) throw error("This journal changed on another device", 409, "JOURNAL_CONFLICT");
      if (!old.previous) throw error("No previous version to restore", 409);
      const { rows } = await q.query(`UPDATE task_journal_pages SET ink=$4,body=$5,previous=$6,revision=revision+1,
        last_mutation_id=NULL,last_payload_hash=NULL,updated_at=NOW()
        WHERE task_id=$1 AND workspace_id=$2 AND owner_user_id=$3 RETURNING *`,
      [id, owner.workspaceId, owner.userId, old.previous.ink == null ? null : JSON.stringify(old.previous.ink),
        old.previous.body || "", { ink: old.ink, body: old.body, revision: old.revision }]);
      return shape(b, rows[0]);
    });
  }
  return { get, save, undo };
}

module.exports = { SCHEMA_SQL, JOURNAL_ID_RE, BODY_MAX, validJournalId, validate, createJournalStore };
