// routes/dcc.js — DCC ingest + glymphatic-brief spine.
// Extracted verbatim from server.js (2026-07-04). Mounted via the shared
// module.exports(app, ctx) pattern; every dependency comes from ctx.
const createMaterializeGuard = require("../lib/materialize-guard");
// Pure helpers come off the module, persistence comes off the factory — the layering
// lib/task-timing.js and responsibility-store.js both state in their headers.
const { assertNotResurrecting, dedupeStatus } = createMaterializeGuard;
const triageSuppressions = require("../triage-suppressions");

module.exports = function mount(app, ctx) {
  const {
    DAY_STATE_FILE, DATA_DIR, addMinutesHHMM, blockDB, broadcast, buildSkeletonState,
    dccIntelligence, getDayFilePath, getTodayStr, isValidDate, meetingAutomation, meetingIdentity,
    readDayStateMirror,
    meetingMaterializer, previousDateStr,
    readJSON, readTriageSuppressionsForWorkspace, resolveOwnerLenient, resolveOwnerStrict, slotStore, writeJSON,
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

  // ── Triage suppressions ──
  // Dateless rows, so "I handled this" outlives the day you handled it on, and
  // outlives the sweep's next full-replace of the triage section. See
  // triage-suppressions.js for why neither the day_root nor the day state can hold it.
  //
  // The READER is server.js's, handed over through ctx, and is deliberately not a copy.
  // This file already carries the lesson: readDayStateMirror is shared the same way,
  // and the comment on it records that the hand-copy it replaced drifted and fed a
  // full-replace under the wrong day. There is no GET route either -- the client reads
  // suppressions off `__state.triage.suppressed_items` on the day response, so a second
  // endpoint serving the same data would be one more thing to keep in agreement.

  app.post("/api/triage/suppressions", async (req, res) => {
    const body = req.body || {};
    const triageId = String(body.triage_id || body.id || "").trim();
    // The composite key is what mergeOpenItems dedupes on; the bare id is the
    // client's handle. Either alone is enough to match, but a row with neither
    // would suppress nothing, so refuse it rather than store a no-op.
    const key = String(body.key || "").trim();
    if (!triageId && !key) return res.status(400).json({ error: "Missing triage id" });
    const { userId, workspaceId } = resolveOwnerLenient(req);
    try {
      // Idempotent: handling the same item twice (two tabs, a retry, an undo then
      // a redo) must leave exactly one row, or Undo would have to delete N of them.
      const existing = await readTriageSuppressionsForWorkspace(workspaceId);
      const already = existing.find((s) => (triageId && s.triage_id === triageId) || (key && s.key === key));
      if (already) return res.json({ ok: true, suppression: already, created: false });
      const block = await blockDB.createBlock({
        type: "block",
        properties: triageSuppressions.buildSuppressionProperties({
          triageId,
          key,
          itemTitle: body.title || "",
          reason: body.reason,
          note: body.note,
          trivial: body.trivial,
        }),
        user_id: userId || null,
        workspace_id: workspaceId || null,
      });
      broadcast("dcc-state-changed", { source: "triage-suppression", action: "add" }, workspaceId);
      res.json({ ok: true, suppression: triageSuppressions.suppressionFromBlock(block), created: true });
    } catch (e) {
      console.error("[triage suppressions] create failed:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Undo. Keyed by triage id (what every client caller has) and deleting EVERY
  // match rather than the first — a pre-idempotency row and a new one can coexist
  // on prod, and leaving one behind would look like the undo silently failed.
  app.delete("/api/triage/suppressions/:triageId", async (req, res) => {
    const triageId = String(req.params.triageId || "").trim();
    if (!triageId) return res.status(400).json({ error: "Missing triage id" });
    const { workspaceId } = resolveOwnerLenient(req);
    try {
      const existing = await readTriageSuppressionsForWorkspace(workspaceId);
      const matches = existing.filter((s) => s.triage_id === triageId || s.key === triageId);
      for (const match of matches) {
        if (match.block_id) await blockDB.deleteBlock(match.block_id);
      }
      broadcast("dcc-state-changed", { source: "triage-suppression", action: "remove" }, workspaceId);
      res.json({ ok: true, removed: matches.length });
    } catch (e) {
      console.error("[triage suppressions] delete failed:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/ingest/day-state", async (req, res) => {
    const incoming = req.body; if (!incoming || !incoming.date) return res.status(400).json({ error: "Missing date" });
    // C5: getDayFilePath THROWS on a non-ISO date now (it used to build a junk path), and
    // this handler is `async` with no enclosing try. Express 4 does not observe a rejected
    // promise from a handler and this repo registers no unhandledRejection hook, so on
    // Node >=20 that throw would EXIT THE PROCESS rather than 500. The realistic trigger is
    // not an attacker but a publisher sending a serialized Date ("2026-08-03T04:00:00.000Z")
    // where a date was expected. Shape-check before building the path.
    if (!isValidDate(incoming.date)) return res.status(400).json({ error: "Invalid date" });
    const dayFile = getDayFilePath(incoming.date);
    // Empty-object fallback, not a skeleton: this handler MERGES named sections over
    // `existing`, so an absent day must contribute no sections rather than a full skeleton's
    // worth of empty ones.
    //
    // WRAPPED, and for exactly the reason the paragraph above warns about `getDayFilePath`:
    // `readDccDayState` THROWS on an unreadable day (rather than handing back a base that
    // would be full-replaced over the real row), this handler is `async` with NO enclosing
    // try, Express 4 does not observe a rejected promise, and this repo registers no
    // `unhandledRejection` hook — so on Node >= 20 that throw would EXIT THE PROCESS instead
    // of answering 503. Five of the six callers already sit inside a handler-level try; this
    // was the one that did not. The trigger is mundane: a redeploy wipes
    // `data/state/days/`, so a scheduled publisher POSTing during a brief DB blip lands on a
    // date with no per-date mirror.
    let existing;
    try {
      existing = await readDccDayState(incoming.date, req, {});
    } catch (e) {
      console.error("[dcc-state ingest] day-state read failed:", e.message);
      return res.status(503).json({ ok: false, error: e.message });
    }
    const DCC_SECTIONS = ["schedule", "triage", "watermarks", "notifications", "assessment", "sweep", "sweep_stats", "glymphatic_brief", "meta", "report_card", "orchestrator", "mutations", "completions", "personal", "meetings"];
    // "pushed" is LEGACY as of C3 (the pushed subsystem is deleted; a push is a real move
    // now). Nothing writes the section any more, so it is only here to preserve what old
    // day files already carry rather than drop it on the next ingest.
    const USER_SECTIONS = ["done", "pushed", "deleted", "durChanges", "notes", "actions", "sessions", "mood", "reviewed", "subtasks"];
    const merged = { ...existing };
    for (const key of DCC_SECTIONS) { if (key in incoming) merged[key] = incoming[key]; }
    for (const key of USER_SECTIONS) { if (key in existing && !(key in incoming)) merged[key] = existing[key]; if (key in incoming && !(key in existing)) merged[key] = incoming[key]; }
    merged.date = incoming.date; merged.last_updated_at = new Date().toISOString(); merged.last_updated_by = incoming.last_updated_by || "scheduled-task";
    delete merged.meetings_tomorrow;
    const { userId: ingestUserId, workspaceId: ingestWorkspaceId } = resolveOwnerLenient(req);
    // NOTE, because the obvious change here is wrong: suppressions are deliberately NOT
    // applied to `merged` before it is stored. `triage` is a full-replace section, so
    // filtering here looks like the natural place to stop the sweep resurrecting a handled
    // item — but it DESTROYS the item, and Undo then has nothing to restore. Caught on a
    // live local run: suppress -> sweep republishes -> the door strips it -> DELETE the
    // suppression -> the item never comes back, because the stored state no longer had it.
    // Storage stays raw and complete; buildDayResponse (server.js) overlays suppressions on
    // the way OUT, which is the single place that decides what a client sees.
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
      // Nothing was created on the deduped path, so nothing to announce — the same
      // rule routes/blocks.js states for its own create loop. The MCP and CLI retry
      // loops are exactly what produce this shape, so without the guard a replay storm
      // is a re-fetch storm in every open tab.
      if (!created._resolvedExisting) broadcast("blocks-changed", { action: "quick-task-create", blockIds: [created.id], date }, workspaceId);
      // A3: `_resolvedExisting` means db.createBlock lost the key race and handed back the live
      // winner instead of inserting. The row is right either way, but reporting
      // "created" for it would be a lie a caller can act on — this is the retry shape
      // the MCP server and scripts/dcc-schedule.js now produce on a cold start, where
      // the retry can overlap the original request the server is still committing.
      res.json({ ok: true, date, status: created._resolvedExisting ? dedupeStatus(created) : "created", block: { id: created.id, title, start: props.start || null, end: props.end || null, priority: props.priority } });
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
  // ── C5b step 4: Postgres is the BASE state for every mutation in this file ──
  //
  // Six handlers here read the JSON day file as their base and then FULL-REPLACE the
  // Postgres row (`saveDccState` is `DO UPDATE SET state_json = EXCLUDED.state_json`). That
  // is what made `server.js buildDayResponse` unfixable on its own, and it is recorded in a
  // comment above that function: with the file as base, the skeleton `ensureSkeletonDays`
  // writes at boot becomes the base, and the next Brief refresh PERSISTS it over the real
  // day. On Railway the filesystem is ephemeral, so every redeploy re-arms that.
  //
  // Reading the durable store first inverts it: the file can no longer be promoted over
  // Postgres, and `buildDayResponse` no longer has to write the file to keep these honest.
  //
  // `resolveOwnerLenient` deliberately matches what `persistDccDay` uses to WRITE. Reading
  // as one owner and writing as another is how you would read workspace A's day and save it
  // over workspace B's.
  //
  // ★ THE FALLBACK CHAIN IS THE DANGEROUS PART, because every caller feeds this straight
  // into `persistDccDay` -> `saveDccState`, which is a FULL REPLACE.
  //
  //   - `DAY_STATE_FILE` is the LAST PUBLISHED day. It has no workspace segment and no
  //     guarantee its `date` matches the requested one, so using it ungated meant an ingest
  //     or a Brief decision could base its merge on a different day (possibly another
  //     tenant's) and persist that as the durable state for this date -- the exact promotion
  //     this phase exists to eliminate, arriving via a different file. It is only relevant
  //     when it IS about this date, which is the gate `server.js dayStateUnavailable`
  //     already applies to the same two files for the same reason.
  //   - A FAILED read is not an empty day. Falling through to `emptyFallback` after one
  //     would full-replace a real day with a skeleton. So a read we could not complete,
  //     with no per-date mirror to stand in, throws; the caller's own try/catch turns that
  //     into a 500 and the publisher retries. Losing one packet beats overwriting the day
  //     it was about.
  //   - A read that SUCCEEDS with no row genuinely means no day yet, so `emptyFallback` is
  //     correct there and only there.
  //
  //
  // `owner` lets a caller hand in the owner IT resolved. Five callers write with
  // `resolveOwnerLenient` and can leave it out, but `/api/dcc/brief/materialize` resolves with
  // `resolveOwnerStrict` and creates its rows under THAT workspace — and the two resolvers
  // disagree: for a DCC_ENDPOINTS token call (no session, no dccServiceAuth, no
  // x-workspace-id) lenient returns the hardcoded "ws-1" while strict falls through to a
  // `workspace_members` lookup. Re-deriving the owner here would read ws-1's brief and
  // materialize real itinerary rows into someone else's workspace.
  async function readDccDayState(date, req, emptyFallback, owner) {
    const { userId, workspaceId } = owner || resolveOwnerLenient(req);
    let dbFailed = false;
    try {
      const row = await blockDB.getDccState(date, workspaceId || (userId ? `ws-${userId}` : "ws-1"));
      if (row && row.state_json) return row.state_json;
    } catch (e) {
      dbFailed = true;
      console.error(`[dcc] day-state read failed for ${date}:`, e.message);
    }
    // ★ THE MIRROR IS AN OUTAGE STAND-IN ONLY, and round 1 of review got this backwards.
    //
    // It consulted the mirror BEFORE testing `dbFailed`, so a clean no-row read returned
    // `data/state/days/<date>.json` — which has no workspace segment and is written by
    // `persistDccDay` for every workspace. Every caller feeds this into a full replace, so:
    // user B posts `/api/dcc/brief/decision` for a date where B's workspace has no row, the
    // per-date file holds workspace A's day, and B's row is created holding A's timeline. B's
    // `/api/state/day` then serves it and B's public share publishes A's task titles to
    // anonymous viewers. A transient file read becomes a permanent cross-tenant row.
    //
    // The same PR hardened the guest writer against exactly this ("a no-row read seeds a
    // SKELETON, never the workspace-less file mirror") and asserted it in a test. Same
    // hazard, opposite policy, one change. This is the policy both now follow: a read that
    // SUCCEEDS with no row means no day for THIS workspace, and the unattributable mirror is
    // only ever better than nothing when we could not read at all.
    //
    // `readDayStateMirror` (server.js, shared through ctx) is the one implementation of the
    // per-date-file-then-date-matching-legacy-file ladder, and it stamps the requested date
    // onto the result. This used to be a hand-copy that returned the file's own `date`, so a
    // mirror with a stale date field fed a full-replace under the wrong day.
    if (dbFailed) {
      const mirror = readDayStateMirror(date, DAY_STATE_FILE);
      if (mirror) return mirror;
      throw new Error(`Day state unavailable for ${date}: Postgres read failed and no file mirror exists`);
    }
    return emptyFallback;
  }

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
      const existing = await readDccDayState(date, req, buildSkeletonState(date));
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
      const existing = await readDccDayState(date, req, buildSkeletonState(date));
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
      const state = await readDccDayState(day, req, buildSkeletonState(day));
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
        // A3: a concurrent writer can win the key between the lookup above and this
        // insert, and db.createBlock resolves that by returning the live winner rather
        // than raising. Take the SAME branch the lookup would have taken — including
        // following the winner's own date, because the paragraph above applies with
        // full force here: keying the ledger to the posted date would mint a second
        // credit row for a block already credited under its own.
        if (created._resolvedExisting) {
          duplicate = true;
          if (created.date) effectiveDate = created.date;
        }
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

      // The THIRD dedupe-broadcast site in this file, and the one that legitimately
      // differs from quick-task and push-next: even when no block row changed, this
      // endpoint may have just awarded slot credit, and open tabs need to hear about
      // that. So the condition is "something happened", not "a row was created" —
      // announce on a real create, or when earnTaskCredit reports a fresh award.
      if (!duplicate || (credit && credit.awarded)) {
        broadcast("blocks-changed", { action: "brief-log-done", blockIds: [blockId], date: effectiveDate }, workspaceId);
      }
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
      if (!created._resolvedExisting) broadcast("blocks-changed", { action: "brief-push-next", blockIds: [created.id], date }, workspaceId);
      // A3: same as quick-task — a lost key race is resolved in db.createBlock, and the
      // honest status is the one the lookup above would have returned.
      res.json({ ok: true, date, status: created._resolvedExisting ? dedupeStatus(created) : "created", block: { id: created.id, title } });
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
      // The SAME owner the blocks below are created under. `readDccDayState` defaults to
      // `resolveOwnerLenient`, which for a token-authed call here returns "ws-1" while the
      // strict resolution above can return a different workspace.
      const sourceState = await readDccDayState(sourceDate, req, buildSkeletonState(sourceDate), { userId, workspaceId });
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
      const existing = await readDccDayState(date, req, buildSkeletonState(date));
      const { state: nextState } = await dccIntelligence.refreshDccState({ date, state: existing, dataDir: DATA_DIR });
      await persistDccDay(date, nextState, req, "dcc-refresh");
      res.json({ ok: true, date, state: nextState });
    } catch (e) {
      console.error("[dcc refresh] failed:", e);
      res.status(500).json({ error: e.message || "DCC refresh failed" });
    }
  });
};
