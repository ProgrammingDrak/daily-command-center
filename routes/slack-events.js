// Extracted-style route module: module.exports(app, ctx).
//
// Slack Events API receiver — turns Drake's message reactions into DCC task
// lifecycle + duration tracking:
//   🔖 :bookmark:                → create the task (exists instantly; the Mac
//                                   poller enriches title + Slack permalink ≤5m later)
//   ⏳ :hourglass_flowing_sand:  → stamp startedAt (the EXACT reaction time)
//   ✅ :white_check_mark:        → complete + actualMinutes + points + a time_entry
//                                   segment so Day Review's planned-vs-actual lights up
//
// Why a webhook and not the search poller: Slack's search API returns no
// "reaction added at" timestamp, so elapsed time could only be guessed to the
// poll interval. reaction_added events carry an exact `event_ts`, so timing is
// to the second and works even when Drake's Mac is asleep.
//
// A reaction event carries only {channel, ts} — no message text/permalink — so
// the task is created minimal (title_pending) and the poller fills in the good
// Haiku title + clickable permalink from its hasmy::bookmark: search.
//
// This path is in AUTH_PUBLIC (server.js), so Clerk/session is skipped and
// verifying the request is Slack's signature is THIS route's job.
module.exports = function mount(app, ctx) {
  const { pool, blockDB, slotStore, broadcast, crypto, getTodayStr, APP_TIME_ZONE } = ctx;

  const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
  const DRAKE_UID = process.env.DRAKE_SLACK_USER_ID || "";
  // Same owner the Sweep Suite service path writes to (server.js attachSweepServiceAuth).
  const OWNER_USER_ID = Number(process.env.DCC_SERVICE_USER_ID || 1);
  const OWNER_WORKSPACE_ID = process.env.DCC_SERVICE_WORKSPACE_ID || `ws-${OWNER_USER_ID}`;
  const TZ = APP_TIME_ZONE || "America/New_York";
  const SLACK_HOST = process.env.SLACK_WORKSPACE_HOST || "cleverrealestate.slack.com";

  const NO_HOURGLASS_MIN = 5;         // 🔖 → ✅ with no ⏳ ⇒ assume 5 minutes
  const R_BOOKMARK = "bookmark";
  const R_START = "hourglass_flowing_sand";
  const R_DONE = "white_check_mark";

  // Deterministic per-message key, identical to the poller's (slack-bookmark-to-dcc.py).
  const keyFor = (channel, ts) => `slack-bookmark:${channel}:${ts}`;

  // ── Slack request signature (v0 scheme) ──────────────────────────────────
  function verifySlack(req) {
    if (!SIGNING_SECRET) { console.error("[slack-events] SLACK_SIGNING_SECRET unset — rejecting"); return false; }
    const ts = String(req.headers["x-slack-request-timestamp"] || "");
    const sig = String(req.headers["x-slack-signature"] || "");
    if (!ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // replay guard
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
    const expected = "v0=" + crypto.createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
    try {
      const a = Buffer.from(sig), b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  // Find the itinerary task for a bookmarked message. Reaction events have no
  // date, so this is the date-INDEPENDENT twin of the quick-task idempotency
  // lookup (routes/dcc.js), scoped to the owner workspace. `date` is cast to a
  // plain YYYY-MM-DD string so downstream (ensureDayRoot / credit) is safe.
  async function findTaskByKey(idemKey) {
    const { rows } = await pool.query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, properties FROM blocks
        WHERE properties->>'idempotency_key' = $1 AND workspace_id = $2 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [idemKey, OWNER_WORKSPACE_ID]
    );
    return rows[0] || null;
  }
  // Absorb the create-race: 🔖 and ⏳/✅ fired back-to-back can arrive out of order.
  async function findTaskWithRetry(idemKey, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const t = await findTaskByKey(idemKey);
      if (t) return t;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 400));
    }
    return null;
  }
  function addMin(hhmm, min) {
    const [h, m] = hhmm.split(":").map(Number);
    const t = h * 60 + m + min;
    return `${String(Math.floor((t % 1440) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }
  const fmt = (ms, opts) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).format(new Date(ms));
  const hhmm = (ms) => fmt(ms, { hour12: false, hour: "2-digit", minute: "2-digit" });      // "14:50"
  const human = (ms) => fmt(ms, { hour12: true, hour: "numeric", minute: "2-digit" })        // "2:50 PM" -> "2:50p"
    .replace(/\s?([AP])M$/i, (_, p) => p.toLowerCase());

  // ── 🔖 create ───────────────────────────────────────────────────────────
  async function handleBookmark(channel, ts) {
    const idemKey = keyFor(channel, ts);
    if (await findTaskByKey(idemKey)) return;   // webhook retry, or poller already made it
    const date = getTodayStr();
    // Best-effort permalink so the "Slack ↗" deeplink pill shows immediately (the
    // pill renders ONLY when source_id is an http(s) URL). The poller later swaps
    // in the exact, thread-aware permalink from search when it sets the real title.
    const permalink = `https://${SLACK_HOST}/archives/${channel}/p${String(ts).replace(".", "")}`;
    const props = {
      title: "Slack bookmark",                  // placeholder; poller upgrades via title_pending
      status: "open", kind: "task",
      estimatedMinutes: NO_HOURGLASS_MIN,
      priority: "Medium",
      source: "slack-bookmark", created_by: "slack-events",
      created_at: new Date().toISOString(),
      start: "09:00", end: addMin("09:00", NO_HOURGLASS_MIN),
      idempotency_key: idemKey,
      source_id: permalink,
      title_pending: true, slack_channel: channel, slack_ts: ts,
    };
    const created = await blockDB.createItineraryTask({ date, properties: props, userId: OWNER_USER_ID, workspaceId: OWNER_WORKSPACE_ID, score: true });
    broadcast("blocks-changed", { action: "slack-bookmark-create", blockIds: [created.id], date }, OWNER_WORKSPACE_ID);
  }

  // ── 🔖 removed → cancel an un-started task (a clean undo for a mis-bookmark) ─
  async function handleBookmarkRemoved(channel, ts) {
    const task = await findTaskByKey(keyFor(channel, ts));
    if (!task) return;
    const props = task.properties || {};
    if (props.startedAt || props.completedAt) return;   // already in flight / done — keep it
    await blockDB.deleteBlock(task.id);
    broadcast("blocks-changed", { action: "slack-bookmark-cancel", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ⏳ start ────────────────────────────────────────────────────────────
  async function handleStart(channel, ts, eventMs) {
    const task = await findTaskWithRetry(keyFor(channel, ts));
    if (!task) { console.warn(`[slack-events] ⏳ with no task for ${channel}:${ts} — ignored`); return; }
    const props = task.properties || {};
    if (props.startedAt || props.completedAt) return;   // first ⏳ wins; never restart a done task
    await blockDB.updateBlock(task.id, { properties: { ...props, startedAt: new Date(eventMs).toISOString() } });
    broadcast("blocks-changed", { action: "slack-start", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ⏳ removed → clear a not-yet-completed start ──────────────────────────
  async function clearStart(channel, ts) {
    const task = await findTaskByKey(keyFor(channel, ts));
    if (!task) return;
    const props = task.properties || {};
    if (!props.startedAt || props.completedAt) return;
    const { startedAt, ...rest } = props;
    await blockDB.updateBlock(task.id, { properties: rest });
    broadcast("blocks-changed", { action: "slack-start-clear", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ✅ complete ───────────────────────────────────────────────────────────
  async function handleDone(channel, ts, eventMs) {
    const task = await findTaskWithRetry(keyFor(channel, ts));
    if (!task) { console.warn(`[slack-events] ✅ with no task for ${channel}:${ts} — ignored`); return; }
    const props = task.properties || {};
    if (props.completedAt) return;   // already done (Slack retry) — idempotent

    const startedMs = props.startedAt ? Date.parse(props.startedAt) : null;
    const timed = startedMs && eventMs > startedMs;
    const actualMin = timed ? Math.max(1, Math.round((eventMs - startedMs) / 60000)) : NO_HOURGLASS_MIN;
    const teStartMs = timed ? startedMs : eventMs - NO_HOURGLASS_MIN * 60000;
    const durSec = Math.round((eventMs - teStartMs) / 1000);
    const completedIso = new Date(eventMs).toISOString();
    const tookNote = timed
      ? `⏱ Took ~${actualMin}m (⏳ ${human(startedMs)} → ✅ ${human(eventMs)})`
      : `⏱ ~${actualMin}m (✅ ${human(eventMs)}, no timer)`;
    const title = props.title || "Slack task";

    await blockDB.updateBlock(task.id, {
      properties: {
        ...props,
        status: "done", done: true, completed: true,
        completedAt: completedIso, doneAt: completedIso, completedBy: "slack-events",
        actualMinutes: actualMin,
        notes: props.notes ? `${props.notes}\n\n${tookNote}` : tookNote,
      },
    });

    // Points — idempotent on source_key (mirrors log-done so a later reconcile dedupes).
    try {
      await slotStore.earnTaskCredit(OWNER_WORKSPACE_ID, OWNER_USER_ID, {
        source_key: `${task.date}:${task.id}`,
        task_id: task.id, title, type: "task", tags: [],
        duration_minutes: props.estimatedMinutes || NO_HOURGLASS_MIN,
        actual_minutes: actualMin, completed_at: completedIso,
      });
    } catch (e) { console.error("[slack-events] credit failed (non-fatal):", e.message); }

    // Day Review actual segment — deterministic id so a Slack retry is idempotent.
    try {
      const teId = `${task.id}-slacktimer`;
      const { rows } = await pool.query("SELECT id FROM blocks WHERE id = $1", [teId]);
      if (!rows[0]) {
        const parentId = await blockDB.ensureDayRoot(task.date, OWNER_USER_ID, OWNER_WORKSPACE_ID);
        await blockDB.createBlock({
          id: teId, type: "time_entry", parent_id: parentId, date: task.date,
          properties: { blockId: task.id, taskTitle: title, start: hhmm(teStartMs), end: hhmm(eventMs), durSec, source: "slack", note: "Slack ⏳→✅ timer" },
          user_id: OWNER_USER_ID, workspace_id: OWNER_WORKSPACE_ID,
        });
      }
    } catch (e) { console.error("[slack-events] time_entry failed (non-fatal):", e.message); }

    broadcast("blocks-changed", { action: "slack-done", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── dispatch ────────────────────────────────────────────────────────────
  async function processEvent(ev) {
    if (ev.type !== "reaction_added" && ev.type !== "reaction_removed") return;
    if (DRAKE_UID && ev.user !== DRAKE_UID) return;                 // only Drake's reactions
    if (!ev.item || ev.item.type !== "message") return;
    const { channel, ts } = ev.item;
    const eventMs = Math.round(Number(ev.event_ts) * 1000) || Date.now();
    if (ev.type === "reaction_removed") {
      if (ev.reaction === R_START) return clearStart(channel, ts);
      if (ev.reaction === R_BOOKMARK) return handleBookmarkRemoved(channel, ts);
      return;                                                       // ✅ removal ignored in v1
    }
    if (ev.reaction === R_BOOKMARK) return handleBookmark(channel, ts);
    if (ev.reaction === R_START) return handleStart(channel, ts, eventMs);
    if (ev.reaction === R_DONE) return handleDone(channel, ts, eventMs);
  }

  // ── endpoint ──────────────────────────────────────────────────────────────
  app.post("/api/slack/events", (req, res) => {
    const body = req.body || {};
    if (body.type === "url_verification") {
      if (!verifySlack(req)) return res.status(401).end();
      return res.status(200).json({ challenge: body.challenge });
    }
    if (!verifySlack(req)) return res.status(401).end();
    res.status(200).end();                                          // ack within Slack's 3s window
    if (body.type === "event_callback" && body.event) {
      processEvent(body.event).catch(e => console.error("[slack-events] process failed:", e && e.message));
    }
  });
};
