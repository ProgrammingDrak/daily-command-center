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
  const { accessStore, badRequest, blockDB, broadcast, capabilities, coerceDateString, getTodayStr, intParam, isValidDate, notFound, pool, route, socialStore } = ctx;

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
    // Fail at MOUNT time, not request time. A capability with no role minimum is
    // not delegatable, and wiring one here would have authorized every signed-in
    // user against every owner rather than throwing.
    if (!capabilities.isDelegatable(capability)) {
      throw new Error(`requireGrant("${capability}") is not a role-gated capability`);
    }
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
        // canForOwner, not can(): the TIER axis must never answer a per-owner
        // question, or a capability that is also public (comment, react) would
        // admit everyone.
        if (!capabilities.canForOwner(capability, role)) {
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
    // NO buildDayResponse. The first cut called it and shipped the whole `state`
    // object, which was wrong twice over:
    //
    //  1. OVER-DISCLOSURE. That object is the owner's full day packet: triage
    //     (Gmail subjects, Slack DM content), the glymphatic brief, meetings,
    //     completions, watermarks. The capability gating this route is
    //     `view_itinerary`, whose minimum role is `viewer` -- described to the
    //     owner as "can see my day". A viewer was reading the owner's inbox.
    //  2. CROSS-TENANT LEAK. buildDayResponse falls back to
    //     readJSON(getDayFilePath(date)), and getDayFilePath has NO workspace
    //     segment -- server.js says so in a comment and calls it "latent today".
    //     This route is what would have made it non-latent: for an owner whose
    //     workspace has no dcc_state row (on prod that is every workspace but
    //     ws-1), a GRANTEE received whatever workspace last wrote that file,
    //     across a caller-controlled date range. Reproduced with a marker file
    //     before this fix.
    //
    // Nothing read `state`, so deleting it costs nothing and closes both.
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
      // foldsIntoItinerary, NOT isTaskRow: task-model.js says isTaskRow alone is
      // "far too wide -- side_project rows, sticky notes and untitled scaffolding
      // all pass the kind exclusions", and the itinerary this claims to mirror
      // uses the narrower one. Using the wide predicate reintroduced exactly the
      // drift this projection exists to prevent.
      .filter(row => TaskModel.foldsIntoItinerary(row))
      .map(row => {
        const props = row.properties || {};
        // deriveEnd: the legacy fallback reads a DURATION as a clock time, so a
        // row with start 09:00 and no end renders "09:00-00:30". Every render
        // surface that does not immediately recalc passes this; a read-only view
        // of someone else's day never recalcs.
        return Object.assign(TaskModel.fromBlock(row, { deriveEnd: true }), {
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
        // fromBlock defaults `start` to "00:00", so `a.start || "99:99"` never
        // took the sentinel and untimed tasks sorted FIRST, the opposite of the
        // intent. The `untimed` flag it derives is the real signal.
        const at = a.untimed ? "99:99" : (a.start || "99:99");
        const bt = b.untimed ? "99:99" : (b.start || "99:99");
        return at === bt ? String(a.title || "").localeCompare(String(b.title || "")) : at.localeCompare(bt);
      });

    return { date, role: req.grant.role, ownerUserId: req.grant.ownerUserId, tasks };
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
      throw badRequest("points must be a number between 0 and 100000");
    }
    const reason = String(body.reason || "").slice(0, 280);
    const adjustedAt = new Date().toISOString();

    // ONE TRANSACTION, and the SELECT takes the row lock the write will use.
    // The first cut read `properties` on the pool, then handed updateBlock a full
    // spread of that snapshot. updateBlock locks internally, but the snapshot
    // predates the lock, and preserveCompletionProps only re-preserves the nine
    // COMPLETION_PROP_KEYS -- so title, start, end, duration, notes and tags were
    // all replaced by the stale copy. If the owner renamed or rescheduled the task
    // while the coach's modal was open, their edit vanished with no conflict and
    // no error. Two actors writing one row is not an exotic race here; it is the
    // entire premise of delegated access.
    const client = await pool.connect();
    let block;
    let previous = 0;
    let updated;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, type, date, properties FROM blocks
          WHERE workspace_id=$1 AND deleted_at IS NULL
            AND (id=$2 OR properties->>'local_id'=$2)
          ORDER BY (id=$2) DESC, date DESC NULLS LAST
          LIMIT 1
          FOR UPDATE`,
        [req.grant.ownerWorkspaceId, String(req.params.taskId)]
      );
      block = rows[0];
      // Scoped to the owner's workspace in the query itself, so a coach cannot
      // reach a task id belonging to somebody else by guessing it. The ORDER BY
      // prefers an exact id match: local_id is NOT unique across days (a carryover
      // row shares it with its origin), so an unordered LIMIT 1 could adjust a
      // different day's copy.
      if (!block) throw notFound("Task not found");
      // The WRITE must be scoped like the READ. Without this a coach, whose only
      // granted power is adjust_points, could merge properties into a
      // schedule_block or a day_root by supplying its id -- rows this capability
      // says nothing about, which then get broadcast as changed.
      if (!TaskModel.foldsIntoItinerary(block)) throw notFound("Task not found");
      previous = Number((block.properties || {}).points) || 0;
      updated = await blockDB.updateBlock(block.id, {
        properties: {
          ...(block.properties || {}),
          points,
          // Provenance ON THE ROW as well as in the ledger: the itinerary renders
          // from properties, so this is what lets the UI show "adjusted by"
          // without a second read.
          pointsAdjustedBy: req.grant.viewerUserId,
          pointsAdjustedByRole: req.grant.role,
          pointsAdjustedAt: adjustedAt,
          pointsAdjustedFrom: previous,
          pointsAdjustedReason: reason
        }
      }, client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    void updated;

    // Ledger it. Non-fatal on failure, because losing the audit row is bad but
    // silently refusing the owner's coach a legitimate change is worse -- and the
    // provenance is also on the row above.
    try {
      await socialStore.recordEvent(pool, {
        ownerUserId: req.grant.ownerUserId,
        actorUserId: req.grant.viewerUserId,
        eventType: "points_adjusted",
        sourceType: "coach_adjustment",
        // Keyed on the TRANSITION and the instant, not the destination value. The
        // first cut used `${task}:${actor}:${points}`, which deduped a real change
        // back to a value already used: 50 -> 80 -> 50 recorded only two rows and
        // silently lost the third.
        sourceId: `${block.id}:${req.grant.viewerUserId}:${previous}->${points}:${adjustedAt}`,
        metadata: { from: previous, to: points, role: req.grant.role, reason, taskId: block.id }
      });
    } catch (e) {
      console.error("[access] point-adjustment ledger write failed (non-fatal):", e.message);
    }

    broadcast("blocks-changed", { action: "coach-points", blockIds: [block.id] }, req.grant.ownerWorkspaceId);
    return { taskId: block.id, points, previousPoints: previous, adjustedBy: req.grant.viewerUserId, role: req.grant.role };
  }));
};
