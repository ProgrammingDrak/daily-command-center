// routes/dcc.js — DCC ingest + glymphatic-brief spine.
// Extracted verbatim from server.js (2026-07-04). Mounted via the shared
// module.exports(app, ctx) pattern; every dependency comes from ctx.
const createMaterializeGuard = require("../lib/materialize-guard");
// Pure helpers come off the module, persistence comes off the factory — the layering
// lib/task-timing.js and responsibility-store.js both state in their headers.
const { assertNotResurrecting, dedupeStatus } = createMaterializeGuard;

module.exports = function mount(app, ctx) {
  const {
    DAY_STATE_FILE, DATA_DIR, addMinutesHHMM, blockDB, broadcast, buildSkeletonState,
    dccIntelligence, getDayFilePath, getTodayStr, isValidDate, meetingAutomation, meetingIdentity,
    meetingMaterializer, previousDateStr,
    readJSON, resolveOwnerLenient, resolveOwnerStrict, slotStore, writeJSON,
  } = ctx;
  const materializeGuard = createMaterializeGuard({ blockDB });

  // Shared idempotency lookup for the brief's Day-in-Review writes and quick-task:
  // does a block carrying this idempotency_key already exist? Returns the row (live
  // OR tombstoned) or null; callers branch on deleted_at via dedupeStatus.
  //
  // Was a hand-rolled pool.query here, the third copy of a lookup db.js already owns.
  // Folding it into the shared guard changed two things on purpose, both documented at
  // lib/materialize-guard.js: the match is no longer scoped to a single DATE, and a
  // null workspaceId now matches only null-workspace rows instead of every tenant.
  function findBriefBlock(workspaceId, idemKey) {
    if (!idemKey) return null;
    return materializeGuard.findForDedupe(workspaceId, { idempotencyKey: idemKey });
  }

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
    //
    // GATED on the request actually carrying a meetings section. `merged.meetings`
    // falls back to the STORED meetings when `incoming` has no such key, so an ingest
    // about something else entirely was re-running a full create/reconcile pass over
    // day-old calendar data. public/js/triage.js POSTs the whole client `__state`, so
    // deleting a triage item did exactly that. The materializer already took
    // hasMeetingsKey and used it to suppress cancellation; the create/reconcile half
    // ran regardless. Nothing here is the calendar's source of truth — the sweep that
    // owns meetings always sends the key — so skipping is a no-op for every caller
    // that has real data, and the difference between "no meetings key" and "meetings:
    // []" stays meaningful (an explicit empty list still cancels).
    const hasMeetingsKey = Object.prototype.hasOwnProperty.call(incoming, "meetings");
    if (hasMeetingsKey) {
      try {
        const mres = await meetingMaterializer.materializeMeetings({
          date: incoming.date,
          meetings: merged.meetings,
          userId: ingestUserId,
          workspaceId: ingestWorkspaceId,
          hasMeetingsKey: true,
        });
        if (mres && (mres.created || mres.updated || mres.cancelled)) {
          broadcast("blocks-changed", { action: "meeting-materialize", blockIds: mres.blockIds || [], date: incoming.date }, ingestWorkspaceId);
        }
      } catch (e) {
        console.error("[dcc-state ingest] meeting materialize failed (non-fatal):", e.message);
      }
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
        // Reuse findBriefBlock so the tombstone-inclusive dedup lives in ONE place
        // (the two brief endpoints already use it). A live match is a dup; a
        // soft-deleted match is a tombstone -> respect the user's delete and do not
        // re-create (mirrors meeting-materializer: never resurrect what was removed).
        const dup = await findBriefBlock(workspaceId, idemKey);
        if (dup) return res.json({ ok: true, date, status: dedupeStatus(dup), block: { id: dup.id, title: (dup.properties || {}).title || title } });
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
        dashboardRef: body.dashboard_ref || null,
      });
      // recapArrived (true only on a recap's first landing) lets the client toast
      // "Recap ready" once, so Drake knows to open it even after he's moved on.
      broadcast("blocks-changed", {
        action: "meeting-artifacts", blockIds: [block.id], date: block.date,
        recapArrived: !!(result.applied && result.applied.recapReady),
        meetingTitle: (block.properties || {}).title || "",
      }, workspaceId);
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
      const VALID = new Set(["accept", "schedule", "backlog", "drop", "dismiss", "reset"]);
      if (!task_id || !VALID.has(action)) return res.status(400).json({ error: "Expected { task_id, action: accept|schedule|backlog|drop|dismiss|reset }" });
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

  // Day-in-Review "Approve": Drake confirms an inferred did-item ("yeah I did
  // that"), and it lands on the itinerary as an ALREADY-COMPLETED task that banks
  // slot points. Session-scoped on purpose (NOT in DCC_ENDPOINTS) so it runs as
  // the logged-in user — slot credit keys off req.session identity. Composes the
  // three primitives the app already has (create block, mark done, credit points)
  // the way dcc_task_ops --complete does, but server-side. Idempotent on
  // idempotency_key (block) and on `<date>:<block_id>` (points ledger), so a
  // re-approve or a re-published brief neither duplicates the task nor double-pays.
  app.post("/api/dcc/brief/log-done", async (req, res) => {
    try {
      const body = req.body || {};
      const title = String(body.title || "").trim();
      if (!title) return res.status(400).json({ error: "Missing title" });
      const date = isValidDate(body.date) ? body.date : getTodayStr();
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const idemKey = body.idempotency_key || body.idempotencyKey || null;
      const minutes = Math.max(1, Math.round(Number(body.minutes || body.duration || body.durationMinutes || body.estimatedMinutes || 30)));
      const start = (typeof body.start === "string" && /^\d{2}:\d{2}$/.test(body.start)) ? body.start : null;
      const tags = Array.isArray(body.tags) ? body.tags : [];
      const nowIso = new Date().toISOString();

      const existing = await findBriefBlock(workspaceId, idemKey);
      // A tombstoned match stops here, BEFORE the credit below. Previously a deleted
      // match fell through as a plain duplicate and still ran earnTaskCredit against
      // the dead row's id: harmless when the task was credited before it was deleted
      // (ON CONFLICT absorbs the repeat), but real points for a task the user removed
      // when it was not. Returning the row id keeps the caller idempotent either way.
      if (assertNotResurrecting(existing).skip) {
        return res.json({ ok: true, date, status: dedupeStatus(existing), block: { id: existing.id, title }, credit: null });
      }
      let blockId, duplicate = false;
      // effectiveDate follows the ROW, not the request. The lookup above is date-blind
      // now, so a live match can live on a different date than the one being posted, and
      // when it does the row's own day is the authoritative one for EVERY consumer below:
      //   - the ledger key is `<date>:<blockId>`, so the request date would mint a SECOND
      //     credit row for a block already credited under its own date — a silent
      //     double-credit of exactly the kind this project has spent two phases unpicking
      //   - the broadcast tells open tabs which day to reconcile; naming the posted day
      //     leaves the completed row invisible until someone navigates to its real day
      //   - the response tells the caller where the item landed, which it uses to build
      //     its next request
      // Applying this to the ledger alone would be worse than not applying it at all: the
      // next reader would reasonably assume the row's date won everywhere. Inert today
      // (`day-review:<date>:` keys embed the date, and it equals `date` on the create
      // path), and live the moment a date-blind key vocabulary is pointed here.
      // An undated row falls back to the request date rather than keying `null:<id>`.
      let effectiveDate = date;
      if (existing) {
        blockId = existing.id;
        duplicate = true;
        if (existing.date) effectiveDate = existing.date;
      } else {
        const props = {
          title,
          status: "done", done: true, completed: true,
          kind: body.kind || "task", type: body.type || "task",
          estimatedMinutes: minutes, durationMinutes: minutes,
          priority: body.priority ? String(body.priority) : "Medium",
          tags,
          source: body.source || "day-review",
          created_by: body.created_by || "day-review",
          created_at: nowIso, completedAt: nowIso, doneAt: nowIso, completedBy: "day-review",
        };
        if (start) { props.start = start; props.end = addMinutesHHMM(start, minutes); }
        if (idemKey) props.idempotency_key = idemKey;
        if (body.notes) props.notes = body.notes;
        if (Array.isArray(body.evidence)) props.evidence = body.evidence;
        const created = await blockDB.createItineraryTask({ date, properties: props, userId, workspaceId, score: true });
        blockId = created.id;
      }

      // Credit is idempotent on source_key; it also mirrors the key the in-app
      // reconcile uses, so an approve here and a later reconcile dedupe.
      let credit = null;
      try {
        credit = await slotStore.earnTaskCredit(workspaceId, userId, {
          source_key: `${effectiveDate}:${blockId}`,
          task_id: blockId, title, type: body.type || "task", tags,
          duration_minutes: minutes, completed_at: nowIso,
        });
      } catch (e) {
        console.error("[brief log-done] credit failed (non-fatal):", e.message);
      }

      broadcast("blocks-changed", { action: "brief-log-done", blockIds: [blockId], date: effectiveDate }, workspaceId);
      res.json({
        ok: true, date: effectiveDate,
        status: duplicate ? "skipped_duplicate" : "created",
        block: { id: blockId, title },
        credit: credit ? { awarded: !!credit.awarded, credits: credit.credits || 0 } : null,
      });
    } catch (e) {
      console.error("[brief log-done] failed:", e);
      res.status(e.status || 500).json({ error: e.message || "log-done failed" });
    }
  });

  // Day-in-Review "Push to tomorrow": an undone follow-up surfaced next to a
  // did-item becomes a fresh OPEN task on a future date (default tomorrow).
  // Session-scoped and tag-preserving (goes through the /api/blocks path, unlike
  // quick-task which drops tags). Idempotent on idempotency_key.
  app.post("/api/dcc/brief/push-next", async (req, res) => {
    try {
      const body = req.body || {};
      const title = String(body.title || "").trim();
      if (!title) return res.status(400).json({ error: "Missing title" });
      // Default target is tomorrow (the "push it to the next day" case); callers
      // normally pass an explicit date.
      const tomorrowStr = new Date(new Date(`${getTodayStr()}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
      const date = isValidDate(body.date) ? body.date : tomorrowStr;
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const idemKey = body.idempotency_key || body.idempotencyKey || null;

      const existing = await findBriefBlock(workspaceId, idemKey);
      // Was a flat "skipped_duplicate" for both cases; a tombstone now says so, which
      // is the difference between "you already pushed this" and "you deleted this".
      if (existing) return res.json({ ok: true, date, status: dedupeStatus(existing), block: { id: existing.id, title } });

      const minutes = Math.max(1, Math.round(Number(body.minutes || body.duration || body.durationMinutes || body.estimatedMinutes || 30)));
      const props = {
        title, status: "open",
        kind: body.kind || "task", type: body.type || "task",
        estimatedMinutes: minutes, durationMinutes: minutes,
        priority: body.priority ? String(body.priority) : "Medium",
        tags: Array.isArray(body.tags) ? body.tags : [],
        source: body.source || "day-review-followup", created_by: "day-review",
        created_at: new Date().toISOString(),
      };
      if (idemKey) props.idempotency_key = idemKey;
      if (body.notes) props.notes = body.notes;
      const created = await blockDB.createItineraryTask({ date, properties: props, userId, workspaceId, score: true });
      broadcast("blocks-changed", { action: "brief-push-next", blockIds: [created.id], date }, workspaceId);
      res.json({ ok: true, date, status: "created", block: { id: created.id, title } });
    } catch (e) {
      console.error("[brief push-next] failed:", e);
      res.status(e.status || 500).json({ error: e.message || "push-next failed" });
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
      // Include soft-deleted rows so a brief task the user deleted is not
      // re-materialized: materializeBriefPlan keys dedup on glymphatic_task_id /
      // source_id, and a tombstone still carries those (mirrors meeting-materializer).
      const existingBlocks = await blockDB.getBlocksByDateIncludingDeleted(targetDate, workspaceId);
      const plan = dccIntelligence.materializeBriefPlan({ sourceState, targetDate, existingBlocks });
      const created = [];
      if (!dryRun) {
        // Store-level batch: every planned block is created in one transaction
        // (the day root ensured once), so a mid-batch failure leaves no
        // half-materialized day. Transaction lifecycle lives in db.js, not here.
        const rows = await blockDB.createItineraryTasks(
          plan.items.map((item) => ({ date: targetDate, properties: item.properties })),
          { userId, workspaceId }
        );
        created.push(...rows);
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
