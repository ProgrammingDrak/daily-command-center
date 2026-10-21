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
ALTER TABLE shared_task_occurrences ADD COLUMN IF NOT EXISTS series_definition_id TEXT REFERENCES blocks(id);
ALTER TABLE shared_task_occurrences ADD COLUMN IF NOT EXISTS series_parent_id TEXT REFERENCES shared_task_occurrences(id);
ALTER TABLE shared_task_occurrences ADD COLUMN IF NOT EXISTS occurrence_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_task_series ON shared_task_occurrences(series_definition_id) WHERE series_definition_id IS NOT NULL;
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
function createSharedTaskStore({ pool, blockDB, socialStore, crypto = require('node:crypto'), getTodayStr, APP_TIME_ZONE = 'America/New_York' }) {
  const repeats = require('./responsibility-store')({blockDB,getTodayStr,appTimeZone:APP_TIME_ZONE});
  async function seriesDefinition(q, task, actor) {
    const p=task?.properties || {};
    if(p.repeatMode!=='scheduled' || p.repeatOccurrenceRootId!==task.id || !p.repeatOccurrenceKey) return null;
    const row=(await q.query("SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND (user_id=$3 OR user_id IS NULL)",[p.repeatSeriesId,actor.workspaceId,actor.userId])).rows[0];
    return repeats.activeScheduledDefinition(row) && !row.properties.templateTree ? row : null;
  }
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
      WHERE s.id=$1 AND (b.deleted_at IS NULL OR s.series_definition_id IS NOT NULL) ${lock ? 'FOR UPDATE OF s' : ''}`, [id]);
    const share = rows[0];
    if (!share) fail();
    if (share.owner_user_id !== actor.userId && !await socialStore.areFriends(share.owner_user_id, actor.userId, q)) fail();
    if(share.series_parent_id) {
      const root=await live(q,share.series_parent_id,actor);
      if(root.self.state!=='accepted')fail();
    }
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
      scope:share.series_definition_id || share.series_parent_id ? 'series' : 'occurrence', seriesId:share.series_parent_id || (share.series_definition_id ? share.id : null),
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
        AND ($2::date IS NULL OR p.state='pending' OR s.series_definition_id IS NOT NULL OR s.occurrence_date=$2::date OR b.date=$2::date)
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
    return {seriesEligible:!!await seriesDefinition(q,rows[0],actor),instructions:plan,hash:crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
  }
  async function invite(taskId, userId, actor, options={}) {
    if(options.scope && !['occurrence','series'].includes(options.scope))fail('Choose an invitation scope',400);
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
      const definition=options.scope==='series' ? await seriesDefinition(q,task,actor) : null;
      if(options.scope==='series' && !definition)fail('Series sharing requires an active scheduled repeat with a single task',409);
      // Serialize all invitations for this definition, even on different dates.
      if(definition)await q.query('SELECT id FROM blocks WHERE id=$1 FOR UPDATE',[definition.id]);
      const series=definition && (await q.query('SELECT * FROM shared_task_occurrences WHERE series_definition_id=$1',[definition.id])).rows[0];
      if(series) {
        await live(q,series.id,actor,true);
        const members=(await q.query('SELECT * FROM shared_task_participants WHERE share_id=$1',[series.id])).rows;
        const member=members.find(m=>m.user_id===userId);
        if(member && !['pending','accepted'].includes(member.state))fail('This invitation ended; create a new routine to invite again',409);
        if(!member && members.length>=8)fail('Up to eight participants per routine',400);
        await q.query("INSERT INTO shared_task_participants(share_id,user_id,state) VALUES($1,$2,'pending') ON CONFLICT DO NOTHING",[series.id,userId]);
        return {id:series.id};
      }
      const priorShare=(await q.query('SELECT * FROM shared_task_occurrences WHERE source_task_id=$1',[task.id])).rows[0];
      if(priorShare && definition && !priorShare.series_definition_id)fail('This occurrence was already shared on its own. Choose an unshared occurrence to start a routine invitation',409);
      if(priorShare?.series_parent_id)fail('Use the recurring routine invitation to add participants',409);
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
      if(definition)await q.query('UPDATE shared_task_occurrences SET series_definition_id=$2,occurrence_key=$3 WHERE id=$1',[share.id,definition.id,p.repeatOccurrenceKey]);
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
  async function createPrivateTask(q,share,actor) {
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
    return taskId;
  }
  async function respond(id, action, actor, targetUserId = actor.userId) {
    if (!['accept','decline','remove'].includes(action)) fail('Invalid response',400);
    return tx(async q => {
      let current=await live(q,id,actor);
      if(current.share.series_parent_id)id=current.share.series_parent_id;
      const { share, members, self } = await live(q,id,actor,true);
      const target = members.find(m => m.user_id === targetUserId);
      if (!target || targetUserId === share.owner_user_id) fail();
      if (action !== 'remove' && targetUserId !== actor.userId) fail();
      if (action === 'remove' && actor.userId !== targetUserId && actor.userId !== share.owner_user_id) fail();
      if (action === 'accept') {
        if (self.state === 'accepted') return { taskId: self.task_id }; // Exact retry, no second task/log.
        if (self.state !== 'pending') fail();
        const taskId = await createPrivateTask(q,share,actor);
        // A detached instruction snapshot starts a new private session. No
        // results, personal targets, catalog IDs, provenance or timing is copied.
        await q.query("UPDATE shared_task_participants SET state='accepted',task_id=$3,updated_at=NOW() WHERE share_id=$1 AND user_id=$2", [id,actor.userId,taskId]);
        return { taskId };
      }
      if (action === 'decline' && self.state !== 'pending') fail('Already accepted; leave this shared task instead',409);
      await q.query('UPDATE shared_task_participants SET state=$3,updated_at=NOW() WHERE share_id=$1 AND user_id=$2', [id,targetUserId,action==='decline'?'declined':'removed']);
      if(share.series_definition_id)await q.query("UPDATE shared_task_participants SET state='removed',updated_at=NOW() WHERE user_id=$2 AND share_id IN (SELECT id FROM shared_task_occurrences WHERE series_parent_id=$1)",[id,targetUserId]);
      // Membership revocation never erases their private task, history or log.
      return { removed:true };
    });
  }
  // A series acceptance authorizes only these dated private tasks. GET stays
  // read-only; sync is explicit, bounded, and rechecks grants under both locks.
  async function sync(actor,date) {
    await assertOwner(pool,actor);
    if(!require('./public/js/activity-model').validDate(date))fail('Valid occurrence date required',400);
    const today=getTodayStr(), limit=new Date(Date.parse(today+'T12:00:00Z')+14*86400000).toISOString().slice(0,10);
    if(date<today)return {created:0};
    if(date>limit)fail('Shared repeats can be prepared up to fourteen days ahead',400);
    const roots=(await pool.query(`SELECT s.id FROM shared_task_occurrences s JOIN shared_task_participants p ON p.share_id=s.id
      JOIN blocks b ON b.id=p.task_id WHERE s.series_definition_id IS NOT NULL AND p.user_id=$1 AND p.state='accepted' AND b.workspace_id=$2`,[actor.userId,actor.workspaceId])).rows;
    let created=0;const changes=[];
    for(const root of roots) {
      let grant;
      try {grant=(await live(pool,root.id,actor)).share;}catch(e){if(e.statusCode===404)continue;throw e;}
      const generated=await repeats.materializeDefinitionForDate(grant.series_definition_id,{date,userId:grant.owner_user_id,workspaceId:grant.workspace_id,targetTimeZone:APP_TIME_ZONE});
      for(const row of generated)changes.push({workspaceId:grant.workspace_id,taskId:row.id});
      await tx(async q=>{
        await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[grant.workspace_id+':'+grant.series_definition_id]);
        let state;
        try {state=await live(q,root.id,actor,true);}catch(e){if(e.statusCode===404)return;throw e;}
        const definition=(await q.query('SELECT * FROM blocks WHERE id=$1',[grant.series_definition_id])).rows[0];
        if(!repeats.activeScheduledDefinition(definition) || definition.workspace_id!==grant.workspace_id || (definition.user_id && definition.user_id!==grant.owner_user_id) || definition.properties.templateTree)return;
        const recurrence=require('./lib/scheduled-recurrence');
        const rule=recurrence.normalizeScheduleRule(definition.properties.scheduleRule,{defaultTimeZone:APP_TIME_ZONE,today});
        const validKeys=new Set(recurrence.occurrencesForDate(rule,date,{targetTimeZone:APP_TIME_ZONE,today}).map(o=>o.occurrenceKey));
        const sources=(await q.query(`SELECT * FROM blocks WHERE workspace_id=$1 AND date=$2 AND deleted_at IS NULL
          AND (user_id IS NULL OR user_id=$5) AND properties->>'repeatSeriesId'=$3 AND properties->>'repeatOccurrenceRootId'=id
          AND properties->>'repeatOccurrenceKey'>=$4`,[grant.workspace_id,date,grant.series_definition_id,grant.occurrence_key,grant.owner_user_id])).rows;
        for(const source of sources) {
          if(!validKeys.has(source.properties.repeatOccurrenceKey))continue;
          let occurrence=(await q.query('SELECT * FROM shared_task_occurrences WHERE source_task_id=$1',[source.id])).rows[0];
          // Never silently widen an independently accepted occurrence invitation.
          if(occurrence && occurrence.id!==root.id && occurrence.series_parent_id!==root.id)continue;
          if(!occurrence) {
            occurrence=(await q.query(`INSERT INTO shared_task_occurrences(id,source_task_id,owner_user_id,workspace_id,title,occurrence_date,task_type,duration,instructions,series_parent_id,occurrence_key)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(source_task_id) DO NOTHING RETURNING *`,
            [crypto.randomUUID(),source.id,grant.owner_user_id,grant.workspace_id,grant.title,date,grant.task_type,grant.duration,grant.instructions,root.id,source.properties.repeatOccurrenceKey])).rows[0];
            if(!occurrence)continue;
          }
          for(const member of state.members.filter(m=>m.state==='accepted')) {
            if(member.user_id!==grant.owner_user_id && !await socialStore.areFriends(grant.owner_user_id,member.user_id,q))continue;
            const owned=(await q.query(`SELECT b.workspace_id FROM blocks b JOIN workspace_members w ON w.workspace_id=b.workspace_id AND w.user_id=$2 AND w.role='owner' WHERE b.id=$1`,[member.task_id,member.user_id])).rows[0];
            if(!owned)continue;
            if((await q.query('SELECT 1 FROM shared_task_participants WHERE share_id=$1 AND user_id=$2',[occurrence.id,member.user_id])).rows.length)continue;
            const taskId=member.user_id===grant.owner_user_id ? source.id : await createPrivateTask(q,occurrence,{userId:member.user_id,workspaceId:owned.workspace_id});
            await q.query("INSERT INTO shared_task_participants(share_id,user_id,state,task_id) VALUES($1,$2,'accepted',$3)",[occurrence.id,member.user_id,taskId]);
            created++;changes.push({workspaceId:owned.workspace_id,taskId});
          }
        }
      });
    }
    return {created,changes};
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
  return { list,invite,respond,notify,notifyTask,guardWrites,preview,sync };
}
module.exports = { SCHEMA_SQL,createSharedTaskStore };
