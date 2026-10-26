const M = require("./lib/guided-model");
const { createTaskTiming } = require("./lib/task-timing");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guided_definitions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
 definition JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS guided_sessions (
 task_id TEXT PRIMARY KEY REFERENCES blocks(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
 session JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS guided_definition_versions (
 definition_id TEXT NOT NULL REFERENCES guided_definitions(id), revision INTEGER NOT NULL,
 definition JSONB NOT NULL, provenance JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(definition_id,revision)
);
CREATE INDEX IF NOT EXISTS guided_definition_owner ON guided_definitions(workspace_id,owner_user_id);
CREATE INDEX IF NOT EXISTS guided_session_owner ON guided_sessions(workspace_id,owner_user_id);
`;
function createGuidedStore({ pool, blockDB, crypto = require("node:crypto"), APP_TIME_ZONE = "America/New_York" }) {
  async function tx(fn, transactionClient = null) {
    if(transactionClient) return fn(transactionClient);
    const q = await pool.connect();
    try { await q.query("BEGIN"); const result = await fn(q); await q.query("COMMIT"); return result; }
    catch (e) { await q.query("ROLLBACK"); throw e; } finally { q.release(); }
  }
  async function readDefinition(q, id, owner, lock = false) {
    const { rows } = await q.query(`SELECT * FROM guided_definitions WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3${lock ? " FOR UPDATE" : ""}`, [id, owner.workspaceId, owner.userId]);
    if (!rows[0]) throw M.error("Guided definition not found", 404);
    return rows[0];
  }
  async function readTask(q, id, owner, lock = false) {
    const { rows } = await q.query(`SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [id, owner.workspaceId, owner.userId]);
    if (!rows[0] || !blockDB.isTaskRow(rows[0])) throw M.error("Task not found", 404);
    return rows[0];
  }
  async function readSession(q, id, owner) {
    const { rows } = await q.query("SELECT * FROM guided_sessions WHERE task_id=$1 AND workspace_id=$2 AND owner_user_id=$3", [id, owner.workspaceId, owner.userId]);
    return rows[0] || null;
  }
  function shape(b, d, r) {
    const generatedAt = new Date().toISOString(), contextVersion = new Date(b.updated_at).toISOString();
    return { generatedAt, contextVersion, promptSchemaVersion: 1, taskId: b.id, occurrenceId: b.id, definitionId: d.id, title: b.properties.title,
      date: b.date, completed: blockDB.isCompletedTaskProps(b.properties), startedAt: b.properties.startedAt || null,
      revision: r?.revision || 0, definitionRevision: d.revision, definition: d.definition,
      session: r?.session || null, prompt: M.brief(d.definition, b, r?.session, {generatedAt,contextVersion,definitionRevision:d.revision,timeZone:APP_TIME_ZONE}) };
  }
  async function get(id, owner, q = pool) {
    const b = await readTask(q, id, owner);
    if (!b.properties.guidedDefinitionId) return {taskId:b.id,title:b.properties.title,revision:0,contextVersion:new Date(b.updated_at).toISOString(),definitionId:null,prompt:null};
    const d = await readDefinition(q, b.properties.guidedDefinitionId, owner);
    return shape(b, d, await readSession(q, id, owner));
  }
  async function list(owner) {
    const { rows: definitions } = await pool.query("SELECT * FROM guided_definitions WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY updated_at DESC LIMIT 200", [owner.workspaceId, owner.userId]);
    const { rows: tasks } = await pool.query(`SELECT b.id,b.date,b.properties->>'title' AS title,b.properties->>'status' AS status,
      b.properties->>'guidedDefinitionId' AS definition_id, s.session->>'state' AS session_state
      FROM blocks b JOIN guided_definitions d ON d.id=b.properties->>'guidedDefinitionId' AND d.workspace_id=$1 AND d.owner_user_id=$2
      LEFT JOIN guided_sessions s ON s.task_id=b.id AND s.workspace_id=$1 AND s.owner_user_id=$2
      WHERE b.workspace_id=$1 AND b.user_id=$2 AND b.deleted_at IS NULL
      ORDER BY b.created_at DESC LIMIT 200`, [owner.workspaceId, owner.userId]);
    return { definitions, tasks };
  }
  async function saveDefinition(body, owner, defId = null, provenance = {source:"manual-edit"}, transactionClient = null) {
    const value = M.definition(body.definition), expected = M.revision(body.expectedRevision);
    const id = defId || M.id(body.id);
    return tx(async q => {
      // Serialize create retries as well as updates before inspecting the revision.
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["guided-definition:" + id]);
      const { rows } = await q.query("SELECT * FROM guided_definitions WHERE id=$1", [id]);
      const old = rows[0];
      if (old && (old.workspace_id !== owner.workspaceId || old.owner_user_id !== owner.userId)) throw M.error("Definition not found", 404);
      if (old && JSON.stringify(M.definition(old.definition)) === JSON.stringify(value) && old.revision === expected + 1) return old;
      if ((old?.revision || 0) !== expected) throw M.error("Definition changed. Reload before saving", 409);
      const result = await q.query(`INSERT INTO guided_definitions(id,workspace_id,owner_user_id,definition) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET definition=EXCLUDED.definition,revision=guided_definitions.revision+1,updated_at=NOW() RETURNING *`, [id, owner.workspaceId, owner.userId, value]);
      await q.query("INSERT INTO guided_definition_versions(definition_id,revision,definition,provenance) VALUES($1,$2,$3,$4)", [id,result.rows[0].revision,value,provenance]);
      return result.rows[0];
    }, transactionClient);
  }
  async function versions(id, owner) {
    await readDefinition(pool,id,owner);
    return (await pool.query("SELECT revision,definition,provenance,created_at FROM guided_definition_versions WHERE definition_id=$1 ORDER BY revision DESC LIMIT 200",[id])).rows;
  }
  async function rollback(id, body, owner) {
    await readDefinition(pool,id,owner);
    const target=M.revision(body.targetRevision);
    const {rows}=await pool.query("SELECT definition FROM guided_definition_versions WHERE definition_id=$1 AND revision=$2",[id,target]);
    if(!rows[0]) throw M.error("Version not found",404);
    return saveDefinition({definition:rows[0].definition,expectedRevision:body.expectedRevision},owner,id,{source:"rollback",fromRevision:target});
  }
  async function createTask(body, owner) {
    const id = M.id(body.id), definitionId = M.id(body.definitionId);
    const date = M.text(body.date, "Date", 10, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw M.error("Invalid task date");
    return tx(async q => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["guided-task:" + id]);
      const d = await readDefinition(q, definitionId, owner);
      const { rows } = await q.query("SELECT * FROM blocks WHERE id=$1", [id]);
      if (rows[0]) {
        const b = await readTask(q, id, owner);
        if (b.properties.guidedDefinitionId !== definitionId || String(b.date instanceof Date ? b.date.toISOString() : b.date).slice(0,10) !== date) throw M.error("Creation identifier already used",409);
        return get(id, owner, q);
      }
      const parent = await blockDB.ensureDayRoot(date, owner.userId, owner.workspaceId, q);
      await blockDB.createItineraryTask({ id, date, parent_id: parent, ensureRoot: false, client: q, score: true,
        userId: owner.userId, workspaceId: owner.workspaceId,
        properties: { local_id: id, title: d.definition.title, type: "guided", kind: "manual_task", status: "open", duration: 30,
          all_day: true, all_day_start: date, all_day_end: new Date(Date.parse(date)+86400000).toISOString().slice(0,10),
          guidedDefinitionId: definitionId, publicVisibility: "private", source: "manual" } });
      return get(id, owner, q);
    });
  }
  async function attach(id, body, owner) {
    return tx(async q => {
      const b = await readTask(q,id,owner,true);
      if (body.expectedContextVersion !== new Date(b.updated_at).toISOString()) throw M.error("Task changed. Refresh before attaching instructions",409);
      if (b.properties.guidedDefinitionId || blockDB.isCompletedTaskProps(b.properties) || !["task","focus","habit","guided"].includes(b.properties.type || "task")) throw M.error("This task cannot change its guided definition",409);
      const d = await readDefinition(q,M.id(body.definitionId),owner);
      await blockDB.updateBlock(id,{properties:{...b.properties,type:"guided",guidedDefinitionId:d.id,publicVisibility:"private"}},q);
      return get(id,owner,q);
    });
  }
  function timing(q) {
    const db = { ...blockDB,
      updateBlock: (id, fields) => blockDB.updateBlock(id, fields, q),
      getBlockIncludingDeleted: id => blockDB.getBlockIncludingDeleted(id, q),
      getBlock: id => blockDB.getBlock(id, q),
      deleteBlock: id => blockDB.deleteBlock(id,q),
      createBlock: input => blockDB.createBlock(input, q),
      getTaskTimeEntries: (id, ws, opts) => blockDB.getTaskTimeEntries(id, ws, opts, q),
      ensureDayRoot: (date, userId, ws) => blockDB.ensureDayRoot(date, userId, ws, q) };
    return createTaskTiming({ pool: q, blockDB: db, timeZone: APP_TIME_ZONE });
  }
  async function act(id, body, owner) {
    const expected = M.revision(body.expectedRevision), operationId = M.id(body.operationId);
    if (!["start","resume","pause","progress","complete","feedback","preflight","reopen"].includes(body.action)) throw M.error("Unknown guided action");
    const payload = { action: body.action, progress: M.text(body.progress ?? "", "Progress", 12000),
      outcome: M.text(body.outcome ?? "", "Outcome", 6000), checked: body.checked ?? [], confirmed: body.confirmed === true };
    if (!Array.isArray(payload.checked) || payload.checked.length > 30 || payload.checked.some(i => !Number.isInteger(i) || i < 0)) throw M.error("Invalid checklist progress");
    if (payload.action === "complete" && (!payload.confirmed || !payload.outcome)) throw M.error("Confirm the outcome before completion");
    if(payload.action === "complete" && body.observations != null) {
      if(!Array.isArray(body.observations) || body.observations.length>12) throw M.error("At most 12 current observations are allowed");
      payload.observations=body.observations.map(o=>{
        if(!Number.isInteger(o.index) || o.index<0 || o.index>=12 || !M.ACCESS_STATES.includes(o.status)) throw M.error("Invalid completion observation");
        return {index:o.index,status:o.status,note:M.text(o.note ?? "","Current access evidence",2000,true),source:"user-or-assistant-reported"};
      });
      if(new Set(payload.observations.map(o=>o.index)).size!==payload.observations.length) throw M.error("Duplicate prerequisite observation");
    }
    if (payload.action === "preflight") {
      if(!Number.isInteger(body.prerequisiteIndex) || body.prerequisiteIndex<0 || body.prerequisiteIndex>=12 || !M.ACCESS_STATES.includes(body.status)) throw M.error("Invalid preflight observation");
      payload.observation={index:body.prerequisiteIndex,status:body.status,note:M.text(body.note ?? "","Access evidence",2000,body.status==="ready"),source:"user-or-assistant-reported"};
    }
    if (payload.action === "feedback") {
      payload.feedback = {};
      for(const key of ["worked","failed","blockers","corrections","proposedChanges"]) payload.feedback[key]=M.text(body.feedback?.[key] ?? "",key,4000);
      payload.feedback.proposedDefinition = body.feedback?.proposedDefinition ? M.definition(body.feedback.proposedDefinition) : null;
      payload.feedback.baseDefinitionRevision = M.revision(body.feedback?.baseDefinitionRevision);
    }
    const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    let propagation = [], broadcastIds=[id];
    const result = await tx(async q => {
      const b = await readTask(q, id, owner, true), d = await readDefinition(q, b.properties.guidedDefinitionId, owner), old = await readSession(q, id, owner);
      const prior = old?.session;
      const replay = prior?.events.find(e => e.operationId === operationId);
      if (replay) { if (replay.hash !== hash) throw M.error("Operation identifier already used for different data", 409); return shape(b,d,old); }
      if ((old?.revision || 0) !== expected) throw M.error("Session changed. Reload before continuing", 409);
      if (["start","resume"].includes(payload.action) && (body.expectedDefinitionRevision !== d.revision || body.expectedContextVersion !== new Date(b.updated_at).toISOString())) throw M.error("Prompt context changed. Refresh the preview before starting or resuming",409);
      if (!["feedback","reopen"].includes(payload.action) && (blockDB.isCompletedTaskProps(b.properties) || prior?.state === "completed")) throw M.error("This occurrence is completed. Create a new occurrence for new work",409);
      if(payload.action === "reopen" && (prior?.state!=="completed" || !blockDB.isCompletedTaskProps(b.properties))) throw M.error("Only a completed guided occurrence can be reopened",409);
      if (!prior && payload.action !== "start") throw M.error("Start this occurrence before recording progress",409);
      if (prior && payload.action === "start") throw M.error("This occurrence already has a session. Resume it",409);
      if(payload.action === "pause" && prior?.state === "paused" && !b.properties.startedAt) return shape(b,d,old);
      if(payload.action === "resume" && prior?.state === "active" && b.properties.startedAt) return shape(b,d,old);
      if (prior?.events.length >= 500 && !["pause","complete"].includes(payload.action)) throw M.error("Session history limit reached",409);
      const atMs = Date.now(), at = new Date(atMs).toISOString();
      const session = prior ? structuredClone(prior) : { id: crypto.randomUUID(), state: "active", startedAt: at,
        definitionRevision: d.revision, snapshot: d.definition, contextVersion: new Date(b.updated_at).toISOString(),
        taskDetail: d.definition.includeTaskDetail ? String(b.properties.detail || "").slice(0,12000) : "", checked: [], progress: "", outcome: "", access: {}, events: [] };
      if(!prior) session.initialPrompt={text:M.brief(d.definition,b,null,{generatedAt:at,definitionRevision:d.revision,contextVersion:new Date(b.updated_at).toISOString(),timeZone:APP_TIME_ZONE}),generatedAt:at,contextVersion:new Date(b.updated_at).toISOString(),definitionRevision:d.revision,promptSchemaVersion:1};
      if (payload.checked.some(i => i >= session.snapshot.checklist.length)) throw M.error("Checklist item is not in this session");
      if(payload.action === "preflight") {
        if(!session.snapshot.prerequisites?.[payload.observation.index]) throw M.error("Prerequisite is not in this session");
        session.access ||= {}; session.access[payload.observation.index]={...payload.observation,at};
      }
      if(payload.action === "complete") for(const observation of payload.observations || []) {
        if(!session.snapshot.prerequisites?.[observation.index]) throw M.error("Prerequisite is not in this session");
        session.access ||= {};session.access[observation.index]={...observation,at};
      }
      if(payload.action === "complete" && (session.snapshot.prerequisites || []).some((p,i)=>p.required && M.accessState(session.access?.[i],at)!=="ready")) throw M.error("A required prerequisite is unresolved or stale. Record a current permitted access check before completing",409);
      const clock = timing(q), workArgs = { block: b, atMs, actor: `dcc:${owner.userId}`, actionId: operationId };
      if (["start","resume"].includes(payload.action)) { await clock.startWork(workArgs); session.state = "active"; }
      if (["pause","complete"].includes(payload.action)) { await clock.pauseWork(workArgs); session.state = "paused"; }
      if (["progress","complete"].includes(payload.action)) { session.progress = payload.progress; session.checked = [...new Set(payload.checked)]; }
      if (payload.action === "complete") {
        // The canonical completion writer, timer ledger and guided outcome share one transaction.
        const completion = await blockDB.setTaskCompletion({ taskRef: id, completed: true, completedAt: at,
          mutationId: operationId, expectedRevision: b.properties._completionRevision || null,
          userId: owner.userId, workspaceId: owner.workspaceId, transactionClient: q, guidedCompletionTaskId:id });
        for(const affected of completion.affectedTasks || [completion.task]) {
          if(String(affected.user_id)!==String(owner.userId)) throw M.error("A nested task belongs to a different owner",409);
          await clock.completeWork({ ...workArgs, block: affected, actionId: operationId + ":finish", normalizeExisting: true });
        }
        broadcastIds=completion.broadcastIds || [id];
        session.state = "completed"; session.outcome = payload.outcome; session.completedAt = at;
        propagation = completion.responsibilityTransitions || [];
      }
      if(payload.action === "reopen") {
        const reopened=await blockDB.setTaskCompletion({taskRef:id,completed:false,mutationId:operationId,expectedRevision:b.properties._completionRevision || null,userId:owner.userId,workspaceId:owner.workspaceId,transactionClient:q,guidedCompletionTaskId:id});
        await clock.reopenWork({...workArgs,block:reopened.task,actionId:operationId+":reopen"});
        session.state="paused";session.outcome="";delete session.completedAt;
        propagation=reopened.responsibilityTransitions || [];broadcastIds=reopened.broadcastIds || [id];
      }
      if(payload.action === "feedback") session.feedback={...payload.feedback,recordedAt:at,recordedBy:`dcc:${owner.userId}`,source:"confirmed-conversation-feedback"};
      session.events.push({ ...(payload.action === "feedback" ? {feedback:session.feedback} : {}), ...(payload.action === "preflight" ? {observation:session.access[payload.observation.index]} : {}), ...(payload.observations ? {observations:payload.observations.map(o=>session.access[o.index])} : {}), operationId, hash, action: payload.action, at, progress: session.progress, checked: session.checked, outcome: session.outcome });
      if(Buffer.byteLength(JSON.stringify(session), "utf8") > 1000000 && !["pause","complete"].includes(payload.action)) throw M.error("Session history reached its size limit. Pause or complete this occurrence before beginning a new one",409);
      await q.query(`INSERT INTO guided_sessions(task_id,workspace_id,owner_user_id,session) VALUES($1,$2,$3,$4)
        ON CONFLICT(task_id) DO UPDATE SET session=EXCLUDED.session,revision=guided_sessions.revision+1,updated_at=NOW()`, [id, owner.workspaceId, owner.userId, session]);
      return get(id,owner,q);
    });
    for(const transition of propagation) await blockDB.propagateResponsibilityDone(transition);
    return {...result,broadcastIds};
  }
  async function applyFeedback(id,body,owner) {
    return tx(async q => {
      await readTask(q,id,owner,true);
      const current=await get(id,owner,q);
      if(current.revision!==M.revision(body.expectedSessionRevision)) throw M.error("Feedback changed. Refresh before applying",409);
      const f=current.session?.feedback;
      if(!f?.proposedDefinition) throw M.error("Save a proposed definition in feedback first");
      if(f.baseDefinitionRevision!==body.expectedRevision) throw M.error("The proposal is based on a different definition revision. Review it against the latest version",409);
      return saveDefinition({definition:f.proposedDefinition,expectedRevision:body.expectedRevision},owner,current.definitionId,
        {source:"reviewed-run-feedback",taskId:id,sessionId:current.session.id,sessionRevision:current.revision},q);
    });
  }
  return { list, get, saveDefinition, versions, rollback, applyFeedback, createTask, attach, act };
}
module.exports = { SCHEMA_SQL, createGuidedStore };
