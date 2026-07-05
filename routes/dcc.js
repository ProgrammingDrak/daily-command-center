// routes/dcc.js — DCC ingest + glymphatic-brief spine.
// Extracted verbatim from server.js (2026-07-04). Mounted via the shared
// module.exports(app, ctx) pattern; every dependency comes from ctx.
module.exports = function mount(app, ctx) {
  const {
    DAY_STATE_FILE, DATA_DIR, blockDB, broadcast, buildSkeletonState,
    dccIntelligence, getDayFilePath, getTodayStr, isValidDate, previousDateStr,
    pool, readJSON, resolveOwnerLenient, resolveOwnerStrict, writeJSON,
  } = ctx;

  app.post("/api/ingest/day-state", async (req, res) => {
    const incoming = req.body; if (!incoming || !incoming.date) return res.status(400).json({ error: "Missing date" });
    const dayFile = getDayFilePath(incoming.date); const existing = readJSON(dayFile, null) || readJSON(DAY_STATE_FILE, {});
    const DCC_SECTIONS = ["schedule", "triage", "watermarks", "notifications", "assessment", "sweep", "sweep_stats", "glymphatic_brief", "meta", "report_card", "orchestrator", "mutations", "completions", "personal", "meetings"];
    const USER_SECTIONS = ["done", "pushed", "deleted", "durChanges", "notes", "actions", "sessions", "mood", "reviewed", "subtasks"];
    const merged = { ...existing };
    for (const key of DCC_SECTIONS) { if (key in incoming) merged[key] = incoming[key]; }
    for (const key of USER_SECTIONS) { if (key in existing && !(key in incoming)) merged[key] = existing[key]; if (key in incoming && !(key in existing)) merged[key] = incoming[key]; }
    merged.date = incoming.date; merged.last_updated_at = new Date().toISOString(); merged.last_updated_by = incoming.last_updated_by || "scheduled-task";
    delete merged.meetings_tomorrow;
    const { userId: ingestUserId, workspaceId: ingestWorkspaceId } = resolveOwnerLenient(req);
    // Postgres is the durable store (Railway's filesystem is ephemeral) -- its
    // write must succeed or the caller must hear about it. The old shape wrote
    // the JSON unguarded and swallowed a DB failure into console.error while
    // returning ok:true, which is how file and DB silently diverged.
    try {
      await blockDB.saveDccState(incoming.date, merged, ingestUserId, ingestWorkspaceId);
    } catch (e) {
      console.error("[dcc-state ingest] db save FAILED:", e.message);
      return res.status(500).json({ ok: false, error: "db save failed: " + e.message });
    }
    // JSON day files are the best-effort local mirror (offline record, fast reads).
    try {
      writeJSON(dayFile, merged);
      writeJSON(DAY_STATE_FILE, { ...merged, meetings: incoming.meetings || merged.meetings || [] });
    } catch (e) {
      console.error("[dcc-state ingest] file mirror failed (db save succeeded):", e.message);
    }
    broadcast("dcc-state-changed", { source: "day-state", date: incoming.date }, ingestWorkspaceId);
    res.json({ ok: true, date: incoming.date });
  });

  // Additive single-task drop for token-only clients (no password session).
  // /api/blocks needs a session cookie or a sweep-scoped token, and day-state ingest
  // full-replaces the schedule section — neither lets a dcc-scoped token add ONE task
  // safely. This creates exactly one itinerary block (idempotent on idempotency_key)
  // using the same helpers as the brief materializer, leaving the rest of the day intact.
  app.post("/api/dcc/quick-task", async (req, res) => {
    try {
      const body = req.body || {};
      const title = String(body.title || "").trim();
      if (!title) return res.status(400).json({ error: "Missing title" });
      const date = isValidDate(body.date) ? body.date : getTodayStr();
      const { userId, workspaceId } = await resolveOwnerStrict(req);

      const idemKey = body.idempotency_key || body.idempotencyKey || null;
      const existingBlocks = await blockDB.getBlocksByDate(date, workspaceId);
      if (idemKey) {
        const dup = existingBlocks.find((b) => ((b.properties || {}).idempotency_key) === idemKey);
        if (dup) return res.json({ ok: true, date, status: "skipped_duplicate", block: { id: dup.id, title: (dup.properties || {}).title || title } });
      }

      const minutes = Math.max(1, Math.round(Number(body.minutes || body.durationMinutes || body.estimatedMinutes || body.duration || 30)));
      const start = (typeof body.start === "string" && /^\d{2}:\d{2}$/.test(body.start)) ? body.start : null;
      const props = {
        title,
        status: body.status || "open",
        kind: body.kind || "task",
        estimatedMinutes: minutes,
        priority: body.priority ? String(body.priority) : "Medium",
        source: body.source || "quick-task",
        created_by: body.created_by || "quick-task",
        created_at: new Date().toISOString(),
      };
      if (start) { props.start = start; props.end = addMinutesHHMM(start, minutes); }
      if (idemKey) props.idempotency_key = idemKey;
      if (body.source_id) props.source_id = body.source_id;
      if (body.notes) props.notes = body.notes;
      if (body.type) props.type = body.type;
      if (body.point_tier) props.point_tier = body.point_tier;
      if (body.point_multiplier != null) props.point_multiplier = body.point_multiplier;
      try {
        const scored = scoreTaskPoints({ ...props, durationMinutes: minutes });
        props.points = scored.awardPoints;
        props.pointsBreakdown = scored;
      } catch (scoreErr) { console.error("[quick-task] scoring failed (non-fatal):", scoreErr.message); }

      await blockDB.ensureDayRoot(date, userId, workspaceId);
      const sortOrder = start ? Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) : 0;
      const created = await blockDB.createBlock({ type: "block", date, properties: props, sort_order: sortOrder, user_id: userId, workspace_id: workspaceId });
      broadcast("blocks-changed", { action: "quick-task-create", blockIds: [created.id], date }, workspaceId);
      res.json({ ok: true, date, status: "created", block: { id: created.id, title, start: props.start || null, end: props.end || null, priority: props.priority } });
    } catch (e) {
      console.error("[quick-task] failed:", e);
      res.status(e.status || 500).json({ error: e.message || "quick-task failed" });
    }
  });

  // ── Glymphatic Brief spine (Second Brain Loop M1) ──
  // /api/dcc/refresh and /api/dcc/deep-sweep/ingest are allow-listed in
  // DCC_ENDPOINTS; until now they had no implementation, which is why the Brief
  // tab's refresh button was a dead end.
  async function persistDccDay(date, merged, req, source) {
    // Same honesty contract as /api/ingest/day-state: the Postgres write is the
    // durable one and THROWS on failure (callers' try/catch turns that into a
    // 500 instead of the old silent console.error + ok:true). JSON mirror is
    // best-effort.
    const { userId, workspaceId } = resolveOwnerLenient(req);
    await blockDB.saveDccState(date, merged, userId, workspaceId);
    try {
      writeJSON(getDayFilePath(date), merged);
      writeJSON(DAY_STATE_FILE, merged);
    } catch (e) {
      console.error(`[${source}] file mirror failed (db save succeeded):`, e.message);
    }
    broadcast("dcc-state-changed", { source, date }, workspaceId);
  }

  app.post("/api/dcc/deep-sweep/ingest", async (req, res) => {
    try {
      const body = req.body || {};
      const date = body.date || (body.packet && body.packet.date) || new Date().toISOString().slice(0, 10);
      const existing = readJSON(getDayFilePath(date), null) || readJSON(DAY_STATE_FILE, null) || buildSkeletonState(date);
      const nextState = dccIntelligence.ingestDeepSweepPacket({ date, state: existing, packet: body.packet || body, source: body.source });
      await persistDccDay(date, nextState, req, "deep-sweep-ingest");
      res.json({ ok: true, date, packet_id: nextState.deep_sweep.last_packet_id, pages: (nextState.glymphatic_brief?.current?.pages || []).length });
    } catch (e) {
      console.error("[deep-sweep ingest] failed:", e);
      res.status(500).json({ error: e.message || "deep-sweep ingest failed" });
    }
  });

  app.post("/api/dcc/triage-check/ingest", async (req, res) => {
    try {
      const body = req.body || {};
      const date = body.date || (body.packet && body.packet.date) || getTodayStr();
      const existing = readJSON(getDayFilePath(date), null) || readJSON(DAY_STATE_FILE, null) || buildSkeletonState(date);
      const nextState = dccIntelligence.ingestTriageCheckPacket({ date, state: existing, packet: body.packet || body });
      await persistDccDay(date, nextState, req, "triage-check-ingest");
      const last = nextState.sweep?.last_triage_check || {};
      res.json({ ok: true, date, packet_id: last.id || null, attention_items: last.attention_items || 0, open_items: nextState.triage?.open_items?.length || 0 });
    } catch (e) {
      console.error("[triage-check ingest] failed:", e);
      res.status(500).json({ error: e.message || "triage-check ingest failed" });
    }
  });

  // Records front-page brief decisions (accept / schedule / backlog / drop) as
  // durable day-state data. This is the seed of M2 actuals: every reviewed task
  // has a decision record even before outcome controls land. Morning scheduling
  // reads decisions to build the next day's itinerary.
  app.post("/api/dcc/brief/decision", async (req, res) => {
    try {
      const { date, task_id, action, time } = req.body || {};
      const VALID = new Set(["accept", "schedule", "backlog", "drop", "reset"]);
      if (!task_id || !VALID.has(action)) return res.status(400).json({ error: "Expected { task_id, action: accept|schedule|backlog|drop|reset }" });
      const day = date || new Date().toISOString().slice(0, 10);
      const state = readJSON(getDayFilePath(day), null) || readJSON(DAY_STATE_FILE, null) || buildSkeletonState(day);
      const brief = state.glymphatic_brief || (state.glymphatic_brief = { history: [], current: null });
      const decisions = brief.decisions || (brief.decisions = {});
      const at = new Date().toISOString();
      if (action === "reset") delete decisions[task_id];
      else decisions[task_id] = { action, time: time || null, decided_at: at };
      brief.decision_log = [...(brief.decision_log || []), { task_id, action, time: time || null, at }].slice(-200);
      state.last_updated_at = at;
      state.last_updated_by = "brief-decision";
      await persistDccDay(day, state, req, "brief-decision");
      res.json({ ok: true, date: day, task_id, action });
    } catch (e) {
      console.error("[brief decision] failed:", e);
      res.status(500).json({ error: e.message || "decision save failed" });
    }
  });


  app.post("/api/dcc/brief/materialize", async (req, res) => {
    try {
      const body = req.body || {};
      const targetDate = body.targetDate || body.target_date || getTodayStr();
      const sourceDate = body.sourceDate || body.source_date || previousDateStr(targetDate);
      const dryRun = body.dryRun !== false && body.dry_run !== false;
      if (!isValidDate(sourceDate) || !isValidDate(targetDate)) return res.status(400).json({ error: "Expected sourceDate and targetDate as YYYY-MM-DD" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const sourceState = readJSON(getDayFilePath(sourceDate), null) || readJSON(DAY_STATE_FILE, null) || buildSkeletonState(sourceDate);
      const existingBlocks = await blockDB.getBlocksByDate(targetDate, workspaceId);
      const plan = dccIntelligence.materializeBriefPlan({ sourceState, targetDate, existingBlocks });
      const created = [];
      if (!dryRun) {
        await blockDB.ensureDayRoot(targetDate, userId, workspaceId);
        for (const item of plan.items) {
          const props = item.properties;
          const sortOrder = props.start ? Number(props.start.slice(0, 2)) * 60 + Number(props.start.slice(3, 5)) : 0;
          created.push(await blockDB.createBlock({ type: "block", date: targetDate, properties: props, sort_order: sortOrder, user_id: userId, workspace_id: workspaceId }));
        }
        if (created.length) broadcast("blocks-changed", { action: "brief-materialize", blockIds: created.map((b) => b.id), date: targetDate }, workspaceId);
      }
      const counts = { ...plan.counts, created: created.length, pending: dryRun ? plan.items.length : Math.max(0, plan.items.length - created.length) };
      res.json({
        ok: true,
        dryRun,
        sourceDate,
        targetDate,
        counts,
        created: created.map((b) => ({ id: b.id, title: b.properties.title, start: b.properties.start, status: b.properties.status })),
        unreviewed: plan.unreviewed.map((task) => ({ id: task.id, title: task.title })),
        skipped: plan.skipped.map(({ task, decision }) => ({ id: task.id, title: task.title, action: decision.action })),
        alreadyExisting: plan.alreadyExisting.map(({ task }) => ({ id: task.id, title: task.title })),
      });
    } catch (e) {
      console.error("[brief materialize] failed:", e);
      res.status(e.status || 500).json({ error: e.message || "brief materialize failed" });
    }
  });

  app.post("/api/dcc/refresh", async (req, res) => {
    try {
      const date = (req.body && req.body.date) || readJSON(DAY_STATE_FILE, {}).date || new Date().toISOString().slice(0, 10);
      const existing = readJSON(getDayFilePath(date), null) || readJSON(DAY_STATE_FILE, null) || buildSkeletonState(date);
      const { state: nextState } = await dccIntelligence.refreshDccState({ date, state: existing, dataDir: DATA_DIR });
      await persistDccDay(date, nextState, req, "dcc-refresh");
      res.json({ ok: true, date, state: nextState });
    } catch (e) {
      console.error("[dcc refresh] failed:", e);
      res.status(500).json({ error: e.message || "DCC refresh failed" });
    }
  });
};
