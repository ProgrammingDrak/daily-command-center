const M = require("./lib/conversation-model");
const Q = require("./lib/working-queue");
const { checkInState } = require("./public/js/work-checkin-policy");
const meetingIdentity = require("./meeting-identity");
const createTiming = require("./lib/task-timing");
const { splitSessionByLocalDay, entryWindow, isBlockDone } = createTiming;
const FOREGROUND_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_foreground_per_user ON blocks(user_id) WHERE deleted_at IS NULL AND user_id IS NOT NULL AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)`;
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_state (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 0, changed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS conversation_events (
 user_id INTEGER NOT NULL REFERENCES users(id), source_event_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 request_hash TEXT NOT NULL, command JSONB NOT NULL, before_state JSONB NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,source_event_id)
);
CREATE INDEX IF NOT EXISTS conversation_events_history ON conversation_events(user_id,workspace_id,created_at DESC);
CREATE TABLE IF NOT EXISTS conversation_background (
 user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), task_id TEXT NOT NULL REFERENCES blocks(id),
 started_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(user_id,task_id)
);
ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_background ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON conversation_state,conversation_events,conversation_background FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON conversation_state,conversation_events,conversation_background FROM %I',r);
 END LOOP;
END $privacy$;
`;
function timingFor(ctx, q, owner) {
  const db = ctx.blockDB;
  return createTiming({
    pool: q,
    timeZone: ctx.APP_TIME_ZONE || "America/New_York",
    coordinated: true,
    blockDB: {
      ...db,
      updateBlock: (id, p) => db.updateBlock(id, { ...p, [M.TIMING_WRITE]: true }, q),
      createBlock: (p) => db.createBlock(p, q),
      getBlock: (id) => db.getBlock(id, q),
      getBlockIncludingDeleted: (id) => db.getBlockIncludingDeleted(id, q),
      getTaskTimeEntries: async (id, ws, opts) =>
        (await db.getTaskTimeEntries(id, ws, opts, q)).filter((r) => !owner || r.user_id === owner.userId),
      ensureDayRoot: (date, user, ws) => db.ensureDayRoot(date, user, ws, q)
    }
  });
}
function createConversationStore(ctx) {
  const { pool, blockDB } = ctx,
    timeZone = ctx.APP_TIME_ZONE || "America/New_York";
  async function authorize(q, owner) {
    if (!Number.isInteger(owner?.userId) || !owner.workspaceId) throw M.fail("Sign in required", 401);
    const r = await q.query("SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'", [
      owner.userId,
      owner.workspaceId
    ]);
    if (!r.rows.length) throw M.fail("Workspace owner access required", 403);
  }
  async function task(q, id, owner) {
    const r = await q.query(
      `SELECT * FROM blocks WHERE (id=$1 OR properties->>'local_id'=$1) AND user_id=$2 AND workspace_id=$3 AND deleted_at IS NULL`,
      [id, owner.userId, owner.workspaceId]
    );
    const matches = r.rows.map(blockDB.parseBlock).filter(blockDB.isTaskRow);
    if (matches.length !== 1)
      throw M.fail(
        matches.length ? "Ambiguous task; select a canonical ID" : "Task not found",
        matches.length ? 409 : 404
      );
    return matches[0];
  }
  async function state(owner, q = null) {
    if (!q) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await authorize(client, owner);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + owner.userId]);
        const value = await state(owner, client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await authorize(q, owner);
    const s = await q.query("SELECT * FROM conversation_state WHERE user_id=$1", [owner.userId]);
    const active = await q.query(
      `SELECT id,workspace_id,properties->>'title' AS title,properties->>'startedAt' AS started_at FROM blocks WHERE user_id=$1 AND deleted_at IS NULL AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)`,
      [owner.userId]
    );
    const queue = await Q.snapshot(q, owner, blockDB);
    return {
      revision: s.rows[0]?.revision || 0,
      foreground: active.rows.filter((r) => r.workspace_id === owner.workspaceId),
      otherWorkspaceForeground: active.rows.some((r) => r.workspace_id !== owner.workspaceId),
      background: queue.items
        .filter((r) => ["background", "blocked"].includes(r.status))
        .map((r) => ({ task_id: r.task.id, started_at: r.backgroundSince })),
      queue,
      timeZone
    };
  }
  async function search(body, owner) {
    await authorize(pool, owner);
    const query = typeof body?.query === "string" ? body.query.trim().slice(0, 200) : "";
    const offset = Number(body?.offset || 0);
    if (!Number.isInteger(offset) || offset < 0) throw M.fail("Invalid search offset");
    // Default search preserves history; glasses opt into open task rows before pagination.
    const r = await pool.query(
      `SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
      AND (dcc_is_task_row(type,properties) OR properties->>'kind'='responsibility_item') AND COALESCE(properties->>'title','') ILIKE $3
      AND (NOT $5::boolean OR (
        COALESCE(properties->>'kind','') <> 'responsibility_item'
        AND COALESCE(properties->>'status','open') NOT IN ('done','deleted','archived')
        AND COALESCE(properties->'done','false'::jsonb) <> 'true'::jsonb
        AND COALESCE(properties->'completed','false'::jsonb) <> 'true'::jsonb
        AND COALESCE(properties->>'completedAt','') = '' AND COALESCE(properties->>'doneAt','') = ''
      ))
      ORDER BY updated_at DESC,id LIMIT 51 OFFSET $4`,
      [owner.userId, owner.workspaceId, "%" + query.replace(/[\\%_]/g, "\\$&") + "%", offset, body?.openOnly === 'true' || body?.openOnly === true]
    );
    return {
      tasks: r.rows
        .slice(0, 50)
        .map(blockDB.parseBlock)
        .map((b) => ({
          id: b.id,
          title: b.properties.title,
          date: b.date,
          status: b.properties.status || "open",
          type: b.properties.kind === "responsibility_item" ? "recurring-definition" : b.properties.type || b.type,
          definitionId: b.properties.responsibilityId || null,
          startedAt: b.properties.startedAt || null,
          plannedMinutes: b.properties.estimatedMinutes ?? b.properties.duration ?? null,
          actualMinutes: b.properties.actualMinutes ?? null,
          completionRevision: b.properties._completionRevision || null
        })),
      nextOffset: r.rows.length > 50 ? offset + 50 : null
    };
  }
  async function get(id, owner, q = pool) {
    await authorize(q, owner);
    const b = await task(q, id, owner);
    return {
      task: b,
      delegated:(await q.query('SELECT report FROM delegated_work WHERE user_id=$1 AND workspace_id=$2 AND task_id=$3',[owner.userId,owner.workspaceId,b.id])).rows.map(row=>row.report),
      ...(b.properties.guidedDefinitionId
        ? { guided: await require("./guided-store").createGuidedStore(ctx).get(b.id, owner, q) }
        : {}),
      sessions: (await blockDB.getTaskTimeEntries(b.id, owner.workspaceId, {}, q))
        .filter((r) => r.user_id === owner.userId)
        .map((r) => ({ ...r, correctionWindow: entryWindow(r, timeZone) })),
      ...(await state(owner, q))
    };
  }
  async function taskTree(id, owner) {
    await authorize(pool, owner);
    const root = await task(pool, id, owner);
    const rows = await blockDB.getSubtree([root.id], owner.workspaceId);
    return { rows: rows.filter(row => row.user_id === owner.userId && blockDB.isTaskRow(row)) };
  }
  async function readTaskNotes(q, row, owner) {
    let note=row.properties._taskNotes,noteBlockId=null;
    if(note==null){
      const aliases=await q.query(`SELECT id FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
        AND date IS NOT DISTINCT FROM $3::date AND properties->>'local_id'=$4 AND dcc_is_task_row(type,properties)`,[owner.userId,owner.workspaceId,row.date,row.properties.local_id||row.id]);
      const local=aliases.rows.length===1?row.properties.local_id||row.id:null;
      const legacy=await q.query(`SELECT id,properties FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
        AND (type='note' OR (properties ? 'html' AND properties ? 'text'))
        AND (properties->>'_sourceTaskId'=$3 OR parent_id=$3 OR
          (date IS NOT DISTINCT FROM $4::date AND (properties->>'_sourceTaskId'=$5 OR parent_id=$5)))
        ORDER BY updated_at DESC,id LIMIT 1 FOR UPDATE`,[owner.userId,owner.workspaceId,row.id,row.date,local]);
      const p=legacy.rows[0]?.properties;noteBlockId=legacy.rows[0]?.id||null;
      note=p?{html:p.html||'',text:p.text||'',blocks:Array.isArray(p.blocks)?p.blocks:[]}:
        {html:row.properties.notes||row.properties.detail||row.properties.description||'',text:'',blocks:[]};
    }
    return {taskId:row.id,title:row.properties.title||'Task',note,noteBlockId,revision:require('./lib/task-notes').revision(note)};
  }
  async function taskNotes(id, owner, body) {
    const q=await pool.connect();
    try {
      await q.query('BEGIN');await authorize(q,owner);
      let row=await task(q,id,owner);
      await q.query('SELECT id FROM blocks WHERE id=$1 FOR UPDATE',[row.id]);
      row=await task(q,row.id,owner);
      const current=await readTaskNotes(q,row,owner);
      if(body!==undefined){
        const N=require('./lib/task-notes'),note=N.validate(body?.note);
        if(typeof body.expectedRevision!=='string')throw M.fail('The saved notes revision is required');
        // Exact replay after a lost acknowledgement succeeds without another write.
        if(N.revision(note)!==current.revision){
          if(body.expectedRevision!==current.revision)throw M.fail('Notes changed elsewhere. Your draft is retained; review the saved notes before replacing them.',409);
          if(current.noteBlockId){
            const existing=await blockDB.getBlock(current.noteBlockId,q);
            await blockDB.updateBlock(existing.id,{properties:{...existing.properties,...note}},q);
          }else row=await blockDB.updateBlock(row.id,{properties:{...row.properties,_taskNotes:note}},q);
        }
      }
      const result=body===undefined?current:await readTaskNotes(q,row,owner);await q.query('COMMIT');return result;
    }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  }
  async function completionPreview(id, owner) {
    const q = await pool.connect();
    try {
      await q.query('BEGIN');
      await authorize(q, owner);
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['dcc-foreground:' + owner.userId]);
      const b = await task(q, id, owner);
      const sessions = (await blockDB.getTaskTimeEntries(b.id, owner.workspaceId, {}, q)).filter(row => row.user_id === owner.userId);
      const revision = (await q.query('SELECT revision FROM conversation_state WHERE user_id=$1', [owner.userId])).rows[0]?.revision || 0;
      const serverNow = Date.now(), safety = checkInState(b.properties, serverNow);
      const value = { taskId: b.id, revision, serverNow,
        history: require('./public/js/work-completion').history(b.properties, sessions),
        startedMs: safety.active ? Date.parse(b.properties.startedAt) : null,
        creditUntilMs: safety.active ? safety.autoPauseAtMs : null };
      await q.query('COMMIT');
      return value;
    } catch (error) { await q.query('ROLLBACK'); throw error; }
    finally { q.release(); }
  }
  async function calendarEvents(body, owner) {
    await authorize(pool, owner);
    const date = M.text(body?.date, "calendar date", 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw M.fail("Invalid calendar date");
    const rows = (
      await pool.query("SELECT state_json FROM dcc_state WHERE user_id=$1 AND workspace_id=$2 AND date=$3", [
        owner.userId,
        owner.workspaceId,
        date
      ])
    ).rows;
    const blocks = (
      await pool.query(
        "SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND date=$3 AND deleted_at IS NULL AND properties->>'type' IN ('meeting','oneone')",
        [owner.userId, owner.workspaceId, date]
      )
    ).rows;
    const events = new Map();
    for (const row of rows)
      for (const e of [...(row.state_json.meetings || []), ...(row.state_json.schedule?.timeline || [])]) {
        const id = meetingIdentity(e);
        if (id && (e.type === "meeting" || e.source === "calendar" || (row.state_json.meetings || []).includes(e)))
          events.set(String(id), {
            calendarEventId: String(id),
            title: e.title || e.summary || e.label,
            start: e.start,
            end: e.end,
            date
          });
      }
    for (const b of blocks) {
      const p = b.properties,
        id = p.source_id || p.gcal_event_id || p.event_id;
      if (id)
        events.set(String(id), {
          calendarEventId: String(id),
          taskId: b.id,
          title: p.title,
          start: p.start,
          end: p.end,
          date
        });
    }
    return {
      events: [...events.values()],
      timeZone,
      source: "Existing DCC calendar snapshot; no calendar sync is performed by this tool"
    };
  }
  async function calendar(q, eventId, owner) {
    const matches = await q.query(
      `SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
     AND (properties->>'source_id'=$3 OR properties->>'gcal_event_id'=$3 OR properties->>'event_id'=$3)
     AND properties->>'type' IN ('meeting','oneone')`,
      [owner.userId, owner.workspaceId, eventId]
    );
    if (matches.rows.length > 1) throw M.fail("Ambiguous calendar occurrence", 409);
    if (matches.rows[0]) return { eventId, title: matches.rows[0].properties.title, blockId: matches.rows[0].id };
    const states = await q.query(
      "SELECT state_json FROM dcc_state WHERE user_id=$1 AND workspace_id=$2 ORDER BY date DESC",
      [owner.userId, owner.workspaceId]
    );
    const found = [];
    for (const row of states.rows)
      for (const m of [...(row.state_json.meetings || []), ...(row.state_json.schedule?.timeline || [])]) {
        if (
          meetingIdentity(m) === eventId &&
          (m.type === "meeting" || m.source === "calendar" || (row.state_json.meetings || []).includes(m))
        )
          found.push(m);
      }
    if (!found.length) throw M.fail("Calendar occurrence not found in this account; refresh calendar data", 404);
    return { eventId, title: found[0].title || found[0].summary || "Meeting", blockId: null };
  }
  async function correct(q, b, owner, eventKey) {
    const r = await q.query(
      "SELECT * FROM blocks WHERE id=$1 AND type='time_entry' AND user_id=$2 AND workspace_id=$3 AND deleted_at IS NULL FOR UPDATE",
      [b.entryId, owner.userId, owner.workspaceId]
    );
    const source = r.rows[0] ? blockDB.parseBlock(r.rows[0]) : null;
    if (!source) throw M.fail("Time entry not found", 404);
    const originalWindow = entryWindow(source, timeZone);
    const window = b.correctedWindow
      ? {
          startMs: M.instant(b.correctedWindow.start),
          endMs: M.instant(b.correctedWindow.end),
          durSec: Math.round((M.instant(b.correctedWindow.end) - M.instant(b.correctedWindow.start)) / 1000)
        }
      : originalWindow;
    const otherEntries = (
      await q.query(
        "SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND type='time_entry' AND deleted_at IS NULL AND id<>$3",
        [owner.userId, owner.workspaceId, source.id]
      )
    ).rows.map(blockDB.parseBlock);
    const otherWindows = otherEntries.filter(entry => entry.properties.allocationKind !== "unknown")
      .map(entry => ({id:entry.id,...entryWindow(entry,timeZone)}));
    let cursor = window.startMs;
    if (!cursor || window.durSec > 36 * 3600) throw M.fail("Source interval is not correctable");
    const touched = new Map(),
      priorTotals = new Map(),
      created = [];
    async function remember(item) {
      if (touched.has(item.id)) return;
      touched.set(item.id, item);
      const sessions = (await blockDB.getTaskTimeEntries(item.id, owner.workspaceId, {}, q)).filter(
        (r) => r.user_id === owner.userId
      );
      priorTotals.set(item.id, timingFor(ctx, q, owner).sessionTotalMinutes(sessions));
    }
    if (source.properties.blockId) await remember(await task(q, source.properties.blockId, owner));
    for (const part of b.parts) {
      const start = M.instant(part.start),
        end = M.instant(part.end);
      if (start !== cursor || end > window.endMs)
        throw M.fail("Parts must exactly partition the original interval without gaps or overlaps");
      cursor = end;
      let target = null,
        meeting = null;
      if (part.kind === "focused") {
        target = await task(q, part.taskId, owner);
        await remember(target);
      }
      if (part.kind === "meeting") {
        meeting = await calendar(q, part.calendarEventId, owner);
        if (meeting.blockId) {
          target = await task(q, meeting.blockId, owner);
          await remember(target);
        }
      }
      if (part.kind !== "unknown") {
        for (const prior of otherWindows) {
          if (prior.startMs !== null && start < prior.endMs && end > prior.startMs)
            throw M.fail("This interval overlaps existing recorded activity; review entry " + prior.id, 409);
        }
        const active = (
          await q.query(
            "SELECT id,properties->>'startedAt' AS started FROM blocks WHERE user_id=$1 AND deleted_at IS NULL AND dcc_is_task_row(type,properties) AND properties->>'startedAt' IS NOT NULL",
            [owner.userId]
          )
        ).rows;
        if (active.some((row) => end > Date.parse(row.started)))
          throw M.fail("Correction overlaps an active foreground session; pause it first", 409);
      }
      for (const seg of splitSessionByLocalDay(start, end, timeZone)) {
        const id = "conversation-time-" + M.digest({ eventKey, index: created.length }).slice(0, 32);
        const parent = await blockDB.ensureDayRoot(seg.date, owner.userId, owner.workspaceId, q);
        const hhmm = (ms) =>
          new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
            new Date(ms)
          );
        const row = await blockDB.createBlock(
          {
            id,
            type: "time_entry",
            parent_id: parent,
            date: seg.date,
            user_id: owner.userId,
            workspace_id: owner.workspaceId,
            properties: {
              ...(target ? { blockId: target.id } : {}),
              taskTitle: target?.properties.title || meeting?.title || "Unknown activity",
              allocationKind: part.kind,
              calendarEventId: meeting?.eventId || null,
              source: "conversation-correction",
              startedAt: new Date(seg.startMs).toISOString(),
              endedAt: new Date(seg.endMs).toISOString(),
              start: hhmm(seg.startMs),
              end: hhmm(seg.endMs),
              durSec: seg.durSec,
              correctedFromEntryId: source.id,
              sourceEventId: b.sourceEventId,
              reason: b.reason,
              estimated: false
            }
          },
          q
        );
        created.push(row);
      }
    }
    if (created.reduce((sum, row) => sum + row.properties.durSec, 0) !== window.durSec)
      throw M.fail("Correction parts must conserve the source seconds exactly");
    if (cursor !== window.endMs) throw M.fail("Parts must cover the complete original interval");
    await blockDB.deleteBlock(source.id, q);
    for (const item of touched.values())
      await timingFor(ctx, q, owner).recomputeActualMinutes({
        block: item,
        workspaceId: owner.workspaceId,
        priorSessionsTotal: priorTotals.get(item.id),
        client: q
      });
    return {
      sourceEntry: source,
      entries: created,
      originalWindow,
      correctedWindow: window,
      touchedTaskIds: [...touched.keys()]
    };
  }
  async function execute(input, owner, { legacy = false, transactionClient = null } = {}) {
    const b = M.command(input, (ctx.now || Date.now)()),
      hash = M.digest(b),
      q = transactionClient || (await pool.connect());
    let released = false;
    const releaseOwned = () => { if (!transactionClient && !released) { q.release(); released = true; } };
    try {
      if (!transactionClient) await q.query("BEGIN");
      await authorize(q, owner);
      // One account-wide lock, before all task row locks, across every client/workspace.
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + owner.userId]);
      const prior = await q.query("SELECT * FROM conversation_events WHERE user_id=$1 AND source_event_id=$2", [
        owner.userId,
        b.sourceEventId
      ]);
      if (prior.rows[0]) {
        if (prior.rows[0].workspace_id !== owner.workspaceId || prior.rows[0].request_hash !== hash)
          throw M.fail("Source event was already used for a different command", 409);
        const currentState = await state(owner, q);
        const ids = (prior.rows[0].result.affectedTasks || []).map((row) => row.id);
        const affectedTasks = (
          await q.query("SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND id=ANY($3::text[])", [
            owner.userId,
            owner.workspaceId,
            ids
          ])
        ).rows.map(blockDB.parseBlock);
        if (!transactionClient) {
          await q.query("COMMIT");
          releaseOwned();
          // A crash after commit can be recovered by the same idempotent retry.
          for (const transition of prior.rows[0].result.responsibilityTransitions || []) await blockDB.propagateResponsibilityDone(transition);
        }
        return { ...prior.rows[0].result, duplicate: true, claimed: false, affectedTasks, currentState };
      }
      await q.query("INSERT INTO conversation_state(user_id) VALUES($1) ON CONFLICT DO NOTHING", [owner.userId]);
      const before = await state(owner, q);
      if (!legacy && before.revision !== b.expectedRevision)
        throw M.fail("Activity changed; read current state before retrying", 409);
      const s = (await q.query("SELECT * FROM conversation_state WHERE user_id=$1 FOR UPDATE", [owner.userId])).rows[0];
      const clockAction = (!b.action.startsWith("queue-") && !b.action.startsWith("delegated-")) || b.action === "queue-block";
      if (clockAction && b.action !== "correct" && s.changed_at && M.instant(b.at) < new Date(s.changed_at).getTime())
        throw M.fail("Stale activity event; use a correction", 409);
      // New child registration follows the hierarchy-before-row lock order used by creation.
      if (b.action === "delegated-register" && b.delegation.parentTaskId)
        await q.query("SELECT pg_advisory_xact_lock(hashtext('dcc-task-hierarchy'), hashtext($1))", [String(owner.workspaceId)]);
      // Lock owned rows in a stable order before read/modify/write, also excluding parallel completion.
      await q.query(
        `SELECT id FROM blocks WHERE user_id=$1 AND deleted_at IS NULL AND dcc_is_task_row(type,properties)
         AND ($2 OR id=$3 OR properties->>'local_id'=$3 OR properties->>'startedAt' IS NOT NULL) ORDER BY id FOR UPDATE`,
        [owner.userId, ["correct", "done"].includes(b.action), b.taskId || null]
      );
      const queue = await Q.load(q, owner);
      await Q.reconcile(q, owner, queue, blockDB, b.at);
      let detail = {};
      const changedIds = new Set();
      const atMs = M.instant(b.at),
        timing = timingFor(ctx, q, owner),
        actor = "conversation:" + owner.userId;
      async function closeForeground(row, status = "paused") {
        if (atMs <= Date.parse(row.properties.startedAt)) throw M.fail("Transition must follow the active start", 409);
        const safety = checkInState(row.properties, atMs);
        const cutoff = Math.min(atMs, safety.autoPauseAtMs);
        let paused;
        if (row.properties.guidedDefinitionId && !legacy && b.action !== "done") {
          const guided = require("./guided-store").createGuidedStore(ctx),
            view = await guided.get(row.id, owner, q);
          if (view.session) {
            const pause = await guided.act(
              row.id,
              {
                action: "pause",
                operationId: "queue:" + M.digest(b.sourceEventId + row.id).slice(0, 40),
                expectedRevision: view.revision
              },
              owner,
              q,
              cutoff,
              true
            );
            paused = { changed: true, entries: pause.entries || [] };
          }
        }
        if (!paused)
          paused = await timing.pauseWork({
            block: row,
            atMs: cutoff,
            transitionAtMs: atMs,
            actor,
            actionId: b.sourceEventId
          });
        Q.setStatus(queue, await task(q, row.id, owner), status, b);
        if (status === "background") queue.order = queue.order.filter((id) => id !== row.id).concat(row.id);
        changedIds.add(row.id);
        detail.entries = [...(detail.entries || []), ...(paused.entries || [])];
        if (!paused.changed) throw M.fail(paused.reason || "Foreground session could not be closed", 409);
        if (cutoff < atMs) {
          // Silence is not evidence of continued focus. Keep elapsed uncertainty
          // in the audit event, never add it to a task's actualMinutes.
          detail.uncertainIntervals = detail.uncertainIntervals || [];
          detail.uncertainIntervals.push({
            taskId: row.id,
            start: new Date(cutoff).toISOString(),
            end: b.at,
            kind: "unknown",
            reason: "No recent work check-in"
          });
        }
      }
      if (b.action === "correct") detail = await correct(q, b, owner, owner.userId + ":" + b.sourceEventId);
      else if (b.action.startsWith("delegated-")) detail = await require('./lib/delegated-work').apply(q,owner,queue,b,ctx,task);
      else if (b.action.startsWith("queue-") && b.action !== "queue-block") {
        detail = await Q.metadata(q, owner, queue, b, b.taskId ? await task(q, b.taskId, owner) : null, blockDB);
      } else {
        const target = await task(q, b.taskId, owner);
        before.task = structuredClone(target);
        if (["start", "background-start", "queue-block"].includes(b.action) && isBlockDone(target))
          throw M.fail("Completed tasks must be explicitly reopened", 409);
        if (["start", "pause", "done", "background-start", "queue-block"].includes(b.action)) {
          const active = (
            await q.query(
              `SELECT * FROM blocks WHERE user_id=$1 AND deleted_at IS NULL AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)`,
              [owner.userId]
            )
          ).rows;
          const closing =
            b.action === "start" ? active.filter((r) => r.id !== target.id) : active.filter((r) => r.id === target.id);
          if (closing.some((r) => r.workspace_id !== owner.workspaceId))
            throw M.fail("Pause work in the other workspace before switching", 409);
          for (const row of closing)
            await closeForeground(
              row,
              b.action === "start" || b.action === "background-start"
                ? "background"
                : b.action === "queue-block"
                  ? "blocked"
                  : "paused"
            );
        }
        if (b.action === "start") {
          if (target.properties.guidedDefinitionId && !legacy) {
            const guided = require("./guided-store").createGuidedStore(ctx),
              view = await guided.get(target.id, owner, q);
            if (!b.guided) throw M.fail("Preview current guided instructions before bringing this task forward", 409);
            await guided.act(
              target.id,
              {
                ...b.guided,
                action: view.session ? "resume" : "start",
                operationId: "queue:" + M.digest(b.sourceEventId).slice(0, 40)
              },
              owner,
              q,
              atMs,
              true
            );
          } else {
            const result = await timing.startWork({
              block: await task(q, target.id, owner),
              atMs,
              actor,
              actionId: b.sourceEventId
            });
            if (["stale", "not-trackable", "completed"].includes(result.reason)) throw M.fail(result.reason, 409);
          }
          Q.setStatus(queue, await task(q, target.id, owner), "foreground", b);
        }

        if (b.action === "continue") {
          const safety = checkInState(target.properties, atMs);
          if (safety.shouldAutoPause) {
            await closeForeground(target);
            const resumed = await timing.startWork({
              block: await task(q, target.id, owner),
              atMs,
              actor,
              actionId: b.sourceEventId + ":resume"
            });
            if (!resumed.changed) throw M.fail(resumed.reason || "Timer could not resume", 409);
          } else {
            const continued = await timing.continueWork({ block: target, atMs, actor, actionId: b.sourceEventId });
            if (!continued.changed) throw M.fail(continued.reason || "Timer could not be continued", 409);
          }
        }
        if (b.action === "done" && target.properties.guidedDefinitionId && !legacy) {
          if (!b.guided) throw M.fail("Confirm the guided outcome before completion", 409);
          const completion = await require("./guided-store")
            .createGuidedStore(ctx)
            .act(
              target.id,
              { ...b.guided, action: "complete", operationId: "queue:" + M.digest(b.sourceEventId).slice(0, 40) },
              owner,
              q,
              atMs,
              true
            );
          detail.responsibilityTransitions = completion.responsibilityTransitions || [];
          for (const id of completion.broadcastIds || []) changedIds.add(id);
          Q.setStatus(queue, await task(q, target.id, owner), "completed", b);
        } else if (b.action === "done") {
          const completion = await blockDB.setTaskCompletion({
            taskRef: target.id,
            completed: true,
            completedAt: b.at,
            expectedRevision: target.properties._completionRevision || null,
            mutationId: "conversation:" + M.digest(b.sourceEventId).slice(0, 40),
            userId: owner.userId,
            workspaceId: owner.workspaceId,
            transactionClient: q
          });
          if (completion.affectedTasks.some((r) => r.user_id !== owner.userId))
            throw M.fail("Completion includes another account", 403);
          detail.responsibilityTransitions = completion.responsibilityTransitions || [];
          for (const row of completion.affectedTasks) {
            changedIds.add(row.id);
            if (row.properties.startedAt) await closeForeground(row);
          }
          for (const row of completion.affectedTasks) {
            const current = await task(q, row.id, owner);
            Q.setStatus(queue, current, "completed", b);
            if (current.properties.actualMinutes == null)
              await blockDB.updateBlock(
                current.id,
                { properties: { ...current.properties, actualTimeUnknown: true }, [M.TIMING_WRITE]: true },
                q
              );
          }
          // No completeWork inference: a task without tracked effort retains unknown actuals.
        }
        if (b.action === 'background-start' && !target.properties.everStarted)
          await blockDB.updateBlock(target.id, { properties: { ...(await task(q, target.id, owner)).properties, everStarted: true }, [M.TIMING_WRITE]: true }, q);
        if (b.action === "background-start" || b.action === "queue-block")
          Q.setStatus(queue, await task(q, target.id, owner), b.action === "queue-block" ? "blocked" : "background", b);
        if (b.action === "background-stop" || b.action === "pause")
          Q.setStatus(queue, await task(q, target.id, owner), "paused", b);
        detail.task = await task(q, target.id, owner);
      }
      await Q.save(q, owner, queue);
      await q.query(
        "UPDATE conversation_state SET revision=revision+1,changed_at=CASE WHEN $3 THEN GREATEST(changed_at,$2::timestamptz) ELSE changed_at END WHERE user_id=$1",
        [owner.userId, b.at, clockAction && b.action !== "correct"]
      );
      if (detail.task) changedIds.add(detail.task.id);
      for (const id of detail.touchedTaskIds || []) changedIds.add(id);
      const affectedTasks = (
        await q.query(
          "SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND dcc_is_task_row(type,properties) AND id=ANY($3::text[])",
          [owner.userId, owner.workspaceId, [...changedIds]]
        )
      ).rows.map(blockDB.parseBlock);
      const result = {
        ok: true,
        sourceEventId: b.sourceEventId,
        ...detail,
        affectedTasks,
        state: await state(owner, q)
      };
      await q.query(
        "INSERT INTO conversation_events(user_id,workspace_id,source_event_id,request_hash,command,before_state,result) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [owner.userId, owner.workspaceId, b.sourceEventId, hash, b, before, result]
      );
      if (!transactionClient) {
        await q.query("COMMIT");
        releaseOwned();
        for (const transition of result.responsibilityTransitions || []) await blockDB.propagateResponsibilityDone(transition);
      }
      return { ...result, currentState: result.state };
    } catch (e) {
      if (!transactionClient && !released) await q.query("ROLLBACK");
      throw e;
    } finally {
      releaseOwned();
    }
  }
  async function history(owner) {
    await authorize(pool, owner);
    return (
      await pool.query(
        "SELECT source_event_id,command,result,created_at FROM conversation_events WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 100",
        [owner.userId, owner.workspaceId]
      )
    ).rows;
  }
  return { state, search, get, taskTree, taskNotes, completionPreview, calendarEvents, execute, history };
}
module.exports = { SCHEMA_SQL, FOREGROUND_INDEX_SQL, createConversationStore, timingFor };
