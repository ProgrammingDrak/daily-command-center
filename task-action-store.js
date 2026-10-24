"use strict";
const policy = require("./public/js/task-action-policy");
const crypto = require("node:crypto");
const SCHEMA_SQL = `
ALTER TABLE access_grants ADD COLUMN IF NOT EXISTS task_permissions JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS task_action_requests (
 id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id), actor_user_id INTEGER NOT NULL REFERENCES users(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), task_id TEXT NOT NULL, action TEXT NOT NULL,
 payload JSONB NOT NULL, snapshot JSONB NOT NULL, request_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 result JSONB, reviewed_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(owner_user_id,actor_user_id,request_key), CHECK(status IN ('pending','executing','applied','rejected','failed'))
);
CREATE INDEX IF NOT EXISTS task_action_requests_owner ON task_action_requests(owner_user_id,status,created_at);
ALTER TABLE todo_task_reactions ALTER COLUMN share_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS todo_task_reactions_block ON todo_task_reactions(workspace_id,task_block_id);`;
function error(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function validate(action, input) {
  if (!policy.actions.includes(action)) throw error("Unknown task action");
  const p = input || {};
  if (typeof p !== "object" || Array.isArray(p)) throw error("Invalid action");
  if (action === "complete") {
    if (typeof p.completed !== "boolean") throw error("Choose complete or reopen");
    return { completed: p.completed };
  }
  if (action === "edit") {
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!title || title.length > 300) throw error("Title must be 1–300 characters");
    return { title };
  }
  if (action === "schedule") {
    const date = String(p.date || "");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw error("Choose a valid date");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.end) || p.end <= p.start)
      throw error("Choose a start and a later end");
    return { date, start: p.start, end: p.end };
  }
  if (action === "delegate") {
    const who = String(p.who || "").trim();
    if (!who || who.length > 120) throw error("Name who you are waiting on");
    return { who };
  }
  if (action === "react") {
    if (!["👍", "🙌", "🔥", "💪", "🎉", "❤️"].includes(p.emoji)) throw error("Choose a supported reaction");
    if (typeof p.active !== "boolean") throw error("Reaction state required");
    return { emoji: p.emoji, active: p.active };
  }
  if (action === "bounty") return {};
  const title = String(p.title || "").trim();
  if (!title || title.length > 180) throw error("Describe the reward (1–180 characters)");
  return { title };
}
function snapshot(row) {
  return {
    updatedAt: new Date(row.updated_at).toISOString(),
    date: row.date ? new Date(row.date).toISOString().slice(0, 10) : null,
    completionRevision: row.properties?._completionRevision || null,
    title: row.properties?.title || ""
  };
}
function createStore({ pool, blockDB, accessStore, socialStore, execute }) {
  async function access(actor, owner, client = pool) {
    if (!Number.isSafeInteger(actor) || actor <= 0 || !Number.isSafeInteger(owner) || owner <= 0)
      throw error("Sign in first", 401);
    const role = await accessStore.resolveRole(actor, owner, client);
    if (role === "none") throw error("You do not have access to this itinerary", 403);
    const workspaceId = await socialStore.resolveWorkspaceId(owner, client);
    if (!workspaceId) throw error("Itinerary unavailable", 403);
    const grant =
      actor === owner
        ? null
        : (
            await client.query(
              "SELECT task_permissions FROM access_grants WHERE owner_user_id=$1 AND grantee_user_id=$2 FOR SHARE",
              [owner, actor]
            )
          ).rows[0];
    if (actor !== owner && !grant) throw error("Access was revoked", 403);
    return {
      actorUserId: actor,
      userId: owner,
      workspaceId,
      role,
      modes: policy.resolve({ owner: actor === owner, allowed: true, permissions: grant?.task_permissions || {} })
    };
  }
  async function task(scope, id, client = pool) {
    const row = await blockDB.getBlock(id, client);
    if (
      !row ||
      row.deleted_at ||
      row.workspace_id !== scope.workspaceId ||
      !require("./public/js/task-model").foldsIntoItinerary(row) ||
      !row.properties?.title
    )
      throw error("Task unavailable", 404);
    return row;
  }
  async function submit({ actor, owner, taskId, action, payload, requestKey, expectedUpdatedAt }) {
    const clean = validate(action, payload);
    if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestKey))
      throw error("A unique request key is required");
    const client = await pool.connect();
    let request, mode;
    try {
      await client.query("BEGIN");
      const scope = await access(actor, owner, client);
      mode = policy.mode(scope.modes, action);
      if (mode === "view") throw error("You may view but cannot perform or suggest this action", 403);
      const row = await task(scope, taskId, client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `task-request:${owner}:${actor}:${requestKey}`
      ]);
      request = (
        await client.query(
          "SELECT * FROM task_action_requests WHERE owner_user_id=$1 AND actor_user_id=$2 AND request_key=$3",
          [owner, actor, requestKey]
        )
      ).rows[0];
      if (request) {
        if (
          request.task_id !== taskId ||
          request.action !== action ||
          !require("node:util").isDeepStrictEqual(request.payload, clean)
        )
          throw error("Request key already used for a different action", 409);
      } else {
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== snapshot(row).updatedAt)
          throw error("Task changed. Refresh before applying.", 409);
        request = (
          await client.query(
            `INSERT INTO task_action_requests(id,owner_user_id,actor_user_id,workspace_id,task_id,action,payload,snapshot,request_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [crypto.randomUUID(), owner, actor, scope.workspaceId, taskId, action, clean, snapshot(row), requestKey]
          )
        ).rows[0];
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    if (mode === "execute" && request.status === "pending")
      return decide({ actor, owner, id: request.id, decision: "approve", direct: true });
    return request;
  }
  async function decide({ actor, owner, id, decision, direct = false }) {
    if (!["approve", "reject"].includes(decision)) throw error("Choose approve or reject");
    const client = await pool.connect();
    let request,
      released = false;
    try {
      await client.query("BEGIN");
      const scope = await access(actor, owner, client);
      request = (
        await client.query("SELECT * FROM task_action_requests WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [
          id,
          owner
        ])
      ).rows[0];
      if (!request) throw error("Suggestion unavailable", 404);
      if (
        actor !== owner &&
        (!direct || request.actor_user_id !== actor || policy.mode(scope.modes, request.action) !== "execute")
      )
        throw error("Only the owner can review suggestions", 403);
      if (request.status !== "pending") {
        await client.query("COMMIT");
        return request;
      }
      if (decision === "reject") {
        request = (
          await client.query(
            "UPDATE task_action_requests SET status='rejected',reviewed_by=$2,updated_at=NOW() WHERE id=$1 RETURNING *",
            [id, actor]
          )
        ).rows[0];
        await client.query("COMMIT");
        return request;
      }
      const proposer = await access(request.actor_user_id, owner, client);
      if (policy.mode(proposer.modes, request.action) === "view")
        throw error("The proposer no longer has permission", 409);
      const current = await task(scope, request.task_id, client);
      if (snapshot(current).updatedAt !== request.snapshot.updatedAt)
        throw error("Task changed. Reject this suggestion and make a fresh one.", 409);
      // Durable claim BEFORE execution. A crash/unknown outcome remains executing;
      // it is never silently retried as a second completion, move, bounty or reward.
      request = (
        await client.query(
          "UPDATE task_action_requests SET status='executing',reviewed_by=$2,updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, actor]
        )
      ).rows[0];
      await client.query("COMMIT");
      client.release();
      released = true;
      const result = await execute({ ...scope, actorUserId: request.actor_user_id }, request, current);
      return (
        await pool.query(
          "UPDATE task_action_requests SET status='applied',result=$2,updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, result || {}]
        )
      ).rows[0];
    } catch (e) {
      if (!released) await client.query("ROLLBACK");
      if (request?.status === "executing" && e.statusCode >= 400 && e.statusCode < 500)
        await pool.query("UPDATE task_action_requests SET status='failed',result=$2,updated_at=NOW() WHERE id=$1", [
          id,
          { error: e.message }
        ]);
      throw e;
    } finally {
      if (!released) client.release();
    }
  }
  async function list(actor, owner, before = null) {
    await access(actor, owner);
    return (
      await pool.query(
        `SELECT * FROM task_action_requests WHERE owner_user_id=$1 AND ($1=$2 OR actor_user_id=$2) AND status IN ('pending','executing') AND ($3::text IS NULL OR id < $3) ORDER BY id DESC LIMIT 101`,
        [owner, actor, before]
      )
    ).rows;
  }
  async function authorize(request, client) {
    // Block insertion and canonical action share the same pair lock. The grant
    // SHARE lock then serializes downgrade/revocation with the actual mutation.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `task-access:${[request.actor_user_id, request.owner_user_id].sort((a, b) => a - b).join(":")}`
    ]);
    const scope = await access(request.actor_user_id, request.owner_user_id, client);
    const mode = policy.mode(scope.modes, request.action);
    if (mode === "view" || (request.reviewed_by !== request.owner_user_id && mode !== "execute"))
      throw error("Action permission was revoked or changed", 403);
    return scope;
  }
  return { access, task, submit, decide, list, authorize };
}
module.exports = { SCHEMA_SQL, createStore, validate, snapshot };
