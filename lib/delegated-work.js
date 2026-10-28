// Explicit delegated-work reports. They never manipulate human effort clocks.
const M = require("./conversation-model");
const Q = require("./working-queue");
const { isBlockDone } = require("./task-timing");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS delegated_work (
 user_id INTEGER NOT NULL REFERENCES users(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 work_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES blocks(id),report JSONB NOT NULL,
 PRIMARY KEY(user_id,workspace_id,work_key)
);
CREATE INDEX IF NOT EXISTS delegated_work_task ON delegated_work(user_id,workspace_id,task_id);
ALTER TABLE delegated_work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON delegated_work FROM PUBLIC;
DO $delegation_privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON delegated_work FROM %I',r);
 END LOOP;
END $delegation_privacy$;
`;
const PHASES = ["working", "paused", "blocked", "needs-review", "completed"];
const KINDS = ["coding", "email-draft", "research", "other"];
function validate(b) {
  const d = b.delegation;
  if (
    !d ||
    typeof d !== "object" ||
    Array.isArray(d) ||
    Object.keys(d).some(
      (k) =>
        ![
          "work",
          "sequence",
          "phase",
          "note",
          "reviewActions",
          "intent",
          "createIfMissing",
          "title",
          "parentTaskId"
        ].includes(k)
    )
  )
    throw M.fail("Invalid delegated work report");
  const w = d.work;
  if (
    !w ||
    typeof w !== "object" ||
    Array.isArray(w) ||
    Object.keys(w).some((k) => !["source", "id", "kind", "repository", "worktreeId", "codingTaskId"].includes(k))
  )
    throw M.fail("Invalid canonical work identity");
  for (const k of ["source", "id"]) M.text(w[k], k, 240);
  if (!KINDS.includes(w.kind)) throw M.fail("Choose a delegated work kind");
  if (w.kind === "coding") for (const k of ["repository", "worktreeId", "codingTaskId"]) M.text(w[k], k, 240);
  else if (["repository", "worktreeId", "codingTaskId"].some((k) => w[k] != null))
    throw M.fail("Coding identity fields require coding work");
  if (!Number.isSafeInteger(d.sequence) || d.sequence < 1) throw M.fail("Use a positive, increasing work sequence");
  if (!PHASES.includes(d.phase)) throw M.fail("Invalid delegated work phase");
  M.text(d.note, "concise activity note", 1000);
  if (
    !Array.isArray(d.reviewActions) ||
    d.reviewActions.length > 5 ||
    d.reviewActions.some((a) => typeof a !== "string" || !a.trim() || a.length > 240)
  )
    throw M.fail("Provide up to five concise human review actions");
  if (["blocked", "needs-review"].includes(d.phase) && !d.reviewActions.length)
    throw M.fail("Name the review or unblock action that remains");
  if (!["blocked", "needs-review"].includes(d.phase) && d.reviewActions.length)
    throw M.fail("Pending human actions require blocked or needs-review status");
  if (b.action === "delegated-register") {
    if (d.intent !== "explicit-work-handoff")
      throw M.fail("Registration requires an explicit work handoff, not a question or retrieval");
    if (d.phase === "completed") throw M.fail("Register open delegated work first");
    if (d.createIfMissing != null && typeof d.createIfMissing !== "boolean") throw M.fail("Invalid createIfMissing");
    if (d.title != null) M.text(d.title, "task title", 200);
    if (d.parentTaskId != null) M.text(d.parentTaskId, "parent task ID");
    if (b.taskId && d.parentTaskId) throw M.fail("Link existing tasks without reparenting them");
  } else if (["intent", "createIfMissing", "title", "parentTaskId"].some((k) => d[k] != null))
    throw M.fail("Only registration can link or create work");
}
function keyFor(work) {
  return M.digest({ source: work.source, id: work.id });
}
async function apply(q, owner, data, b, ctx, resolveTask) {
  const d = b.delegation,
    key = keyFor(d.work);
  const found = (
    await q.query(
      "SELECT b.*,d.report FROM delegated_work d JOIN blocks b ON b.id=d.task_id AND b.user_id=d.user_id AND b.workspace_id=d.workspace_id WHERE d.user_id=$1 AND d.workspace_id=$2 AND d.work_key=$3 FOR UPDATE OF b,d",
      [owner.userId, owner.workspaceId, key]
    )
  ).rows;
  if (found.length > 1) throw M.fail("Work identity has conflicting task bindings; resolve explicitly", 409);
  const prior = found[0]?.report;
  if (found[0]) delete found[0].report;
  let task = found[0] ? ctx.blockDB.parseBlock(found[0]) : null,
    created = false;
  if (task?.deleted_at)
    throw M.fail("The linked task was deleted; restore it explicitly rather than creating a duplicate", 410);
  if (task && b.taskId && task.id !== b.taskId)
    throw M.fail("This work identity is already linked to a different canonical task", 409);
  if (!task) {
    if (b.action !== "delegated-register") throw M.fail("Register this work identity before reporting progress", 409);
    if (b.taskId) task = await resolveTask(q, b.taskId, owner);
    else {
      if (!d.createIfMissing || !d.title)
        throw M.fail("Select an existing canonical task, or explicitly allow creation with a title", 409);
      const matches = (
        await q.query(
          "SELECT id FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND dcc_is_task_row(type,properties) AND lower(btrim(properties->>'title'))=lower(btrim($3)) LIMIT 10",
          [owner.userId, owner.workspaceId, d.title]
        )
      ).rows;
      if (matches.length)
        throw M.fail("Select the existing canonical task before creating: " + matches.map((r) => r.id).join(", "), 409);
      let parent = null;
      if (d.parentTaskId) {
        parent = await resolveTask(q, d.parentTaskId, owner);
        if (isBlockDone(parent)) throw M.fail("Choose an open parent task", 409);
      }
      const id = "delegated-" + M.digest({ owner, key }).slice(0, 40);
      if (await ctx.blockDB.getBlockIncludingDeleted(id, q))
        throw M.fail("A previous task exists for this identity; resolve it explicitly", 409);
      task = await ctx.blockDB.createBlock(
        {
          id,
          type: "block",
          user_id: owner.userId,
          workspace_id: owner.workspaceId,
          parent_id: parent?.id || null,
          date: parent?.date || null,
          properties: {
            local_id: id,
            type: "task",
            kind: parent?.date ? "manual_task" : "backlog",
            title: d.title.trim(),
            status: "open",
            source: "delegated-work",
            publicVisibility: "private",
            ...(parent ? { subtaskOf: parent.properties.local_id || parent.id } : {})
          }
        },
        q
      );
      created = true;
    }
  }
  if (!ctx.blockDB.isTaskRow(task)) throw M.fail("Choose a canonical task occurrence", 409);
  if (prior && M.digest(prior.work) !== M.digest(d.work))
    throw M.fail("Work identity metadata changed; use the original identity when resuming", 409);
  const contentHash = M.digest({
    phase: d.phase,
    note: d.note,
    reviewActions: d.reviewActions,
    at: b.at,
    sequence: d.sequence
  });
  if (prior && (d.sequence < prior.sequence || (d.sequence === prior.sequence && prior.contentHash !== contentHash)))
    throw M.fail("Stale or conflicting delegated work sequence", 409);
  if (prior && d.sequence === prior.sequence)
    return { task, delegated: { key, created: false, reused: true, activity: prior } };
  if (prior && M.instant(b.at) < M.instant(prior.at))
    throw M.fail("Progress timestamp precedes the current report", 409);
  if (isBlockDone(task) && d.phase !== "completed")
    throw M.fail("The canonical task is completed; reopen explicitly before resuming work", 409);
  if (d.phase === "completed" && !isBlockDone(task))
    throw M.fail(
      "Confirm the entire request is done using the authorized task-completion command first; ready deliverables belong in Needs You",
      409
    );
  const count = (
    await q.query("SELECT count(*)::int AS n FROM delegated_work WHERE user_id=$1 AND workspace_id=$2 AND task_id=$3", [
      owner.userId,
      owner.workspaceId,
      task.id
    ])
  ).rows[0].n;
  if (!prior && count >= 20)
    throw M.fail("This task already has 20 delegated work identities; select an appropriate task", 409);
  const activity = {
    work: d.work,
    sequence: d.sequence,
    phase: d.phase,
    note: d.note,
    reviewActions: d.reviewActions,
    at: b.at,
    receivedAt: new Date().toISOString(),
    sourceEventId: b.sourceEventId,
    contentHash
  };
  await q.query(
    `INSERT INTO delegated_work(user_id,workspace_id,work_key,task_id,report) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,workspace_id,work_key) DO UPDATE SET report=EXCLUDED.report`,
    [owner.userId, owner.workspaceId, key, task.id, activity]
  );
  // Registration adds membership once. Later reports respect human removal/pause/focus.
  if (b.action === "delegated-register" && !Object.hasOwn(data.items, task.id) && !prior)
    Q.setStatus(data, task, "background", { ...b, remindMinutes: null });
  return { task, delegated: { key, created, reused: !!prior, activity } };
}
module.exports = { SCHEMA_SQL, validate, apply, keyFor, PHASES, KINDS };
