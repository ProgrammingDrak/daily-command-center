// routes/dcc.js — DCC ingest + glymphatic-brief spine.
// Extracted verbatim from server.js (2026-07-04). Mounted via the shared
// module.exports(app, ctx) pattern; every dependency comes from ctx.
module.exports = function mount(app, ctx) {
  const {
    DAY_STATE_FILE, DATA_DIR, addMinutesHHMM, blockDB, broadcast, buildSkeletonState,
    dccIntelligence, getDayFilePath, getTodayStr, isValidDate, meetingAutomation, meetingIdentity,
    meetingMaterializer, previousDateStr,
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
    // Materialize calendar meetings into durable task blocks BEFORE persisting
    // state, so the very next day read finds the real blocks and suppresses the
    // synthesized ghost. Best-effort: a materialization hiccup must never fail
    // the whole ingest (state save below is the load-bearing write).
    try {
      const mres = await meetingMaterializer.materializeMeetings({
        date: incoming.date,
        meetings: merged.meetings,
        userId: ingestUserId,
        workspaceId: ingestWorkspaceId,
        hasMeetingsKey: ("meetings" in incoming),
      });
      if (mres && (mres.created || mres.updated || mres.cancelled)) {
        broadcast("blocks-changed", { action: "meeting-materialize", blockIds: mres.blockIds || [], date: incoming.date }, ingestWorkspaceId);
      }
    } catch (e) {
      console.error("[dcc-state ingest] meeting materialize failed (non-fatal):", e.message);
    }
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

      // Idempotency check via a targeted lookup, not a whole-day load: match the
      // one key directly in Postgres (and skip the query entirely when there's
      // no key to check).
      const idemKey = body.idempotency_key || body.idempotencyKey || null;
      if (idemKey) {
        const dupQ = workspaceId
          ? await pool.query(`SELECT id, properties FROM blocks WHERE date = $1 AND workspace_id = $2 AND properties->>'idempotency_key' = $3 AND deleted_at IS NULL LIMIT 1`, [date, workspaceId, idemKey])
          : await pool.query(`SELECT id, properties FROM blocks WHERE date = $1 AND properties->>'idempotency_key' = $2 AND deleted_at IS NULL LIMIT 1`, [date, idemKey]);
        const dup = dupQ.rows[0];
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
      const created = await blockDB.createItineraryTask({ date, properties: props, userId, workspaceId, score: true });
      broadcast("blocks-changed", { action: "quick-task-create", blockIds: [created.id], date }, workspaceId);
      res.json({ ok: true, date, status: "created", block: { id: created.id, title, start: props.start || null, end: props.end || null, priority: props.priority } });
    } catch (e) {
      console.error("[quick-task] failed:", e);
      res.status(e.status || 500).json({ error: e.message || "quick-task failed" });
    }
  });

  // Resolve the durable meeting block an artifact payload targets. The
  // materializer stores properties.source_id = meetingIdentity(m), so we match on
  // that first, then fall back to an exact same-day title match. We scan the given
  // date and its neighbours because the sweep's ET-local day can sit one side of a
  // UTC boundary from the block's stored date.
  function meetingDateWindow(date) {
    const out = [date];
    const anchor = new Date(`${date}T12:00:00Z`);
    if (!Number.isNaN(anchor.getTime())) {
      out.push(new Date(anchor.getTime() - 86400000).toISOString().slice(0, 10));
      out.push(new Date(anchor.getTime() + 86400000).toISOString().slice(0, 10));
    }
    return [...new Set(out)];
  }
  async function resolveMeetingBlock({ identity, title, date, workspaceId }) {
    const isMeeting = (b) => { const p = b.properties || {}; return p.type === "meeting" || p.type === "oneone"; };
    const norm = (s) => String(s || "").trim().toLowerCase();
    const wantId = String(identity || "").trim();
    let titleMatch = null;
    for (const d of meetingDateWindow(date)) {
      let blocks = [];
      try { blocks = await blockDB.getBlocksByDate(d, workspaceId); } catch { continue; }
      const meetings = blocks.filter(isMeeting);
      if (wantId) {
        const hit = meetings.find((b) => String((b.properties || {}).source_id || "") === wantId);
        if (hit) return hit;
      }
      if (!titleMatch && title) titleMatch = meetings.find((b) => norm((b.properties || {}).title) === norm(title)) || null;
    }
    return titleMatch;
  }

  // Bearer-authorized meeting-artifact write. The review-meetings sweep skill has
  // already produced the real summary / prep / action items (via the
  // meeting-transcript-review engine) and POSTs them here to attach to a durable
  // meeting block. The automation route (routes/meeting.js) is session-only, so
  // this is how the scheduled sweep reaches a meeting without a login. Idempotent:
  // applyArtifacts upserts docs in place and dedupes proposed actions by text.
  app.post("/api/dcc/meeting-artifacts", async (req, res) => {
    try {
      const body = req.body || {};
      const m = body.meeting || {};
      const identity = meetingIdentity(m);
      const title = m.title || m.summary || "";
      if (!identity && !title) return res.status(400).json({ error: "meeting must carry source_id/event_id/gcal_event_id/id or title" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const date = isValidDate(m.date) ? m.date : getTodayStr();

      const block = await resolveMeetingBlock({ identity, title, date, workspaceId });
      if (!block) return res.status(404).json({ error: "No materialized meeting block found", identity: identity || null, title: title || null, date });

      const proposedActions = Array.isArray(body.proposed_actions) ? body.proposed_actions
        : (Array.isArray(body.proposedActions) ? body.proposedActions : []);
      const result = await meetingAutomation.applyArtifacts(block.id, {
        userId, workspaceId,
        prep: body.prep || null,
        summary: body.summary || null,
        transcript: body.transcript || null,
        proposedActions,
        recapToNotes: body.recap_to_notes !== false,
      });
      broadcast("blocks-changed", { action: "meeting-artifacts", blockIds: [block.id], date: block.date }, workspaceId);
      res.json({
        ok: true,
        meetingBlockId: block.id,
        date: block.date,
        applied: result.applied,
        proposedActionCount: Array.isArray(result.proposedActions) ? result.proposedActions.length : 0,
      });
    } catch (e) {
      console.error("[meeting-artifacts] failed:", e);
      res.status(e.status || e.statusCode || 500).json({ error: e.message || "meeting-artifacts failed" });
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
        // Ensure the root once, then create every planned block in a single
        // transaction so a mid-batch failure leaves no half-materialized day.
        await blockDB.ensureDayRoot(targetDate, userId, workspaceId);
        const client = await blockDB.pool.connect();
        try {
          await client.query("BEGIN");
          for (const item of plan.items) {
            created.push(await blockDB.createItineraryTask({ date: targetDate, properties: item.properties, userId, workspaceId, ensureRoot: false, client }));
          }
          await client.query("COMMIT");
        } catch (txErr) {
          await client.query("ROLLBACK");
          throw txErr;
        } finally {
          client.release();
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
