// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
//
// Delegated access: the owner-only grant management endpoints, plus the
// /api/coach/:ownerUserId/* namespace where a grantee actually acts.
//
// WHY A SEPARATE NAMESPACE, rather than teaching the existing endpoints to
// accept an "on behalf of" parameter:
//
//  - Blast radius. Every existing route resolves its target from the session via
//    resolve-owner.js. Adding a delegation parameter there would make EVERY
//    endpoint in the app potentially delegatable, including ones nobody audited
//    for it. A separate namespace means Drake's own day cannot change behavior
//    because of this feature.
//  - One authorization site. The guard below is the only place a delegated
//    request is authorized, so there is no second copy to drift.
//  - Legibility. A delegated write is obvious in the path and in the logs.
//
// And note what this namespace deliberately does NOT do: it adds no new
// precedence order. resolve-owner.js warns that a third fallback chain is
// probably a mistake, and it is right -- but this has no fallback at all. The
// owner is EXPLICIT in the URL and checked against a grant. Nothing is inferred,
// so there is no chain to get wrong.
// The canonical block -> task projection, shared with the itinerary. Required
// here rather than re-derived so the coach view cannot drift from what the owner
// sees. UMD, so the same file the browser loads is the one this requires.
const TaskModel = require("../public/js/task-model.js");

