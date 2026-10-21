// Task-scoped, addressed participation. Private task rows remain the sole
// authority for completion, history, rewards, offline replay and workout logs.
const W = require('./public/js/workout-model');
const { instructionPlan } = require('./lib/shared-workout-instructions');
const TaskModel = require('./public/js/task-model');
const { coerceDateString } = require('./lib/route-helpers');
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS shared_task_occurrences (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL UNIQUE REFERENCES blocks(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL, occurrence_date DATE NOT NULL,
  task_type TEXT NOT NULL, duration INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE shared_task_occurrences ADD COLUMN IF NOT EXISTS instructions JSONB;
CREATE TABLE IF NOT EXISTS shared_task_participants (
  share_id TEXT NOT NULL REFERENCES shared_task_occurrences(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','declined','removed')),
  task_id TEXT UNIQUE REFERENCES blocks(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (share_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_task_participant_user
  ON shared_task_participants(user_id,state);
`;
function fail(message = 'Shared task not found', statusCode = 404) {
  throw Object.assign(new Error(message), { statusCode });
}
function createSharedTaskStore({ pool, blockDB, socialStore, crypto = require('node:crypto') }) {
  async function tx(fn) {
    const q = await pool.connect();
    try { await q.query('BEGIN'); const value = await fn(q); await q.query('COMMIT'); return value; }
    catch (e) { await q.query('ROLLBACK'); throw e; }
    finally { q.release(); }
  }
  async function assertOwner(q, actor) {
    if (!actor?.userId || !actor.workspaceId) fail('Sign in first', 401);
    const { rows } = await q.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'", [actor.workspaceId, actor.userId]);
    if (!rows.length) fail('Workspace owner required', 403);
  }
  async function live(q, id, actor, lock = false) {
    await assertOwner(q, actor);
    const { rows } = await q.query(`SELECT s.* FROM shared_task_occurrences s
      JOIN blocks b ON b.id=s.source_task_id AND b.workspace_id=s.workspace_id
      JOIN workspace_members w ON w.workspace_id=s.workspace_id AND w.user_id=s.owner_user_id AND w.role='owner'
      WHERE s.id=$1 AND b.deleted_at IS NULL ${lock ? 'FOR UPDATE OF s' : ''}`, [id]);
    const share = rows[0];
    if (!share) fail();
    if (share.owner_user_id !== actor.userId && !await socialStore.areFriends(share.owner_user_id, actor.userId, q)) fail();
    const members = await q.query('SELECT * FROM shared_task_participants WHERE share_id=$1', [id]);
    const self = members.rows.find(p => p.user_id === actor.userId);
    if (!self || !['pending', 'accepted'].includes(self.state)) fail();
    return { share, members: members.rows, self };
  }
  // Only explicit fields cross accounts. No task-model spread, activity records,
  // source IDs, notes, tags, attachments, plans, actuals or timing payloads.
  async function project(q, id, actor) {
    const { share, members, self } = await live(q, id, actor);
    const base = { id: share.id, title: share.title, date: coerceDateString(share.occurrence_date),
      type: share.task_type, state: self.state, isOwner: share.owner_user_id === actor.userId,
      taskId: self.task_id, instructions:share.instructions || null, participants: [] };
    if (self.state === 'pending') return base;
    for (const m of members) {
      if (m.user_id !== share.owner_user_id && !await socialStore.areFriends(share.owner_user_id, m.user_id, q)) continue;
      if (m.user_id !== actor.userId && await socialStore.isBlocked(actor.userId, m.user_id, q)) continue;
      if (m.state !== 'accepted' && !(base.isOwner && m.state === 'pending')) continue;
      const { rows } = await q.query(`SELECT u.username, COALESCE(NULLIF(p.display_name,''),u.username) AS name,
        COALESCE(NULLIF(u.avatar_url,''),p.avatar) AS avatar, b.properties, b.deleted_at
        FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id
        LEFT JOIN blocks b ON b.id=$2 AND (b.user_id=u.id OR b.user_id IS NULL)
          AND EXISTS (SELECT 1 FROM workspace_members w WHERE w.workspace_id=b.workspace_id AND w.user_id=u.id AND w.role='owner')
        WHERE u.id=$1`, [m.user_id, m.task_id]);
      const row = rows[0];
      if (!row) continue;
      base.participants.push({ userId: m.user_id, name: row.name, avatar: row.avatar || null,
        self: m.user_id === actor.userId, state: m.state,
        completed: m.state === 'accepted' && !!row.properties && blockDB.isCompletedTaskProps(row.properties),
        removedTask: !!row.deleted_at });
    }
    return base;
  }
  async function list(actor, date = null) {
    await assertOwner(pool, actor);
    const { rows } = await pool.query(`SELECT s.id FROM shared_task_occurrences s
      JOIN shared_task_participants p ON p.share_id=s.id
      LEFT JOIN blocks b ON b.id=p.task_id
      WHERE p.user_id=$1 AND p.state IN ('pending','accepted')
        AND ($2::date IS NULL OR p.state='pending' OR s.occurrence_date=$2::date OR b.date=$2::date)
      ORDER BY s.created_at DESC`, [actor.userId,date]);
    const shares = [];
    for (const row of rows) {
      try { shares.push(await project(pool, row.id, actor)); }
      catch (e) { if (e.statusCode !== 404) throw e; }
    }
    return shares;
  }
  async function preview(taskId,actor,q=pool) {
    await assertOwner(q,actor);
    const {rows}=await q.query(`SELECT b.id,b.properties,r.record FROM blocks b LEFT JOIN task_activity_records r
      ON r.task_id=b.id AND r.owner_user_id=$3 AND r.workspace_id=$2 AND r.archived_at IS NULL
      WHERE b.id=$1 AND b.workspace_id=$2 AND (b.user_id=$3 OR b.user_id IS NULL) AND b.deleted_at IS NULL`,[taskId,actor.workspaceId,actor.userId]);
    if(!rows[0])fail();
    const value=rows[0].record?.taskType==='workout' ? instructionPlan(W.upgrade(rows[0].record).plan) : null;
    const plan=value && (value.exercises.length || value.runs.length) ? value : null;
    return {instructions:plan,hash:crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
  }
  async function invite(taskId, userId, actor, options={}) {
    if (!Number.isInteger(userId) || userId <= 0 || userId === actor.userId) fail('Choose a friend', 400);
    return tx(async q => {
      await assertOwner(q, actor);
      if (!await socialStore.areFriends(actor.userId, userId, q)) fail('Choose an accepted friend', 403);
      // Source lock serializes duplicate invitations, including first creation.
      const { rows } = await q.query(`SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2
        AND (user_id=$3 OR user_id IS NULL) AND deleted_at IS NULL FOR UPDATE`, [taskId, actor.workspaceId, actor.userId]);
      const task = rows[0], p = task?.properties || {};
      if (!task || !TaskModel.foldsIntoItinerary(task) || !task.date || !['task','focus','habit','workout'].includes(p.type || 'task')) fail();
      // A recipient cannot invite further people or reshare a private linked task.
      if ((await q.query('SELECT 1 FROM shared_task_participants WHERE task_id=$1 AND user_id<>$2', [taskId, actor.userId])).rows.length) fail();
      const linked = await q.query('SELECT s.owner_user_id FROM shared_task_participants p JOIN shared_task_occurrences s ON s.id=p.share_id WHERE p.task_id=$1', [taskId]);
      if (linked.rows.some(r => r.owner_user_id !== actor.userId)) fail('Only the shared task owner can invite', 403);
      const priorShare=(await q.query('SELECT * FROM shared_task_occurrences WHERE source_task_id=$1',[task.id])).rows[0];
      let instructions=null;
      if(!priorShare && options.includeInstructions) {
        if(p.type!=='workout')fail('Instruction snapshots require a workout task',400);
        const shown=await preview(taskId,actor,q);
        if(!shown.instructions)fail('Save workout instructions in Plan & Log before sharing them',409);
        if(shown.hash!==options.instructionsHash)fail('Workout instructions changed. Refresh and review them before inviting',409);
        instructions=shown.instructions;
      }
      const { rows: shares } = await q.query(`INSERT INTO shared_task_occurrences
        (id,source_task_id,owner_user_id,workspace_id,title,occurrence_date,task_type,duration,instructions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_task_id) DO NOTHING RETURNING *`,
      [crypto.randomUUID(), task.id, actor.userId, actor.workspaceId, String(p.title || 'Shared task').slice(0,160), coerceDateString(task.date), p.type || 'task', Math.max(1,Math.min(1440,Number(p.duration)||30)),instructions]);
      const share = shares[0] || (await q.query('SELECT * FROM shared_task_occurrences WHERE source_task_id=$1', [task.id])).rows[0];
      if (share.owner_user_id !== actor.userId) fail();
      await q.query(`INSERT INTO shared_task_participants(share_id,user_id,state,task_id)
        VALUES($1,$2,'accepted',$3) ON CONFLICT DO NOTHING`, [share.id,actor.userId,task.id]);
      const existingMembers = (await q.query('SELECT user_id,state FROM shared_task_participants WHERE share_id=$1', [share.id])).rows;
      const prior = existingMembers.find(m => m.user_id === userId);
      if (prior && !['pending','accepted'].includes(prior.state)) fail('This invitation ended. Share a new occurrence to invite again',409);
      if (!prior && existingMembers.length >= 8) fail('Up to eight participants per occurrence',400);
      await q.query(`INSERT INTO shared_task_participants(share_id,user_id,state)
        VALUES($1,$2,'pending') ON CONFLICT DO NOTHING`, [share.id,userId]);
      return { id: share.id };
    });
  }
  async function respond(id, action, actor, targetUserId = actor.userId) {
    if (!['accept','decline','remove'].includes(action)) fail('Invalid response',400);
    return tx(async q => {
      const { share, members, self } = await live(q,id,actor,true);
      const target = members.find(m => m.user_id === targetUserId);
      if (!target || targetUserId === share.owner_user_id) fail();
      if (action !== 'remove' && targetUserId !== actor.userId) fail();
      if (action === 'remove' && actor.userId !== targetUserId && actor.userId !== share.owner_user_id) fail();
      if (action === 'accept') {
        if (self.state === 'accepted') return { taskId: self.task_id }; // Exact retry, no second task/log.
        if (self.state !== 'pending') fail();
        const taskId = crypto.randomUUID(), date = coerceDateString(share.occurrence_date);
        const parent = await blockDB.ensureDayRoot(date,actor.userId,actor.workspaceId,q);
        await blockDB.createItineraryTask({ id: taskId, date, parent_id: parent, userId: actor.userId, workspaceId: actor.workspaceId,
          ensureRoot: false, score: true, client: q, properties: { kind:'manual_task',local_id:taskId,title:share.title,
            type:share.task_type,duration:share.duration,source:'manual',status:'open',publicVisibility:'private',
            all_day:true,all_day_start:date,all_day_end:new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10) } });
        if(share.instructions) {
          const record=W.empty();record.plan=instructionPlan(share.instructions,crypto.randomUUID);
          await q.query(`INSERT INTO task_activity_records(task_id,workspace_id,owner_user_id,task_type,record)
            VALUES($1,$2,$3,'workout',$4)`,[taskId,actor.workspaceId,actor.userId,W.validate(record)]);
        }
        // A detached instruction snapshot starts a new private session. No
        // results, personal targets, catalog IDs, provenance or timing is copied.
        await q.query("UPDATE shared_task_participants SET state='accepted',task_id=$3,updated_at=NOW() WHERE share_id=$1 AND user_id=$2", [id,actor.userId,taskId]);
        return { taskId };
      }
      if (action === 'decline' && self.state !== 'pending') fail('Already accepted; leave this shared task instead',409);
      await q.query('UPDATE shared_task_participants SET state=$3,updated_at=NOW() WHERE share_id=$1 AND user_id=$2', [id,targetUserId,action==='decline'?'declined':'removed']);
      // Membership revocation never erases their private task, history or log.
      return { removed:true };
    });
  }
  // Payload-free invalidations only, to currently authorized participant owners.
  async function notifyTask(taskId, actorWorkspace, broadcast) {
    const { rows } = await pool.query(`SELECT p.share_id,p.user_id FROM shared_task_participants p JOIN blocks b ON b.id=p.task_id
      WHERE p.task_id=$1 AND b.workspace_id=$2 AND p.state='accepted'`, [taskId,actorWorkspace]);
    for (const row of rows) await notify(row.share_id,broadcast);
  }
  async function notify(id,broadcast) {
    const { rows } = await pool.query(`SELECT p.user_id,w.workspace_id FROM shared_task_participants p
      JOIN workspace_members w ON w.user_id=p.user_id AND w.role='owner' WHERE p.share_id=$1 AND p.state IN ('accepted','pending')`, [id]);
    for (const row of rows) {
      try { await live(pool,id,{userId:row.user_id,workspaceId:row.workspace_id}); }
      catch (e) { if (e.statusCode===404 || e.statusCode===403) continue; throw e; }
      broadcast('shared-tasks-changed',{},row.workspace_id);
    }
  }
  // Existing block writes include batch, ancestor completion and old WAL routes.
  // A workspace containing participation tasks must be written by that task's
  // participant/owner, never a viewer or another workspace member. Preserve
  // authenticated owner service writes using the existing resolved service identity.
  async function guardWrites(actor) {
    if (!actor.workspaceId) fail('Workspace required',403);
    const { rows } = await pool.query(`SELECT DISTINCT p.user_id FROM shared_task_participants p
      JOIN blocks b ON b.id=p.task_id WHERE b.workspace_id=$1`,[actor.workspaceId]);
    if (!rows.length) return;
    if (rows.some(p => p.user_id !== actor.userId)) fail('Only your own participation task can be changed',403);
    await assertOwner(pool,actor);
  }
  return { list,invite,respond,notify,notifyTask,guardWrites,preview };
}
module.exports = { SCHEMA_SQL,createSharedTaskStore };
