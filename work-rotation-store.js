// Manual foreground/background rotation. The private row serializes switches and
// reminder claims; task hierarchy, scheduling and completion remain in blocks.
const crypto = require("node:crypto");
const { createTaskTiming, isBlockDone } = require("./lib/task-timing");
const { createGuidedStore } = require("./guided-store");
const TaskModel = require("./public/js/task-model");
const { checkInState } = require("./public/js/work-checkin-policy");
const TaskTypes = require("./public/js/task-types");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_rotations (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 0,
 state JSONB NOT NULL DEFAULT '{"background":{},"operations":[]}',
 PRIMARY KEY(workspace_id,user_id)
);
ALTER TABLE work_rotations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON work_rotations FROM PUBLIC;
DO $rotation_privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
  EXECUTE format('REVOKE ALL ON work_rotations FROM %I',r);
 END LOOP;
END $rotation_privacy$;
`;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
function live(row) { return !!row && !row.deleted_at && !isBlockDone(row); }
function trackable(row) { return live(row) && TaskTypes.rule(row.properties,"actualTimeMode") === "work_sessions" && (TaskModel.foldsIntoItinerary(row) || (TaskModel.isTaskRow(row) && row.properties.kind === "backlog")); }
function timingIn(ctx, q) {
 const db = {...ctx.blockDB};
 for (const name of ["updateBlock","getBlockIncludingDeleted","getBlock","deleteBlock","createBlock","undeleteBlock"]) {
  db[name] = (...args) => ctx.blockDB[name](...args, q);
 }
 db.getTaskTimeEntries = (id, ws, opts) => ctx.blockDB.getTaskTimeEntries(id,ws,opts,q);
 db.ensureDayRoot = (date,user,ws) => ctx.blockDB.ensureDayRoot(date,user,ws,q);
 return createTaskTiming({pool:q,blockDB:db,timeZone:ctx.APP_TIME_ZONE || "America/New_York"});
}
function createWorkRotationStore(ctx) {
 const {pool,blockDB} = ctx, guided = createGuidedStore(ctx);
 async function snapshot(q, owner, row) {
  const ids=Object.keys(row.state.background || {});
  const tasks=ids.length ? (await q.query("SELECT * FROM blocks WHERE id=ANY($1::text[]) AND workspace_id=$2 AND user_id=$3 AND deleted_at IS NULL",[ids,owner.workspaceId,owner.userId])).rows : [];
  const background=tasks.filter(b=>live(b) && !b.properties.startedAt && b.properties.workStateOperationId===row.state.background[b.id].pausedOperationId).map(b=>({task:b,...row.state.background[b.id]}));
  return {revision:row.revision,background,serverNow:new Date().toISOString()};
 }
 async function get(owner) {
  const {rows}=await pool.query("SELECT * FROM work_rotations WHERE workspace_id=$1 AND user_id=$2",[owner.workspaceId,owner.userId]);
  return snapshot(pool,owner,rows[0] || {revision:0,state:{background:{}}});
 }
 async function mutate(owner, body) {
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision<0 || !/^[A-Za-z0-9:_-]{1,80}$/.test(body.operationId || "")) throw fail("Invalid rotation operation",400);
  if (!["switch","claim","snooze","dismiss"].includes(body.action)) throw fail("Unknown rotation action",400);
  const hash=crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const q=await pool.connect();
  try {
   await q.query("BEGIN");
   await q.query("INSERT INTO work_rotations(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[owner.workspaceId,owner.userId]);
   const row=(await q.query("SELECT * FROM work_rotations WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",[owner.workspaceId,owner.userId])).rows[0];
   const state=row.state, prior=state.operations.find(op=>op.id===body.operationId);
   if(prior) {
    if(prior.hash!==hash) throw fail("Operation identifier already used for different data");
    const ids=body.action==="switch"?[body.fromId,body.toId].filter(Boolean):[];
    const blocks=ids.length?(await q.query("SELECT * FROM blocks WHERE id=ANY($1::text[]) AND workspace_id=$2 AND user_id=$3",[ids,owner.workspaceId,owner.userId])).rows:[];
    const result={...await snapshot(q,owner,row),duplicate:true,claimed:false,blocks};
    await q.query("COMMIT");return result;
   }
   if(row.revision!==body.expectedRevision) throw fail("Work changed in another tab. Refresh and choose again.");
   const atMs=(ctx.now || Date.now)(),at=new Date(atMs).toISOString(),blocks=[];
   let claimed=false;
   // Remove closed/deleted/resumed backgrounds before considering another reminder.
   const current=await snapshot(q,owner,row);
   state.background=Object.assign(Object.create(null),Object.fromEntries(current.background.map(({task,...value})=>[task.id,value])));
   if(body.action === "switch") {
    const fromId=body.fromId || null,toId=body.toId;
    if(typeof toId!=="string" || toId.length>200 || (fromId!==null && typeof fromId!=="string") || fromId===toId) throw fail("Choose a different task",400);
    const minutes=body.remindMinutes;
    if(minutes!==null && (!Number.isInteger(minutes) || minutes<1 || minutes>1440)) throw fail("Use a reminder from 1 to 1440 minutes, or none",400);
    const ids=[fromId,toId].filter(Boolean).sort();
    const tasks=(await q.query("SELECT * FROM blocks WHERE id=ANY($1::text[]) AND workspace_id=$2 AND user_id=$3 ORDER BY id FOR UPDATE",[ids,owner.workspaceId,owner.userId])).rows;
    const from=tasks.find(b=>b.id===fromId),to=tasks.find(b=>b.id===toId);
    if(!trackable(to) || (fromId && !trackable(from))) throw fail("Task is completed, removed, or unavailable");
    if((from?.properties.startedAt || null)!==(body.fromStartedAt || null) || (fromId && !from.properties.startedAt)) throw fail("The current work session changed. Refresh and choose again.");
    if(to.properties.startedAt || (to.properties.workStateChangedAt || null)!==(body.toWorkStateChangedAt || null)) throw fail("The chosen task changed. Refresh and choose again.");
    // Legacy Start permits concurrent timers. Rotation must not silently choose
    // one of them, or leave another human-effort timer accumulating unnoticed.
    const active=(await q.query("SELECT * FROM blocks WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL AND properties->>'startedAt' IS NOT NULL",[owner.workspaceId,owner.userId])).rows.filter(trackable);
    if(active.some(b=>b.id!==fromId)) throw fail("Pause other running timers before switching tasks.");
    if(Object.keys(state.background).length>=50 && fromId && !state.background[fromId] && !state.background[toId]) throw fail("Dismiss an older background task before adding another.");
    const clock=timingIn(ctx,q),actor=`dcc:${owner.userId}`;
    if(from) {
     const safety=checkInState(from.properties,atMs), pauseAtMs=safety.shouldAutoPause?safety.autoPauseAtMs:atMs;
     if(from.properties.guidedDefinitionId) {
      const v=await guided.get(from.id,owner,q);
      if(v.session) await guided.act(from.id,{action:"pause",operationId:body.operationId+":pause",expectedRevision:v.revision},owner,q,pauseAtMs);
      else await clock.pauseWork({block:from,atMs:pauseAtMs,actor,actionId:body.operationId+":pause"});
     } else await clock.pauseWork({block:from,atMs:pauseAtMs,actor,actionId:body.operationId+":pause"});
     state.background[from.id]={pausedOperationId:body.operationId+":pause",generation:body.operationId,backgroundSince:at,dueAt:minutes===null?null:new Date(atMs+minutes*60000).toISOString(),notifiedAt:null};
    }
    if(to.properties.guidedDefinitionId) {
     const v=await guided.get(to.id,owner,q), preview=body.guided;
     if(!preview || preview.revision!==v.revision || preview.definitionRevision!==v.definitionRevision || preview.contextVersion!==v.contextVersion) throw fail("Guided instructions changed. Preview them again before switching.");
     await guided.act(to.id,{action:v.session?"resume":"start",operationId:body.operationId+":start",expectedRevision:preview.revision,expectedDefinitionRevision:preview.definitionRevision,expectedContextVersion:preview.contextVersion},owner,q,atMs);
    } else await clock.startWork({block:to,atMs,actor,actionId:body.operationId+":start"});
    const savedFrom=from && await blockDB.getBlock(from.id,q), savedTo=await blockDB.getBlock(to.id,q);
    if((savedFrom && savedFrom.properties.startedAt) || !savedTo.properties.startedAt) throw fail("The work clock changed. Refresh and retry the switch.");
    delete state.background[to.id];
    for(const id of ids) blocks.push(await blockDB.getBlock(id,q));
   } else {
    if(typeof body.taskId!=="string" || typeof body.generation!=="string" || !Object.hasOwn(state.background,body.taskId)) throw fail("This check-back is no longer current.");
    const item=state.background[body.taskId];
    if(!item || item.generation!==body.generation) throw fail("This check-back is no longer current.");
    if(body.action==="dismiss") delete state.background[body.taskId];
    if(body.action==="snooze") {
     if(!Number.isInteger(body.minutes) || body.minutes<1 || body.minutes>1440) throw fail("Invalid snooze",400);
     item.dueAt=new Date(atMs+body.minutes*60000).toISOString();item.generation=body.operationId;item.notifiedAt=null;
    }
    if(body.action==="claim" && item.dueAt && Date.parse(item.dueAt)<=atMs && !item.notifiedAt) {item.notifiedAt=at;claimed=true;}
   }
   state.operations.push({id:body.operationId,hash});state.operations=state.operations.slice(-100);
   row.revision++;
   await q.query("UPDATE work_rotations SET state=$3,revision=$4 WHERE workspace_id=$1 AND user_id=$2",[owner.workspaceId,owner.userId,state,row.revision]);
   const result={...await snapshot(q,owner,row),blocks,claimed};
   await q.query("COMMIT");return result;
  } catch(error) {await q.query("ROLLBACK");throw error;} finally {q.release();}
 }
 return {get,mutate};
}
module.exports={SCHEMA_SQL,createWorkRotationStore,timingIn,trackable};
