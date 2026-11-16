const M = require("./lib/conversation-model");
const { version } = require("./lib/task-reconciliation");
const { isBlockDone } = require("./lib/task-timing");
const { isLibraryTask, createProjectStore } = require("./project-store");
const Itinerary = require("./lib/itinerary-schedule");
const Zones = require("./public/js/schedule-zones");
const { foldsIntoItinerary } = require("./public/js/task-model");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_operations (
 user_id INTEGER NOT NULL REFERENCES users(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 id TEXT NOT NULL, request_hash TEXT NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,workspace_id,id)
);
CREATE TABLE IF NOT EXISTS chat_cleanup_jobs (
 id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 manifest JSONB NOT NULL,results JSONB NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'prepared',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE chat_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_cleanup_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat_operations,chat_cleanup_jobs FROM PUBLIC;
DO $chat_privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON chat_operations,chat_cleanup_jobs FROM %I',r);
 END LOOP;
END $chat_privacy$;`;
const has = (actor, scope) => actor.scopes?.includes(scope);
function need(actor, scope) {
  if (!has(actor, scope)) throw M.fail("Insufficient scope: " + scope, 403);
}
const definition = (row) => row.properties?.kind === "responsibility_item";
const repeat = (row) => definition(row) || !!(row.properties?.responsibilityId || row.properties?.repeatSeriesId);
const safeTask = (row) => ({
  id: row.id,
  date: row.date,
  parentId: row.parent_id,
  title: row.properties.title,
  detail: row.properties.detail || "",
  status: row.effectiveDone ? "done" : row.properties.status || "open",
  start: row.properties.start || null,
  duration: row.properties.duration || null,
  priority: row.properties.priority || null,
  tags: row.properties.tags || [],
  location: row.properties.taskLocation || row.properties.location || null,
  sourceReferences: row.properties.sourceReferences || [],
  projectId: row.properties.projectId || null,
  definitionId: row.properties.responsibilityId || row.properties.repeatSeriesId || null,
  version: version(row),
  deleted: !!row.deleted_at
});
function fields(input, allowed) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw M.fail("Unsupported fields");
  return input;
}
function createChatControlStore(ctx) {
  const { pool, blockDB: db } = ctx;
  const projects = createProjectStore(ctx);
  const reps = require("./responsibility-store")({
    blockDB: db,
    getTodayStr: ctx.getTodayStr || (() => new Date().toISOString().slice(0, 10)),
    appTimeZone: ctx.APP_TIME_ZONE,
    assertBlockOwnership: (row, ws) => {
      if (row.workspace_id !== ws) throw M.fail("Not found", 404);
    }
  });
  async function authorize(q, actor) {
    const r = await q.query("SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND role='owner'", [
      actor.userId,
      actor.workspaceId
    ]);
    if (!r.rows.length) throw M.fail("Workspace owner required", 403);
  }
  async function activeGrant(q, actor, lock = false) {
    if (!actor.grantId) return;
    const { rows } = await q.query(
      "SELECT scopes FROM conversation_grants WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND revoked_at IS NULL" +
        (lock ? " FOR SHARE" : ""),
      [actor.grantId, actor.userId, actor.workspaceId]
    );
    if (!rows[0] || !actor.scopes.every((scope) => rows[0].scopes.includes(scope)))
      throw M.fail("Connection access changed. Read the current permissions and retry.", 403);
  }
  async function tx(actor, work) {
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      await authorize(q, actor);
      await activeGrant(q, actor, true);
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + actor.userId]);
      const result = await work(q);
      await q.query("COMMIT");
      return result;
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  async function row(q, id, actor, deleted = false) {
    M.text(id, "taskId", 200);
    const r = await q.query(
      "SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND (user_id=$3 OR user_id IS NULL)" +
        (deleted ? "" : " AND deleted_at IS NULL") +
        (q === pool ? "" : " FOR UPDATE"),
      [id, actor.workspaceId, actor.userId]
    );
    const b = r.rows[0] && db.parseBlock(r.rows[0]);
    if (
      !b ||
      (!db.isTaskRow(b) && !definition(b) && !["project", "task_facet", "task_view"].includes(b.properties.kind))
    )
      throw M.fail("Record not found", 404);
    return b;
  }
  async function effective(q, rows, actor) {
    const r = await q.query(
      "SELECT date::text AS date,properties FROM blocks WHERE workspace_id=$1 AND type='day_root' AND deleted_at IS NULL AND date=ANY($2::date[])",
      [actor.workspaceId, [...new Set(rows.map((x) => x.date).filter(Boolean))]]
    );
    const roots = new Map(r.rows.map((x) => [x.date, x.properties]));
    return rows.map((b) => ({ ...b, effectiveDone: isBlockDone(b, roots.get(b.date)) }));
  }
  async function check(q, id, expected, actor) {
    const b = await row(q, id, actor, true);
    if (!expected || version(b) !== expected)
      throw M.fail("Record changed; read it again before applying this operation", 409);
    if (b.properties.startedAt) throw M.fail("Pause active work before editing or deleting it", 409);
    return b;
  }
  async function seriesFor(q, b, actor) {
    const seen = new Set();
    while (b && !seen.has(b.id)) {
      seen.add(b.id);
      if (definition(b)) return b.id;
      if (repeat(b)) return b.properties.responsibilityId || b.properties.repeatSeriesId;
      if (!b.parent_id && !b.properties.subtaskOf) return null;
      const r = await q.query(
        "SELECT * FROM blocks WHERE workspace_id=$1 AND (user_id=$2 OR user_id IS NULL) AND (id=$3 OR (properties->>'local_id'=$4 AND date IS NOT DISTINCT FROM $5::date))",
        [actor.workspaceId, actor.userId, b.parent_id || b.properties.subtaskOf, b.properties.subtaskOf || null, b.date]
      );
      if (r.rows.length !== 1) return null;
      b = db.parseBlock(r.rows[0]);
    }
    return null;
  }
  async function lockSeries(q, ids, actor) {
    for (const id of [...new Set(ids)].filter(Boolean).sort())
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${actor.workspaceId}:${id}`]);
  }
  async function once(args, actor, work) {
    M.text(args.sourceEventId, "sourceEventId", 200);
    const hash = M.digest(args);
    const result = await tx(actor, async (q) => {
      const saved = await q.query(
        "SELECT request_hash,result FROM chat_operations WHERE user_id=$1 AND workspace_id=$2 AND id=$3",
        [actor.userId, actor.workspaceId, args.sourceEventId]
      );
      if (saved.rows.length) {
        if (saved.rows[0].request_hash !== hash)
          throw M.fail("Operation identity reused with different arguments", 409);
        return saved.rows[0].result;
      }
      const result = { ...(await work(q)), saveStatus: "verified_saved", sourceEventId: args.sourceEventId };
      await q.query("INSERT INTO chat_operations(user_id,workspace_id,id,request_hash,result) VALUES($1,$2,$3,$4,$5)", [
        actor.userId,
        actor.workspaceId,
        args.sourceEventId,
        hash,
        JSON.stringify(result)
      ]);
      return result;
    });
    const blockIds = [result.task?.id, result.activity?.id, ...(result.activities || []).map((item) => item.id)].filter(
      Boolean
    );
    ctx.broadcast?.(
      "blocks-changed",
      { action: "chat-control", blockIds, sourceEventId: args.sourceEventId },
      actor.workspaceId
    );
    return result;
  }
  async function tasks(args, actor) {
    need(actor, "dcc.tasks.read");
    if (["list", "get", "history"].includes(args.action)) {
      await authorize(pool, actor);
      if (args.action === "get" || args.action === "history") {
        const b = await row(pool, args.id, actor, true);
        if (!isLibraryTask({ ...b, deleted_at: null }, db)) throw M.fail("Task not found", 404);
        if (args.action === "get") return safeTask((await effective(pool, [b], actor))[0]);
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw M.fail("Invalid offset");
        const { rows } = await pool.query(
          "SELECT id,op_type AS action,timestamp AS at FROM operations WHERE block_id=$1 ORDER BY id DESC LIMIT 51 OFFSET $2",
          [b.id, offset]
        );
        return { taskId: b.id, events: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
      }
      const offset = Number(args.offset || 0);
      if (!Number.isInteger(offset) || offset < 0) throw M.fail("Invalid offset");
      const r = await pool.query(
        "SELECT * FROM blocks WHERE workspace_id=$1 AND (user_id=$2 OR user_id IS NULL) AND deleted_at IS NULL AND dcc_is_task_row(type,properties) AND COALESCE(properties->>'title','') ILIKE $3 ORDER BY updated_at DESC,id",
        [actor.workspaceId, actor.userId, "%" + String(args.query || "").replace(/[\\%_]/g, "\\$&") + "%"]
      );
      let rows = await effective(
        pool,
        r.rows.map(db.parseBlock).filter((b) => isLibraryTask(b, db)),
        actor
      );
      if (args.status === "open") rows = rows.filter((b) => !b.effectiveDone);
      if (args.status === "done") rows = rows.filter((b) => b.effectiveDone);
      return {
        tasks: rows.slice(offset, offset + 50).map(safeTask),
        nextOffset: rows.length > offset + 50 ? offset + 50 : null
      };
    }
    need(actor, "dcc.tasks.write");
    return once(args, actor, async (q) => {
      const input = args.input || {};
      if (args.action === "create") {
        fields(input, [
          "title",
          "detail",
          "duration",
          "date",
          "priority",
          "projectId",
          "someday",
          "tags",
          "location",
          "sourceUrl",
          "parentId"
        ]);
        validateDate(input.date);
        if (input.projectId) {
          need(actor, "dcc.organization.write");
          const project = await row(q, input.projectId, actor);
          if (project.properties.kind !== "project") throw M.fail("Project not found", 404);
        }
        const b = await projects.createTask(
          {
            ...input,
            id: "chat-task-" + M.digest([actor.userId, actor.workspaceId, args.sourceEventId]).slice(0, 32),
            type: "task",
            kind: "backlog",
            source: "conversation"
          },
          actor,
          q
        );
        if (input.parentId) {
          const parent = await row(q, input.parentId, actor);
          if (await seriesFor(q, parent, actor)) need(actor, "dcc.repeats.write");
          await db.updateBlock(
            b.id,
            {
              parent_id: parent.id,
              date: parent.date,
              properties: { ...b.properties, rel: "subtask", subtaskOf: parent.properties.local_id || parent.id }
            },
            q
          );
        }
        return { task: safeTask(await row(q, b.id, actor)) };
      }
      const b = await check(q, args.id, args.expectedVersion, actor);
      if (!isLibraryTask({ ...b, deleted_at: null }, db)) throw M.fail("Task not found", 404);
      if (await seriesFor(q, b, actor)) need(actor, "dcc.repeats.write");
      if (args.action === "update") {
        if (Itinerary.calendarOwned(b)) throw M.fail("Change this event in its source calendar", 409);
        fields(input, [
          "title",
          "detail",
          "duration",
          "priority",
          "projectId",
          "facetValues",
          "tags",
          "location",
          "sourceUrl"
        ]);
        if (input.duration !== undefined && b.properties.scheduleInstant?.source === "mcp-zoned")
          throw M.fail("Use dcc_itinerary_write to change the scheduled duration", 409);
        if (input.projectId !== undefined || input.facetValues !== undefined) need(actor, "dcc.organization.write");
        await projects.organizeTask(b.id, input, actor, q);
      } else if (args.action === "schedule") {
        if (Itinerary.calendarOwned(b)) throw M.fail("Change this event in its source calendar", 409);
        if (b.properties.scheduleInstant?.source === "mcp-zoned")
          throw M.fail("Use dcc_itinerary_write to reschedule zoned itinerary entries", 409);
        fields(input, ["date", "start"]);
        validateDate(input.date);
        validateTime(input.start);
        if (input.date === undefined) throw M.fail("Provide a date or null to unschedule");
        const tree = await effective(q, await db.getSubtree([b.id], actor.workspaceId, q), actor);
        if (tree.some((child) => child.effectiveDone || child.properties.startedAt))
          throw M.fail(
            "Completed or active descendants must remain in their recorded timeline; schedule the open tasks individually",
            409
          );
        if (tree.some((child) => child.user_id != null && child.user_id !== actor.userId))
          throw M.fail("Task tree includes another account", 403);
        const minutes = (time) => {
          const [h, m] = time.split(":").map(Number);
          return h * 60 + m;
        };
        const newStart = Object.hasOwn(input, "start")
          ? input.start
          : input.date === null
            ? null
            : b.properties.start || null;
        const delta = newStart && b.properties.start ? minutes(newStart) - minutes(b.properties.start) : 0;
        const moves = tree.map((child) => {
          const p = { ...child.properties };
          if (input.date === null) {
            p.start = null;
            p.end = null;
          }
          if (child.id === b.id) {
            p.start = newStart;
            p.end = newStart ? endTime(newStart, p.duration || p.durMin || 30) : null;
          } else if (p.start && delta) {
            const start = minutes(p.start) + delta;
            if (start < 0 || start >= 1440) throw M.fail("A subtask would cross midnight");
            p.start = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
            p.end = endTime(p.start, p.duration || p.durMin || 0);
          }
          return {
            id: child.id,
            date: input.date,
            properties: p,
            expectedDate: child.date,
            expectedUpdatedAt: child.updated_at
          };
        });
        await db.rescheduleBlocks(moves, [], {
          transactionClient: q,
          queueOwner: actor,
          queueToday: ctx.getTodayStr?.()
        });
      } else if (args.action === "complete" || args.action === "reopen") {
        const tree = await effective(q, await db.getSubtree([b.id], actor.workspaceId, q), actor);
        if (tree.some((child) => child.id !== b.id && !child.effectiveDone))
          throw M.fail("Select a concrete task; unfinished subtasks remain", 409);
        const result = await db.setTaskCompletion({
          taskRef: b.id,
          completed: args.action === "complete",
          mutationId: "chat:" + args.sourceEventId,
          expectedRevision: b.properties._completionRevision || null,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          transactionClient: q,
          includeDescendants: false
        });
        return { task: safeTask(result.task || (await row(q, b.id, actor))) };
      } else if (args.action === "restore") {
        if (!b.deleted_at) throw M.fail("Task is not deleted", 409);
        await db.undeleteBlock(b.id, q, b.properties._deleteUndoToken);
      } else throw M.fail("Use bulk prepare/run for recoverable deletion");
      return { task: safeTask(await row(q, b.id, actor, true)) };
    });
  }
  async function repeats(args, actor) {
    need(actor, "dcc.repeats.read");
    if (args.action === "list" || args.action === "get") {
      await authorize(pool, actor);
      const r = await pool.query(
        "SELECT * FROM blocks WHERE workspace_id=$1 AND (user_id=$2 OR user_id IS NULL) AND deleted_at IS NULL AND properties->>'kind'='responsibility_item' ORDER BY id",
        [actor.workspaceId, actor.userId]
      );
      const rows = r.rows.map(db.parseBlock).filter((b) => !args.id || b.id === args.id);
      return { definitions: rows.map((b) => ({ id: b.id, properties: b.properties, version: version(b) })) };
    }
    need(actor, "dcc.repeats.write");
    return once(args, actor, async (q) => {
      const input = fields(args.input || {}, [
        "title",
        "slug",
        "description",
        "repeatType",
        "scheduleRule",
        "cadence",
        "cadenceDays",
        "asNeeded",
        "domain",
        "area",
        "duration",
        "estimatedMinutes",
        "nextTaskTitle",
        "defaultSubtasks",
        "templateTree",
        "activityTaskType",
        "publicVisibility"
      ]);
      if (args.action === "create") {
        const slug = "chat-repeat-" + M.digest([actor.userId, args.sourceEventId]).slice(0, 24);
        const saved = await reps.upsertResponsibility({
          properties: { ...input, slug },
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          client: q
        });
        return { definitionId: saved.id };
      }
      await lockSeries(q, [args.id], actor);
      const b = await check(q, args.id, args.expectedVersion, actor);
      if (!definition(b)) throw M.fail("Repeat definition not found", 404);
      if (args.action === "update") {
        if (b.properties.repeatType === "scheduled" && input.repeatType === "readiness")
          await reps.convertScheduledToReadiness({
            id: b.id,
            workspaceId: actor.workspaceId,
            changes: input,
            transactionClient: q
          });
        else if (b.properties.repeatType === "scheduled")
          await reps.changeScheduledSeriesLocked({
            id: b.id,
            userId: actor.userId,
            workspaceId: actor.workspaceId,
            action: "update",
            scope: "series",
            changes: { properties: input },
            client: q
          });
        else
          await reps.upsertResponsibility({
            properties: { ...b.properties, ...input, slug: b.properties.slug },
            userId: actor.userId,
            workspaceId: actor.workspaceId,
            client: q
          });
      } else if (["pause", "resume", "skip"].includes(args.action)) {
        const rec = require("./lib/recurrence");
        const transform =
          args.action === "pause"
            ? (p) => rec.applyPause(p, null)
            : args.action === "resume"
              ? (p) => rec.applyResume(p)
              : (p) => rec.applySkip(p, new Date());
        await reps.applyLifecycle(b.id, actor.workspaceId, { client: q }, transform);
      } else throw M.fail("Use bulk prepare/run to delete definitions and their open occurrences");
      return { definitionId: b.id, version: version(await row(q, b.id, actor)) };
    });
  }
  async function organization(args, actor) {
    need(actor, "dcc.organization.read");
    await authorize(pool, actor);
    if (args.action === "list") {
      const organization = await projects.listOrganization(actor.workspaceId);
      return Object.fromEntries(
        Object.entries(organization).map(([key, rows]) => [key, rows.map((b) => ({ ...b, version: version(b) }))])
      );
    }
    if (args.action === "preview_import") return projects.previewImport(args.input || {});
    need(actor, "dcc.organization.write");
    return once(args, actor, async (q) => {
      if (args.action === "import") {
        need(actor, "dcc.tasks.write");
        const input = fields(args.input || {}, ["manifest", "idempotencyKey"]);
        const result = await projects.commitImport(
          input.manifest,
          { idempotencyKey: input.idempotencyKey || args.sourceEventId },
          actor,
          q
        );
        return { projectId: result.project.id, taskIds: result.tasks.map((b) => b.id), duplicate: result.duplicate };
      }
      const methods = {
        project: ["createProject", "patchProject"],
        category: ["createFacet", "patchFacet"],
        view: ["createView", "patchView"]
      };
      const methodsFor = methods[args.kind];
      if (!methodsFor) throw M.fail("Unknown organization kind");
      let b;
      if (args.action === "create") b = await projects[methodsFor[0]](args.input || {}, actor, q);
      else if (args.action === "update") {
        await check(q, args.id, args.expectedVersion, actor);
        b = await projects[methodsFor[1]](args.id, args.input || {}, actor, q);
      } else if (args.action === "delete") {
        const existing = await check(q, args.id, args.expectedVersion, actor);
        if (!["project", "task_facet", "task_view"].includes(existing.properties.kind))
          throw M.fail("Organization record not found", 404);
        // Archive projects/categories so references and completed history remain valid.
        b = await db.updateBlock(
          existing.id,
          {
            properties: {
              ...existing.properties,
              ...(existing.properties.kind === "project" ? { status: "archived" } : { archived: true })
            }
          },
          q
        );
        if (existing.properties.kind === "task_view")
          await db.deleteBlock(existing.id, q, "chat:" + args.sourceEventId);
      } else throw M.fail("Unknown organization action");
      return { id: b.id, version: version(b) };
    });
  }
  async function bulk(args, actor) {
    need(actor, "dcc.tasks.read");
    if (args.action === "prepare") {
      need(actor, "dcc.tasks.write");
      return once(args, actor, async (q) => {
        const ids = Array.isArray(args.ids) ? [...new Set(args.ids)] : [];
        if ((!ids.length && !args.allRepeats) || ids.length > 1000)
          throw M.fail("Select 1–1000 records, or allRepeats");
        if (args.allRepeats) {
          need(actor, "dcc.repeats.read");
          need(actor, "dcc.repeats.write");
        }
        let selected = [];
        if (args.allRepeats) {
          const r = await q.query(
            "SELECT * FROM blocks WHERE workspace_id=$1 AND (user_id=$2 OR user_id IS NULL) AND deleted_at IS NULL AND properties->>'kind'='responsibility_item'",
            [actor.workspaceId, actor.userId]
          );
          selected = r.rows.map(db.parseBlock);
        }
        for (const id of ids) selected.push(await row(q, id, actor));
        const rows = new Map();
        for (const b of selected) {
          if (Itinerary.calendarOwned(b)) throw M.fail("Remove this event in its source calendar", 409);
          if (!definition(b) && !db.isTaskRow(b))
            throw M.fail("Cleanup accepts tasks and repeat definitions only", 400);
          if (await seriesFor(q, b, actor)) {
            need(actor, "dcc.repeats.read");
            need(actor, "dcc.repeats.write");
          }
          rows.set(b.id, b);
          if (definition(b)) {
            const instances = await db.getRepeatSeriesBlocks(b.id, actor.workspaceId, {}, q);
            for (const child of instances) rows.set(child.id, child);
            for (const root of instances)
              for (const child of await db.getSubtree([root.id], actor.workspaceId, q)) rows.set(child.id, child);
          } else for (const child of await db.getSubtree([b.id], actor.workspaceId, q)) rows.set(child.id, child);
        }
        if (
          [...rows.values()].some(
            (b) => b.workspace_id !== actor.workspaceId || (b.user_id != null && b.user_id !== actor.userId)
          )
        )
          throw M.fail("Cleanup includes records from another account", 403);
        const effectiveRows = await effective(q, [...rows.values()], actor);
        const manifest = [];
        for (const b of effectiveRows.filter((b) => definition(b) || (db.isTaskRow(b) && !b.effectiveDone)))
          manifest.push({
            id: b.id,
            title: b.properties.title,
            version: version(b),
            definition: definition(b),
            seriesId: await seriesFor(q, b, actor)
          });
        if (manifest.some((b) => b.seriesId)) {
          need(actor, "dcc.repeats.read");
          need(actor, "dcc.repeats.write");
        }
        if (manifest.length > 5000) throw M.fail("Cleanup exceeds 5000 records; select fewer series");
        const jobId = "chat-cleanup-" + M.digest([actor.userId, actor.workspaceId, args.sourceEventId]).slice(0, 32);
        await q.query("INSERT INTO chat_cleanup_jobs(id,user_id,workspace_id,manifest) VALUES($1,$2,$3,$4)", [
          jobId,
          actor.userId,
          actor.workspaceId,
          JSON.stringify(manifest)
        ]);
        return {
          jobId,
          status: "prepared",
          count: manifest.length,
          items: manifest.slice(0, 50),
          nextOffset: manifest.length > 50 ? 50 : null
        };
      });
    }
    return tx(actor, async (q) => {
      const r = await q.query(
        "SELECT * FROM chat_cleanup_jobs WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE",
        [args.jobId, actor.userId, actor.workspaceId]
      );
      const job = r.rows[0];
      if (!job) throw M.fail("Cleanup not found", 404);
      if (job.manifest.some((x) => x.seriesId)) need(actor, "dcc.repeats.read");
      const offset = Number(args.offset || 0);
      if (!Number.isInteger(offset) || offset < 0) throw M.fail("Invalid offset");
      if (args.action === "status")
        return {
          jobId: job.id,
          status: job.status,
          total: job.manifest.length,
          processed: job.results.length,
          items: job.manifest.slice(offset, offset + 50),
          results: job.results.slice(offset, offset + 50).map((r) => ({ id: r.id, status: r.status })),
          nextOffset: job.manifest.length > offset + 50 ? offset + 50 : null
        };
      need(actor, "dcc.tasks.write");
      if (job.manifest.some((x) => x.seriesId)) need(actor, "dcc.repeats.write");
      if (!["run", "undo"].includes(args.action)) throw M.fail("Unknown cleanup action");
      await lockSeries(
        q,
        job.manifest.map((x) => x.seriesId),
        actor
      );
      const results = job.results;
      if (args.action === "run") {
        if (job.status === "restored" || job.status === "restoring")
          throw M.fail("This cleanup has been restored; prepare a new operation", 409);
        // Retire every definition first, in this transaction under the exact
        // locks held by both scheduled and as-needed materialization.
        const definitions = job.manifest.filter((x) => x.definition && !results.some((r) => r.id === x.id));
        for (const item of definitions) {
          const b = await check(q, item.id, item.version, actor);
          await db.deleteBlock(b.id, q, job.id);
          results.push({
            id: b.id,
            before: b,
            afterVersion: version(await row(q, b.id, actor, true)),
            status: "deleted"
          });
        }
        const pending = job.manifest.filter((x) => !x.definition && !results.some((r) => r.id === x.id)).slice(0, 25);
        const queue = await require("./lib/working-queue").snapshot(q, actor, db);
        const runningWorkers = new Set(
          queue.items.filter((item) => item.execution?.state === "running").map((item) => item.task.id)
        );
        for (const item of pending) {
          const b = await row(q, item.id, actor, true);
          if (
            b.deleted_at ||
            Itinerary.calendarOwned(b) ||
            version(b) !== item.version ||
            b.properties.startedAt ||
            runningWorkers.has(b.id)
          ) {
            results.push({ id: b.id, status: "conflict" });
            continue;
          }
          if ((await effective(q, [b], actor))[0].effectiveDone) {
            results.push({ id: b.id, status: "preserved_completed" });
            continue;
          }
          const deps = await q.query(
            "SELECT 1 FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL AND properties->>'blockerType'='task' AND properties->>'blockerBlockId'=$2 LIMIT 1",
            [actor.workspaceId, b.id]
          );
          if (
            deps.rows.length ||
            b.properties.dependencyWaitingItemId ||
            b.properties.dependencyWaitingItemIds?.length
          ) {
            results.push({ id: b.id, status: "conflict_dependencies" });
            continue;
          }
          await db.deleteBlock(b.id, q, job.id);
          results.push({
            id: b.id,
            before: b,
            afterVersion: version(await row(q, b.id, actor, true)),
            status: "deleted"
          });
        }
        job.status =
          results.length === job.manifest.length
            ? results.some((x) => x.status.startsWith("conflict"))
              ? "completed_with_conflicts"
              : "completed"
            : "running";
      } else {
        // Restore definitions last; otherwise recurrence can generate replacements
        // while restoration is still in progress. Preserve intervening edits.
        const ordered = results
          .filter((x) => x.status === "deleted")
          .sort((a, b) => Number(definition(a.before)) - Number(definition(b.before)))
          .slice(0, 25);
        for (const result of ordered) {
          const b = await row(q, result.id, actor, true);
          if (version(b) !== result.afterVersion)
            throw M.fail("A deleted record changed; restoration requires review", 409);
          await db.undeleteBlock(b.id, q, job.id);
          result.status = "restored";
        }
        job.status = results.some((x) => x.status === "deleted") ? "restoring" : "restored";
      }
      await q.query("UPDATE chat_cleanup_jobs SET results=$1,status=$2,updated_at=NOW() WHERE id=$3", [
        JSON.stringify(results),
        job.status,
        job.id
      ]);
      ctx.broadcast?.("blocks-changed", { action: "chat-cleanup", jobId: job.id }, actor.workspaceId);
      return {
        jobId: job.id,
        status: job.status,
        processed: results.length,
        total: job.manifest.length,
        deleted: results.filter((x) => x.status === "deleted").length,
        conflicts: results.filter((x) => x.status.startsWith("conflict")).map((x) => ({ id: x.id, status: x.status })),
        saveStatus: "verified_saved"
      };
    });
  }
  const attachments =
    ctx.taskAttachmentStore ||
    require("./task-attachment-store").createStore({
      pool,
      storage: require("./lib/task-attachment-storage").createStorage()
    });
  async function files(args, actor) {
    need(actor, "dcc.files.read");
    await authorize(pool, actor);
    if (args.action === "list")
      return { configured: attachments.configured, files: await attachments.list(actor, args.taskId) };
    if (!require("./lib/task-attachment-policy").UUID.test(args.id || "")) throw M.fail("Provide a valid file UUID");
    if (args.action === "download") {
      const file = await attachments.download(actor, args.taskId, args.id.toLowerCase());
      return { ...file, bytes: undefined, base64: file.bytes.toString("base64") };
    }
    need(actor, "dcc.files.write");
    if (args.action === "upload") {
      const policy = require("./lib/task-attachment-policy");
      if (
        typeof args.base64 !== "string" ||
        args.base64.length > Math.ceil((policy.MAX_BYTES * 4) / 3) + 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(args.base64)
      )
        throw M.fail("Invalid or oversized file");
      const bytes = Buffer.from(args.base64, "base64"),
        meta = policy.validateFile({ buffer: bytes, originalname: args.filename, mimetype: args.mime });
      const file = await attachments.upload(actor, args.taskId, args.id.toLowerCase(), meta, bytes);
      return { ...file, taskId: args.taskId, saveStatus: file.pending ? "pending" : "verified_saved" };
    }
    if (args.action === "remove") await attachments.remove(actor, args.taskId, args.id.toLowerCase());
    else if (args.action === "restore") await attachments.restore(actor, args.taskId, args.id.toLowerCase());
    else throw M.fail("Unknown file action");
    return { id: args.id.toLowerCase(), taskId: args.taskId, saveStatus: "verified_saved" };
  }
  async function attachChatFile(args, actor) {
    need(actor, "dcc.files.read");
    need(actor, "dcc.files.write");
    await authorize(pool, actor);
    fields(args, ["taskId", "id", "filename", "file"]);
    const policy = require("./lib/task-attachment-policy");
    if (!policy.UUID.test(args.id || "")) throw M.fail("Use a stable UUID v4 for upload retries");
    if (!attachments.configured) throw M.fail("Private task file storage is not configured", 503);
    await attachments.authorize(actor, args.taskId);
    const { meta, bytes } = await require("./lib/chat-file-input").readChatFile(args.file, args.filename);
    await activeGrant(pool, actor);
    const file = await attachments.upload(actor, args.taskId, args.id.toLowerCase(), meta, bytes);
    return { ...file, taskId: args.taskId, saveStatus: file.pending ? "pending" : "verified_saved" };
  }

  const appZone = ctx.APP_TIME_ZONE || "America/New_York";
  async function itineraryRows(q, actor, start, end) {
    const { rows } = await q.query(
      `SELECT * FROM blocks WHERE workspace_id=$1 AND (user_id=$2 OR user_id IS NULL)
       AND type='block' AND deleted_at IS NULL AND date BETWEEN $3 AND $4 ORDER BY date,sort_order,id`,
      [actor.workspaceId, actor.userId, Zones.shiftDate(start, -2), Zones.shiftDate(end, 2)]
    );
    return rows
      .map(db.parseBlock)
      .filter(foldsIntoItinerary)
      .filter((b) => !b.properties.retiredContainerHidden);
  }

  function itineraryEntry(b, zone) {
    const p = b.properties;
    const times = Itinerary.interval(b, appZone);
    const start = times && Zones.civil(times.start, zone);
    const end = times?.end && Zones.civil(times.end, zone);
    return {
      ...safeTask(b),
      date: start?.date || b.date,
      start: start?.time || p.start || null,
      end: end?.time || p.end || null,
      endDate: end?.date || null,
      startAt: times ? new Date(times.start).toISOString() : null,
      endAt: times?.end ? new Date(times.end).toISOString() : null,
      timeZone: times?.fixed ? p.scheduleInstant.zone : null,
      fixedCommitment: p.userSetStart === true || Itinerary.calendarOwned(b),
      calendarOwned: Itinerary.calendarOwned(b),
      travel: p.itineraryTravel || null
    };
  }

  async function itineraryRead(args, actor) {
    need(actor, "dcc.itinerary.read");
    await authorize(pool, actor);
    fields(args, ["date", "endDate", "viewingZone", "offset"]);
    const { date, endDate = date, viewingZone = appZone, offset = 0 } = args;
    if (!Zones.validDate(date) || !Zones.validDate(endDate) || endDate < date || endDate > Zones.shiftDate(date, 62))
      throw M.fail("Provide a date range of up to 63 days");
    if (!Zones.validZone(viewingZone)) throw M.fail("Provide an IANA viewing timezone");
    if (!Number.isSafeInteger(offset) || offset < 0) throw M.fail("Invalid offset");
    const rows = await itineraryRows(pool, actor, date, endDate);
    const first = Zones.dayWindow(date, viewingZone).start;
    const last = Zones.dayWindow(endDate, viewingZone).end;
    const matching = rows.filter((b) => {
      if (Itinerary.calendarOwned(b) && !canReadCalendar(actor)) return false;
      const times = Itinerary.interval(b, appZone);
      if (times) return times.start < last && (times.end ? times.end > first : times.start >= first);
      if (b.properties.all_day)
        return b.date <= endDate && (b.properties.all_day_end || Zones.shiftDate(b.date, 1)) > date;
      return b.date >= date && b.date <= endDate;
    });
    const activities = (await effective(pool, matching, actor)).map((b) => itineraryEntry(b, viewingZone));
    activities.sort((a, b) => a.date.localeCompare(b.date) || (a.startAt || "").localeCompare(b.startAt || ""));
    return {
      viewingZone,
      activities: activities.slice(offset, offset + 100),
      nextOffset: activities.length > offset + 100 ? offset + 100 : null
    };
  }

  async function itineraryWrite(args, actor) {
    need(actor, "dcc.itinerary.read");
    need(actor, "dcc.itinerary.write");
    fields(args, ["action", "id", "expectedVersion", "sourceEventId", "input", "allowOverlapWith", "moveFixed"]);
    if (!["create", "update", "schedule"].includes(args.action)) throw M.fail("Unsupported itinerary action", 422);
    const input = fields(args.input, [
      "title",
      "detail",
      "date",
      "start",
      "end",
      "endDate",
      "timeZone",
      "startOffset",
      "endOffset",
      "location",
      "travel"
    ]);
    const editsTiming = ["date", "start", "end", "endDate", "timeZone", "startOffset", "endOffset"].some((key) =>
      Object.hasOwn(input, key)
    );
    if (args.action === "update" && editsTiming) throw M.fail("Use schedule to move an existing activity");
    const slot = args.action === "update" ? null : Itinerary.placement(input, appZone);
    if (args.moveFixed !== undefined && typeof args.moveFixed !== "boolean") throw M.fail("Invalid moveFixed");
    const allowed = args.allowOverlapWith ?? [];
    if (
      !Array.isArray(allowed) ||
      allowed.length > 20 ||
      allowed.some((id) => typeof id !== "string" || !id || id.length > 200)
    )
      throw M.fail("Provide up to 20 exact overlap IDs");
    const changes = {};
    if (input.title !== undefined) changes.title = M.text(input.title, "title", 300);
    if (input.detail !== undefined) {
      if (typeof input.detail !== "string" || input.detail.length > 5000) throw M.fail("Invalid detail");
      changes.detail = input.detail;
    }
    if (input.location !== undefined) changes.taskLocation = itineraryLocation(input.location);
    if (input.travel !== undefined) changes.itineraryTravel = itineraryTravel(input.travel);
    if (!slot && !Object.keys(changes).length) throw M.fail("Provide at least one field to update");
    return once({ ...args, tool: "itinerary" }, actor, async (q) => {
      let b;
      if (args.action !== "create") {
        b = await check(q, args.id, args.expectedVersion, actor);
        if (b.deleted_at || !foldsIntoItinerary(b)) throw M.fail("Activity not found", 404);
        if (Itinerary.calendarOwned(b)) throw M.fail("Change this event in its source calendar", 409);
        if (await seriesFor(q, b, actor)) need(actor, "dcc.repeats.write");
        if ((await effective(q, [b], actor))[0].effectiveDone)
          throw M.fail("Completed activities retain their recorded plan", 409);
        if (slot) {
          if (b.properties.userSetStart && args.moveFixed !== true)
            throw M.fail("Fixed commitment. Set moveFixed only when the user explicitly asks to move this entry", 409);
          const tree = await db.getSubtree([b.id], actor.workspaceId, q);
          if (tree.some((child) => child.id !== b.id) || b.properties.subtaskOf || b.properties.wrapId)
            throw M.fail("Schedule a standalone activity. Nested moves require the DCC placement controls", 422);
        }
      } else if (!changes.title || args.id !== undefined) {
        throw M.fail("Create requires a title and no existing ID");
      }

      if (slot) {
        const rows = await itineraryRows(q, actor, slot.date, slot.date);
        const conflicts = rows.filter((existing) => {
          if (existing.id === b?.id) return false;
          const times = Itinerary.interval(existing, appZone);
          return (
            times?.end &&
            times.start < slot.endMs &&
            times.end > slot.startMs &&
            !(allowed.includes(existing.id) && (!Itinerary.calendarOwned(existing) || canReadCalendar(actor)))
          );
        });
        if (conflicts.length) {
          const visible = conflicts.filter((existing) => !Itinerary.calendarOwned(existing) || canReadCalendar(actor));
          const hidden = conflicts.length - visible.length;
          const message = visible.length
            ? "Overlapping entries: " +
              visible
                .slice(0, 10)
                .map((existing) => existing.id)
                .join(", ") +
              ". "
            : "";
          throw M.fail(
            message +
              (hidden ? "A connected calendar commitment also occupies this time. " : "") +
              "Read the itinerary and specify only explicitly permitted overlaps.",
            409
          );
        }
      }

      if (!b) {
        b = await projects.createTask(
          {
            id: "chat-itinerary-" + M.digest([actor.userId, actor.workspaceId, args.sourceEventId]).slice(0, 32),
            title: changes.title,
            detail: changes.detail,
            date: slot.date,
            duration: slot.properties.duration,
            kind: "task",
            source: "conversation"
          },
          actor,
          q
        );
      }
      const properties = { ...b.properties, ...slot?.properties, ...changes };
      if (slot) {
        delete properties.all_day;
        delete properties.all_day_start;
        delete properties.all_day_end;
        delete properties.schedulePlacement;
        delete properties.reschedulePlacement;
        delete properties.timeBlockPlacement;
        properties._pinnedStart = properties.start;
        if (b.date && b.date !== slot.date) properties.rescheduledFrom = { date: b.date, at: new Date().toISOString() };
        await db.rescheduleBlocks(
          [{ id: b.id, date: slot.date, properties, expectedDate: b.date, expectedUpdatedAt: b.updated_at }],
          [],
          {
            transactionClient: q,
            queueOwner: actor,
            queueToday: ctx.getTodayStr?.()
          }
        );
      } else {
        await db.updateBlock(b.id, { properties }, q);
      }
      const saved = await row(q, b.id, actor);
      return { activity: itineraryEntry(saved, input.timeZone || saved.properties.scheduleInstant?.zone || appZone) };
    });
  }

  return { tasks, repeats, organization, bulk, files, attachChatFile, itineraryRead, itineraryWrite };
}
function canReadCalendar(actor) {
  return has(actor, "dcc.calendar.read") || has(actor, "dcc.read");
}