module.exports = function mount(app, ctx) {
  const { accessStore, buildDayResponse, blockDB, broadcast, capabilities, coerceDateString, getTodayStr, isValidDate, pool, route, socialStore } = ctx;

  // ── Owner-only grant management ───────────────────────────────────────────
  // Every one of these acts on req.session.userId AS THE OWNER. There is no
  // parameter naming a different owner, which is what makes "only the owner can
  // grant" true by signature rather than by a check that could be forgotten.

  app.get("/api/access/grants", route(req => accessStore.listGrants(req.session.userId)));

  app.get("/api/access/granted-to-me", route(req => accessStore.listGrantedToMe(req.session.userId)));

  app.get("/api/access/events", route(req =>
    accessStore.listGrantEvents(req.session.userId, { limit: parseInt(req.query.limit, 10) || 50 })));

  app.post("/api/access/grants", route(async (req, res) => {
    const body = req.body || {};
    const result = await accessStore.grantAccess({
      ownerUserId: req.session.userId,
      granteeUserId: parseInt(body.granteeUserId, 10),
      role: body.role,
      note: body.note || ""
    });
    res.status(result.previousRole ? 200 : 201);
    return result;
  }));

  app.delete("/api/access/grants/:granteeUserId", route(req =>
    accessStore.revokeAccess({
      ownerUserId: req.session.userId,
      granteeUserId: parseInt(req.params.granteeUserId, 10)
    })));

  // ── The delegated-action guard ─────────────────────────────────────────────
  // Resolves the caller's role over the named owner ONCE and hangs it on the
  // request. Every handler below states the capability it needs; none of them
  // re-derive authorization.
  //
  // Returns 403 for "not allowed" AND for "no such owner", deliberately: a
  // different status would turn this endpoint into a probe for which user ids
  // exist.
  function requireGrant(capability) {
    return async (req, res, next) => {
      try {
        const ownerUserId = parseInt(req.params.ownerUserId, 10);
        const viewerUserId = req.session && req.session.userId;
        if (!viewerUserId) return res.status(401).json({ error: "Sign in first" });
        if (!Number.isFinite(ownerUserId)) return res.status(400).json({ error: "ownerUserId required" });
        // resolveRole already refuses a blocked pair and returns "owner" for
        // self, so acting on your own data through this namespace works and
        // needs no grant.
        const role = await accessStore.resolveRole(viewerUserId, ownerUserId);
        if (!capabilities.can("user", capability, { role })) {
          return res.status(403).json({ error: "You do not have access to do that", capability });
        }
        // The owner's workspace is resolved from the OWNERSHIP table, never from
        // the caller's session or a header.
        req.grant = {
          role,
          ownerUserId,
          viewerUserId,
          ownerWorkspaceId: await socialStore.resolveWorkspaceId(ownerUserId)
        };
        next();
      } catch (e) {
        console.error("[access] guard failed, denying:", e.message);
        res.status(403).json({ error: "You do not have access to do that" });
      }
    };
  }

  // What the caller may do for this owner. Lets a client render the right
  // controls instead of guessing, and is the only place the full capability map
  // is exposed.
  app.get("/api/coach/:ownerUserId/capabilities", requireGrant("view_itinerary"), route(async (req) => ({
    ownerUserId: req.grant.ownerUserId,
    role: req.grant.role,
    capabilities: capabilities.capabilityMapFor({ tier: "user", role: req.grant.role })
  })));

  // ── Read: the owner's real day ─────────────────────────────────────────────
  app.get("/api/coach/:ownerUserId/day", requireGrant("view_itinerary"), route(async (req) => {
    const requested = coerceDateString(req.query.date);
    const date = isValidDate(requested) ? requested : getTodayStr();
    // The owner's OWN day builder, so a coach sees exactly what the owner sees
    // rather than a second projection that could drift. userId is the owner's,
    // not the caller's: this is the owner's day, viewed by someone else.
    const state = await buildDayResponse(date, req.grant.ownerUserId, req.grant.ownerWorkspaceId);

    // TASKS come from the day's BLOCKS, not from state.schedule.timeline. The
    // timeline is the MATERIALIZED PLAN and is empty on a day that was never
    // planned, so a coach opening an unplanned day saw "nothing scheduled" while
    // the owner had a full list. Found by seeding two real tasks and getting
    // zero rows back.
    //
    // Projected through TaskModel.fromBlock, the repo's canonical block -> task
    // projection, so this surface cannot drift from the itinerary on what a task
    // is called or when it runs. `points` and `durationMinutes` are attached
    // separately because fromBlock does not carry them and the coach view is
    // specifically about what work is worth.
    const rows = await blockDB.getBlocksByDate(date, req.grant.ownerWorkspaceId);
    const tasks = (rows || [])
      .filter(row => TaskModel.isTaskRow(row))
      .map(row => {
        const props = row.properties || {};
        return Object.assign(TaskModel.fromBlock(row), {
          points: Number(props.points) || 0,
          durationMinutes: Number(props.duration) || 0,
          // Provenance of a previous coach adjustment, so the view can show that
          // a number was changed and by whom rather than presenting it as the
          // owner's own estimate.
          adjustedBy: props.pointsAdjustedBy || null,
          adjustedFrom: props.pointsAdjustedFrom == null ? null : Number(props.pointsAdjustedFrom)
        });
      })
      // Chronological, untimed last. Block insertion order is creation order, so
      // without this a coach reads the day out of sequence, which is the one
      // thing a day view has to get right.
      .sort((a, b) => {
        const at = a.start || "99:99";
        const bt = b.start || "99:99";
        return at === bt ? String(a.title || "").localeCompare(String(b.title || "")) : at.localeCompare(bt);
      });

    return { date, role: req.grant.role, ownerUserId: req.grant.ownerUserId, tasks, state };
  }));

  // ── Write: adjust what a task is worth ─────────────────────────────────────
  // The first delegated WRITE, and the one the accountability idea is really
  // about. Two non-negotiables:
  //   1. ATTRIBUTED. The change records who made it, so the owner can always see
  //      that their coach did this and not them.
  //   2. LEDGERED. It appends to reward_events, the append-only audit table the
  //      reward system already treats as its source of truth.
  app.patch("/api/coach/:ownerUserId/tasks/:taskId/points", requireGrant("adjust_points"), route(async (req) => {
    const body = req.body || {};
    const points = Number(body.points);
    if (!Number.isFinite(points) || points < 0 || points > 100000) {
      const e = new Error("points must be a number between 0 and 100000"); e.statusCode = 400; throw e;
    }
    const reason = String(body.reason || "").slice(0, 280);
    const { rows } = await pool.query(
      `SELECT id, properties FROM blocks
        WHERE workspace_id=$1 AND deleted_at IS NULL
          AND (id=$2 OR properties->>'local_id'=$2)
        LIMIT 1`,
      [req.grant.ownerWorkspaceId, String(req.params.taskId)]
    );
    const block = rows[0];
    // Scoped to the owner's workspace in the query itself, so a coach cannot
    // reach a task id belonging to somebody else by guessing it.
    if (!block) { const e = new Error("Task not found"); e.statusCode = 404; throw e; }
    const previous = Number((block.properties || {}).points) || 0;

    const updated = await blockDB.updateBlock(block.id, {
      properties: {
        ...(block.properties || {}),
        points,
        // Provenance ON THE ROW as well as in the ledger: the itinerary renders
        // from properties, so this is what lets the UI show "adjusted by" without
        // a second read.
        pointsAdjustedBy: req.grant.viewerUserId,
        pointsAdjustedByRole: req.grant.role,
        pointsAdjustedAt: new Date().toISOString(),
        pointsAdjustedFrom: previous,
        pointsAdjustedReason: reason
      }
    });

    // Ledger it. Non-fatal on failure, because losing the audit row is bad but
    // silently refusing the owner's coach a legitimate change is worse -- and
    // the provenance is also on the row above.
    try {
      await socialStore.recordEvent(pool, {
        ownerUserId: req.grant.ownerUserId,
        actorUserId: req.grant.viewerUserId,
        eventType: "points_adjusted",
        sourceType: "coach_adjustment",
        // Idempotent per (task, actor, value): a double-submit records once.
        sourceId: `${block.id}:${req.grant.viewerUserId}:${points}`,
        metadata: { from: previous, to: points, role: req.grant.role, reason, taskId: block.id }
      });
    } catch (e) {
      console.error("[access] point-adjustment ledger write failed (non-fatal):", e.message);
    }

    broadcast("blocks-changed", { action: "coach-points", blockIds: [block.id] }, req.grant.ownerWorkspaceId);
    return { taskId: block.id, points, previousPoints: previous, adjustedBy: req.grant.viewerUserId, role: req.grant.role };
  }));
};
