const crypto = require("node:crypto");
const M = require("./lib/conversation-model");
const { version } = require("./lib/task-reconciliation");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mcp_approvals (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 connection_id TEXT NOT NULL, operation TEXT NOT NULL, payload JSONB NOT NULL, payload_hash TEXT NOT NULL,
 manifest JSONB NOT NULL, scopes JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,workspace_id,connection_id,payload_hash)
);
CREATE TABLE IF NOT EXISTS mcp_action_log (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 connection_id TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, approval_id TEXT, affected_ids JSONB NOT NULL DEFAULT '[]',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mcp_action_log ADD COLUMN IF NOT EXISTS affected_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE mcp_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_action_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mcp_approvals,mcp_action_log FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON mcp_approvals,mcp_action_log FROM %I',r);
 END LOOP;
END $privacy$;`;
function highImpact(name, args) {
  return (
    name === "dcc_correct_time" ||
    (name === "dcc_organization" && args.action === "import") ||
    (name === "dcc_bulk_cleanup" && ["run", "undo"].includes(args.action))
  );
}
function createApprovalStore({ pool, blockDB, now = Date.now }) {
  async function snapshot(q, actor) {
    // Include all owned rows so imports/recurrence/correction dependencies cannot
    // change between review and commit. This deliberately conflicts on unrelated edits.
    const rows = (
      await q.query("SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 ORDER BY id", [
        actor.userId,
        actor.workspaceId
      ])
    ).rows;
    if (rows.length > 10000) throw M.fail("Account is too large for this operation; narrow it in DCC", 409);
    return rows.map((b) => ({
      id: b.id,
      title: b.properties?.title || b.type,
      version: version(blockDB.parseBlock(b))
    }));
  }
  async function prepare(name, args, actor, scopes) {
    const payload = JSON.parse(JSON.stringify(args));
    const digest = M.digest({ name, payload });
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + actor.userId]);
      let cleanupManifest = null;
      if (name === "dcc_bulk_cleanup") {
        const job = (
          await q.query("SELECT * FROM chat_cleanup_jobs WHERE id=$1 AND user_id=$2 AND workspace_id=$3", [
            args.jobId,
            actor.userId,
            actor.workspaceId
          ])
        ).rows[0];
        if (!job) throw M.fail("Cleanup not found", 404);
        cleanupManifest = job.manifest;
      }
      const manifest = { records: await snapshot(q, actor), cleanup: cleanupManifest };
      const existing = (
        await q.query(
          "SELECT * FROM mcp_approvals WHERE user_id=$1 AND workspace_id=$2 AND connection_id=$3 AND payload_hash=$4",
          [actor.userId, actor.workspaceId, actor.grantId, digest]
        )
      ).rows[0];
      if (existing) {
        await q.query("COMMIT");
        return receipt(existing);
      }
      const id = crypto.randomUUID();
      const r = (
        await q.query(
          "INSERT INTO mcp_approvals(id,user_id,workspace_id,connection_id,operation,payload,payload_hash,manifest,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            id,
            actor.userId,
            actor.workspaceId,
            actor.grantId,
            name,
            JSON.stringify(payload),
            digest,
            JSON.stringify(manifest),
            JSON.stringify(scopes),
            new Date(now() + 600000)
          ]
        )
      ).rows[0];
      await q.query("COMMIT");
      return receipt(r);
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  function receipt(r) {
    return {
      approvalId: r.id,
      status: r.status,
      saveStatus: r.status === "approved" ? "verified_saved" : "pending_approval",
      reviewUrl: "/connections/conversation/approvals/" + r.id,
      ...(r.status === "approved" ? { result: r.result } : {})
    };
  }
  async function get(id, actor) {
    const r = (
      await pool.query("SELECT * FROM mcp_approvals WHERE id=$1 AND user_id=$2 AND workspace_id=$3", [
        id,
        actor.userId,
        actor.workspaceId
      ])
    ).rows[0];
    if (!r) throw M.fail("Approval not found", 404);
    return r;
  }
  async function decide(id, actor, decision, { revalidate, execute }) {
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + actor.userId]);
      const r = (
        await q.query("SELECT * FROM mcp_approvals WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE", [
          id,
          actor.userId,
          actor.workspaceId
        ])
      ).rows[0];
      if (!r) throw M.fail("Approval not found", 404);
      // Permission/revocation is checked even on a replay before exposing a result.
      const identity = await revalidate(r.connection_id, actor, q);
      if (r.scopes.some((s) => !identity.scopes.includes(s))) throw M.fail("Connection permissions changed", 403);
      if (r.status !== "pending") {
        await q.query("COMMIT");
        return receipt(r);
      }
      if (new Date(r.expires_at).getTime() <= now()) throw M.fail("Approval expired; request a new operation", 409);
      if (!["approve", "deny"].includes(decision)) throw M.fail("Invalid decision");
      if (decision === "deny") {
        await q.query("UPDATE mcp_approvals SET status='denied' WHERE id=$1", [id]);
        await q.query(
          "INSERT INTO mcp_action_log(id,user_id,workspace_id,connection_id,operation,outcome,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [crypto.randomUUID(), actor.userId, actor.workspaceId, r.connection_id, r.operation, "denied", id]
        );
        await q.query("COMMIT");
        return { approvalId: id, status: "denied" };
      }
      if (r.payload_hash !== M.digest({ name: r.operation, payload: r.payload }))
        throw M.fail("Approval payload changed", 409);
      if (M.digest(await snapshot(q, actor)) !== M.digest(r.manifest.records))
        throw M.fail("Records changed; request a new review", 409);
      if (r.manifest.cleanup) {
        const job = (
          await q.query(
            "SELECT manifest FROM chat_cleanup_jobs WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE",
            [r.payload.jobId, actor.userId, actor.workspaceId]
          )
        ).rows[0];
        if (!job || M.digest(job.manifest) !== M.digest(r.manifest.cleanup))
          throw M.fail("Cleanup selection changed", 409);
      }
      let result = await execute(r.operation, r.payload, identity, q);
      if (r.operation === "dcc_bulk_cleanup") {
        for (let batch = 1; ["running", "restoring"].includes(result.status) && batch < 201; batch++)
          result = await execute(r.operation, r.payload, identity, q);
        if (["running", "restoring"].includes(result.status)) throw M.fail("Cleanup exceeded its reviewed limit", 409);
      }
      await q.query("UPDATE mcp_approvals SET status='approved',result=$1 WHERE id=$2", [JSON.stringify(result), id]);
      await q.query(
        "INSERT INTO mcp_action_log(id,user_id,workspace_id,connection_id,operation,outcome,approval_id,affected_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          crypto.randomUUID(),
          actor.userId,
          actor.workspaceId,
          r.connection_id,
          r.operation,
          "approved",
          id,
          JSON.stringify(
            r.manifest.cleanup
              ? r.manifest.cleanup.map((x) => x.id)
              : [result.projectId, ...(result.taskIds || []), ...(result.affectedTasks || []).map((x) => x.id)].filter(
                  Boolean
                )
          )
        ]
      );
      await q.query("COMMIT");
      return { approvalId: id, status: "approved", saveStatus: "verified_saved", result };
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  return { prepare, get, decide, receipt };
}
module.exports = { SCHEMA_SQL, createApprovalStore, highImpact };