function itineraryLocation(value) {
  if (value === null) return null;
  fields(value, ["label", "address", "latitude", "longitude", "mapsUrl"]);
  const result = {};
  for (const key of ["label", "address"]) {
    if (value[key] !== undefined) result[key] = M.text(value[key], key, 180);
  }
  if (value.mapsUrl !== undefined) {
    let url;
    try {
      url = new URL(M.text(value.mapsUrl, "mapsUrl", 2000));
    } catch {
      throw M.fail("Invalid maps URL");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw M.fail("Use a public HTTPS maps URL");
    result.mapsUrl = url.href;
  }
  if (value.latitude !== undefined || value.longitude !== undefined) {
    if (
      !Number.isFinite(value.latitude) ||
      Math.abs(value.latitude) > 90 ||
      !Number.isFinite(value.longitude) ||
      Math.abs(value.longitude) > 180
    )
      throw M.fail("Invalid coordinates");
    result.latitude = value.latitude;
    result.longitude = value.longitude;
  }
  if (!result.label && !result.address) throw M.fail("Provide a place name or address");
  return result;
}

function itineraryTravel(value) {
  if (value === null) return null;
  const keys = [
    "origin",
    "destination",
    "method",
    "serviceNumber",
    "platformOrGate",
    "reservation",
    "confirmationNumber"
  ];
  fields(value, [...keys, "durationMinutes"]);
  const result = {};
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = M.text(value[key], key, key === "reservation" ? 500 : 180);
  }
  if (value.durationMinutes !== undefined) {
    if (!Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 1440)
      throw M.fail("Invalid travel duration");
    result.durationMinutes = value.durationMinutes;
  }
  return result;
}

function validateDate(date) {
  if (
    date !== undefined &&
    date !== null &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    throw M.fail("Invalid date");
}
function validateTime(time) {
  if (time !== undefined && time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw M.fail("Invalid start time");
}
function endTime(time, duration) {
  const [h, m] = time.split(":").map(Number),
    end = h * 60 + m + Number(duration);
  if (end > 1440) throw M.fail("Task cannot cross midnight");
  return `${String(Math.floor(end / 60) % 24).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}
module.exports = { SCHEMA_SQL, createChatControlStore, version, validateDate, validateTime };
