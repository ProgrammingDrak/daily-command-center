// Explicit owner namespace. Session identity stays the actor; a verified grant
// selects only the target workspace. Existing owner APIs accept no delegation.
const policy = require("../public/js/task-action-policy");
const { createStore } = require("../task-action-store");
module.exports = function mount(app, ctx) {
  const { pool, blockDB, accessStore, socialStore, route, broadcast, getTodayStr } = ctx;
  const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  async function invoke(handler, scope, params, body) {
    let code = 200,
      result;
    const req = {
      params,
      body,
      session: { userId: scope.actorUserId },
      workspaceId: scope.workspaceId,
      headers: {},
      query: {}
    };
    const res = {
      setHeader() {},
      status(value) {
        code = value;
        return this;
      },
      json(value) {
        result = value;
        return this;
      }
    };
    const returned = await handler(req, res, scope);
    if (result === undefined) result = returned;
    if (code >= 400) throw fail(result?.error || "Action failed", code);
    return result;
  }
  async function execute(scope, request, row) {
    // Re-resolve actor authority immediately before the canonical command. No
    // browser-supplied mode, owner role, or workspace ever reaches this function.
    const authority = await store.access(request.actor_user_id, request.owner_user_id);
    if (
      policy.mode(authority.modes, request.action) === "view" ||
      (request.reviewed_by !== request.owner_user_id && policy.mode(authority.modes, request.action) !== "execute")
    )
      throw fail("Action permission was revoked or changed", 403);
    const principal = {
      ...scope,
      expectedUpdatedAt: request.snapshot.updatedAt,
      authorize: (client) => store.authorize(request, client)
    };
    const p = request.payload;
    if (request.action === "complete")
      return invoke(
        ctx.taskActionHandlers.complete,
        principal,
        { taskRef: row.id },
        {
          completed: p.completed,
          taskDate: request.snapshot.date,
          mutationId: "task-action:" + request.id,
          expectedRevision: request.snapshot.completionRevision
        }
      );
    if (request.action === "schedule")
      return invoke(
        ctx.taskActionHandlers.schedule,
        principal,
        { id: row.id },
        {
          targetDate: p.date,
          fromDate: request.snapshot.date || p.date,
          placement: { kind: "timed", start: p.start, end: p.end },
          userSetStart: true
        }
      );
    if (request.action === "delegate")
      return invoke(
        ctx.taskActionHandlers.delegate,
        principal,
        {},
        {
          convertTaskId: row.id,
          properties: {
            myTask: row.properties.title,
            title: row.properties.title,
            delegatee: { name: p.who, kind: "person" },
            status: "open",
            blockerType: "person"
          }
        }
      );
    if (request.action === "reward") {
      const sponsor = (
        await pool.query(
          "SELECT COALESCE(NULLIF(p.display_name,''),u.username) AS name FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1",
          [scope.actorUserId]
        )
      ).rows[0];
      return socialStore.requestSponsorship({
        ownerUserId: scope.userId,
        sponsorUserId: scope.actorUserId,
        sponsorName: sponsor?.name || "Task supporter",
        targetType: "task",
        targetId: row.id,
        rewardTitle: p.title,
        valueCents: 0,
        workspaceId: scope.workspaceId,
        authorize: async (client) => {
          await principal.authorize(client);
          const fresh = (
            await client.query(
              "SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL FOR UPDATE",
              [row.id, scope.workspaceId]
            )
          ).rows[0];
          if (!fresh || new Date(fresh.updated_at).getTime() !== new Date(request.snapshot.updatedAt).getTime())
            throw fail("Task changed. Refresh before applying.", 409);
          if (blockDB.isCompletedTaskProps(fresh.properties))
            throw fail("Reopen the task before adding an incentive", 409);
        }
      });
    }
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      await principal.authorize(client);
      const locked = (
        await client.query("SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL FOR UPDATE", [
          row.id,
          scope.workspaceId
        ])
      ).rows[0];
      if (!locked || new Date(locked.updated_at).getTime() !== new Date(request.snapshot.updatedAt).getTime())
        throw fail("Task changed. Refresh before applying.", 409);
      if (request.action === "edit") {
        result = await blockDB.updateBlock(row.id, { properties: { ...locked.properties, title: p.title } }, client);
        const refs = [row.id, locked.properties.local_id].filter(Boolean);
        const related = (
          await client.query(
            `SELECT * FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL AND properties->>'kind'='delegated_item'
     AND (properties->>'linkedBlockId'=ANY($2::text[]) OR properties->>'blockerBlockId'=ANY($2::text[])) FOR UPDATE NOWAIT`,
            [scope.workspaceId, refs]
          )
        ).rows;
        for (const item of related) {
          const props = { ...item.properties };
          if (refs.includes(props.linkedBlockId)) props.myTask = p.title;
          if (refs.includes(props.blockerBlockId)) props.title = p.title;
          await blockDB.updateBlock(item.id, { properties: props }, client);
        }
      }
      if (request.action === "react")
        result = await require("../task-reaction-store").set(client, {
          workspaceId: scope.workspaceId,
          taskId: row.id,
          taskDate: request.snapshot.date,
          title: locked.properties.title,
          actorUserId: scope.actorUserId,
          emoji: p.emoji,
          active: p.active
        });
      if (request.action === "bounty") {
        if (
          !locked.date ||
          new Date(locked.date).toISOString().slice(0, 10) !== getTodayStr() ||
          blockDB.isCompletedTaskProps(locked.properties) ||
          ["meeting", "oneone", "calendar", "break", "ooo"].includes(locked.properties.type)
        )
          throw fail("Choose an unfinished task on today’s itinerary", 409);
        const rootId = await blockDB.ensureDayRoot(getTodayStr(), scope.userId, scope.workspaceId, client);
        const root = (await client.query("SELECT * FROM blocks WHERE id=$1 FOR UPDATE", [rootId])).rows[0];
        const bounty = root.properties?._bounty || {};
        const localId = locked.properties.local_id || row.id;
        if (bounty.self?.taskId || (bounty.taskId && !bounty.self))
          throw fail("Today’s self bounty is already locked", 409);
        if (bounty.partner?.taskId && String(bounty.partner.taskId) !== String(localId))
          throw fail("The bounty must stack on the sponsored task", 409);
        result = await blockDB.updateBlock(
          rootId,
          {
            properties: {
              ...root.properties,
              _bounty: {
                ...bounty,
                self: {
                  taskId: localId,
                  taskTitle: locked.properties.title,
                  placedAt: new Date().toISOString(),
                  source: "self",
                  actorUserId: scope.actorUserId
                }
              }
            }
          },
          client
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    broadcast("blocks-changed", { action: "task-action", blockIds: [row.id] }, scope.workspaceId);
    return result;
  }
  const store = createStore({ pool, blockDB, accessStore, socialStore, execute });
  ctx.taskActionStore = store;
  const receipt = (item) => ({
    id: item.id,
    action: item.action,
    payload: item.payload,
    snapshot: item.snapshot,
    status: item.status,
    actorUserId: item.actor_user_id,
    createdAt: item.created_at,
    result: item.status === "failed" ? { error: item.result?.error } : undefined
  });
  const ids = (req) => ({
    actor: Number(req.session?.userId),
    owner: req.params.ownerId === "self" ? Number(req.session?.userId) : Number(req.params.ownerId)
  });
  app.get(
    "/api/task-view/:ownerId/access",
    route(async (req) => {
      const { actor, owner } = ids(req);
      const a = await store.access(actor, owner);
      return { ownerUserId: owner, role: a.role, modes: a.modes };
    })
  );
  app.get(
    "/api/task-view/:ownerId/tasks/:taskId",
    route(async (req) => {
      const { actor, owner } = ids(req),
        a = await store.access(actor, owner),
        task = await store.task(a, req.params.taskId);
      const reactions = await require("../task-reaction-store").list(pool, a.workspaceId, task.id, "user:" + actor);
      return {
        task: {
          id: task.id,
          date: task.date,
          updatedAt: new Date(task.updated_at).toISOString(),
          completed: blockDB.isCompletedTaskProps(task.properties),
          properties: Object.fromEntries(
            ["title", "status", "done", "completedAt", "start", "end"].map((key) => [key, task.properties[key]])
          )
        },
        modes: a.modes,
        reactions,
        role: a.role
      };
    })
  );
  app.post(
    "/api/task-view/:ownerId/tasks/:taskId/actions",
    route(async (req) =>
      receipt(
        await store.submit({
          ...ids(req),
          taskId: req.params.taskId,
          action: req.body?.action,
          payload: req.body?.payload,
          requestKey: req.body?.requestKey,
          expectedUpdatedAt: req.body?.expectedUpdatedAt
        })
      )
    )
  );
  app.get(
    "/api/task-view/:ownerId/suggestions",
    route(async (req) => {
      const { actor, owner } = ids(req);
      const items = await store.list(actor, owner, typeof req.query.before === "string" ? req.query.before : null);
      return { items: items.slice(0, 100).map(receipt), next: items.length > 100 ? items[99].id : null };
    })
  );
  app.post(
    "/api/task-view/:ownerId/suggestions/:id/review",
    route(async (req) => receipt(await store.decide({ ...ids(req), id: req.params.id, decision: req.body?.decision })))
  );
  app.put(
    "/api/access/grants/:granteeUserId/task-permissions",
    route(async (req) => {
      const actor = Number(req.session?.userId),
        grantee = Number(req.params.granteeUserId),
        permissions = req.body?.permissions;
      if (!Number.isSafeInteger(actor) || actor <= 0) throw fail("Sign in first", 401);
      if (!Number.isSafeInteger(grantee) || grantee <= 0 || actor === grantee || !policy.valid(permissions))
        throw fail("Invalid task permissions");
      if (await socialStore.isBlocked(actor, grantee)) throw fail("Access is blocked", 403);
      return accessStore.setTaskPermissions({ ownerUserId: actor, granteeUserId: grantee, permissions });
    })
  );
};
