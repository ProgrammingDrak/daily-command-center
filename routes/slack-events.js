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
const createTaskTiming = require("../lib/task-timing");
const { isBlockDone } = createTaskTiming;

module.exports = function mount(app, ctx) {
  const { pool, blockDB, slotStore, broadcast, crypto, getTodayStr, APP_TIME_ZONE } = ctx;

  const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
  // Only needed to re-add 🔖 when a ✅ is undone (reactions.add). Unset ⇒ that one
  // courtesy is skipped and logged; nothing else in this route depends on it.
  //
  // MUST be a USER token (xoxp, `reactions:write`), not a bot token. The poller's
  // queue is the Slack search `hasmy::bookmark:` — reactions by DRAKE. A bot token
  // would add the 🔖 as the bot, the search would not match it, and the task would
  // be reopened in the DCC while staying invisible to E2's queue. Same token the
  // poller already uses (brain secret `slack.userToken`).
  const USER_TOKEN = process.env.SLACK_USER_TOKEN || "";
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
  //
  // TOMBSTONES ARE INCLUDED, mirroring findBriefBlock (routes/dcc.js, PR #253).
  // This was the last resurrection path in the codebase: with `deleted_at IS NULL`
  // in the WHERE clause, re-adding 🔖 to a message whose task the user had
  // cancelled found nothing and minted a brand-new task. A live row still wins
  // (`deleted_at IS NULL DESC`), so every other caller behaves exactly as before —
  // they just have to say they want a live row, via findLiveTaskByKey.
  async function findTaskByKey(idemKey) {
    const { rows } = await pool.query(
      // workspace_id is selected so the timer row's delete fence in
      // lib/task-timing.js has a tenant to check against rather than falling
      // through its "unknown workspace" branch.
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, properties, deleted_at, workspace_id FROM blocks
        WHERE properties->>'idempotency_key' = $1 AND workspace_id = $2
        ORDER BY deleted_at IS NULL DESC, created_at DESC LIMIT 1`,
      [idemKey, OWNER_WORKSPACE_ID]
    );
    return rows[0] || null;
  }
  // Lifecycle handlers (⏳ / un-⏳ / ✅ / un-✅) act on live rows only: a
  // tombstoned task is one the user cancelled, and reactions on it are noise.
  async function findLiveTaskByKey(idemKey) {
    const t = await findTaskByKey(idemKey);
    return t && !t.deleted_at ? t : null;
  }
  // Absorb the create-race: 🔖 and ⏳/✅ fired back-to-back can arrive out of order.
  async function findTaskWithRetry(idemKey, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const t = await findLiveTaskByKey(idemKey);
      if (t) return t;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 400));
    }
    return null;
  }

  // Read the day's `_done` overlay for a task's date. The browser check-off is
  // persisted THERE, not on the row (until C5), so any handler that asks "has
  // this been finished?" has to look.
  //
  // NO try/catch, deliberately, for the reason responsibility-store's readDayRoot
  // documents: a failed read must NOT be reported as "nothing was completed on
  // this day". The caller's response to that lie is deleteBlock. processEvent is
  // already wrapped in a .catch at the endpoint, so a throw here is logged and
  // the task simply survives, which is the safe direction.
  //
  // getBlock, not ensureDayRoot: this is a read, and ensureDayRoot would CREATE
  // the row. Mirrors readDayRoot's legacy un-prefixed fallback, which is ws-1 only.
  async function dayRootPropsFor(date) {
    let root = await blockDB.getBlock(`day-root-${OWNER_WORKSPACE_ID}-${date}`);
    if (!root && OWNER_WORKSPACE_ID === "ws-1") root = await blockDB.getBlock(`day-root-${date}`);
    return (root && root.properties) || null;
  }

  // Drop this task from the day's `_done` overlay. Un-completing has to clear
  // EVERY completion store or the overlay silently re-applies the completion:
  // the UI keeps rendering the row checked (persistence.js loads _done into
  // manualDone), reconcileTiming re-derives the timing it just cleared, and the
  // credit the UI awarded on that check-off can never be re-earned because there
  // is nothing left to check off. Keyed on both identities the overlay accepts.
  async function pruneDoneOverlay(task) {
    const rootId = `day-root-${OWNER_WORKSPACE_ID}-${task.date}`;
    const root = (await blockDB.getBlock(rootId))
      || (OWNER_WORKSPACE_ID === "ws-1" ? await blockDB.getBlock(`day-root-${task.date}`) : null);
    if (!root) return;
    const rootProps = root.properties || {};
    const done = rootProps._done || {};
    const keys = new Set(createTaskTiming.blockIdentityKeys(task));
    const ids = (done.ids || []).map(String).filter(id => !keys.has(id));
    const at = { ...(done.at || {}) };
    for (const k of keys) delete at[k];
    const changed = ids.length !== (done.ids || []).length
      || Object.keys(at).length !== Object.keys(done.at || {}).length;
    if (!changed) return;
    await blockDB.updateBlock(root.id, { properties: { ...rootProps, _done: { ...done, ids, at } } });
  }

  // Put 🔖 back on the message so an un-✅'d task returns to the active queue —
  // E2's poller reads that reaction as the queue, so the two directions have to
  // agree. Best-effort: no token configured just means the reaction stays off,
  // and the task is still un-completed in the DCC.
  //
  // This re-add is itself a reaction BY Drake, so Slack echoes a `reaction_added`
  // event straight back at us. That is harmless by construction: it routes to
  // handleBookmark, which finds the (still live) task and returns. No loop, no
  // duplicate — see the test that pins it.
  async function addSlackReaction(channel, ts, name) {
    if (!USER_TOKEN) { console.warn(`[slack-events] SLACK_USER_TOKEN unset — cannot re-add :${name}:`); return; }
    try {
      const r = await fetch("https://slack.com/api/reactions.add", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${USER_TOKEN}` },
        body: JSON.stringify({ channel, timestamp: ts, name }),
      });
      const out = await r.json().catch(() => ({}));
      // already_reacted is success for our purposes: the reaction is on the message.
      if (!out.ok && out.error !== "already_reacted") console.error(`[slack-events] reactions.add :${name}: failed:`, out.error || r.status);
    } catch (e) { console.error(`[slack-events] reactions.add :${name}: threw (non-fatal):`, e.message); }
  }
  function addMin(hhmm, min) {
    const [h, m] = hhmm.split(":").map(Number);
    const t = h * 60 + m + min;
    return `${String(Math.floor((t % 1440) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }
  // The slot-ledger key for a Slack task's completion credit. ✅ and un-✅ MUST
  // agree on it or the revoke misses and a re-completion is silently eaten by
  // earnTaskCredit's ON CONFLICT DO NOTHING — hence one helper, two callers.
  //
  // Already `date:<row id>`: Slack tasks are minted server-side by
  // createItineraryTask, so there is no client local_id in play. Track A's
  // `date:local_id → date:blockId` ledger rewrite therefore does not touch this
  // path in either direction (noted for C5).
  const creditKeyFor = (task) => `${task.date}:${task.id}`;

  // actualMinutes + the ⏱ note + the Day Review time_entry live in lib/task-timing.js
  // (extracted from handleDone, E1) so the itinerary read path can close a ⏳ timer
  // that some OTHER surface completed. See that module's header.
  const { finalizeTiming, clearTiming } = createTaskTiming({ pool, blockDB, timeZone: TZ });

  // ── 🔖 create ───────────────────────────────────────────────────────────
  async function handleBookmark(channel, ts) {
    const idemKey = keyFor(channel, ts);
    // Any hit stops creation — live (webhook retry, or the poller already made it)
    // OR tombstoned. A tombstone means the user deliberately cancelled this
    // message's task; re-adding 🔖 must not resurrect it as a fresh row.
    const existing = await findTaskByKey(idemKey);
    if (existing) {
      if (existing.deleted_at) console.log(`[slack-events] 🔖 on a cancelled task for ${channel}:${ts} — not re-created`);
      return;
    }
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
  //
  // The keep-guard is wide on purpose. It used to be `startedAt || completedAt`,
  // but clearStart DELETES startedAt, so `🔖 → ⏳ → un-⏳ → un-🔖` slipped through
  // and soft-deleted a task that had already been worked on. `everStarted` is the
  // sticky version of startedAt that un-⏳ never clears; the done checks cover
  // completion from any surface, including the browser's `_done` overlay.
  //
  // Un-🔖 keeps its meaning — a clean undo for a mis-bookmark — it just stops
  // being a delete enabler for work that actually happened.
  async function handleBookmarkRemoved(channel, ts) {
    const task = await findLiveTaskByKey(keyFor(channel, ts));
    if (!task) return;
    const props = task.properties || {};
    // isBlockDone already covers status/done/completed/completedAt/doneAt plus the
    // day overlay, so only the "was worked on" half is left to check here.
    if (props.startedAt || props.everStarted) return;
    if (isBlockDone(task, await dayRootPropsFor(task.date))) return;
    await blockDB.deleteBlock(task.id);
    broadcast("blocks-changed", { action: "slack-bookmark-cancel", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ⏳ start ────────────────────────────────────────────────────────────
  async function handleStart(channel, ts, eventMs) {
    const task = await findTaskWithRetry(keyFor(channel, ts));
    if (!task) { console.warn(`[slack-events] ⏳ with no task for ${channel}:${ts} — ignored`); return; }
    const props = task.properties || {};
    if (props.startedAt || props.completedAt) return;   // first ⏳ wins; never restart a done task
    // everStarted is deliberately never cleared — see handleBookmarkRemoved.
    await blockDB.updateBlock(task.id, { properties: { ...props, startedAt: new Date(eventMs).toISOString(), everStarted: true } });
    broadcast("blocks-changed", { action: "slack-start", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ⏳ removed → clear a not-yet-completed start ──────────────────────────
  async function clearStart(channel, ts) {
    const task = await findLiveTaskByKey(keyFor(channel, ts));
    if (!task) return;
    const props = task.properties || {};
    if (!props.startedAt || props.completedAt) return;
    const { startedAt, ...rest } = props;   // everStarted intentionally survives
    await blockDB.updateBlock(task.id, { properties: rest });
    broadcast("blocks-changed", { action: "slack-start-clear", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ✅ complete ───────────────────────────────────────────────────────────
  async function handleDone(channel, ts, eventMs) {
    const task = await findTaskWithRetry(keyFor(channel, ts));
    if (!task) { console.warn(`[slack-events] ✅ with no task for ${channel}:${ts} — ignored`); return; }
    const props = task.properties || {};
    if (props.completedAt) return;   // already done (Slack retry) — idempotent

    const completedIso = new Date(eventMs).toISOString();
    const title = props.title || "Slack task";

    // One write: the completion stamps ride along with the timing fields, exactly
    // as they did before the extraction. fallbackMinutes is the Slack-only
    // "🔖→✅ with no ⏳ ⇒ assume 5 minutes" rule; no other caller passes it.
    const timing = await finalizeTiming({
      block: task, endMs: eventMs, fallbackMinutes: NO_HOURGLASS_MIN, title,
      userId: OWNER_USER_ID, workspaceId: OWNER_WORKSPACE_ID,
      mergeProps: {
        status: "done", done: true, completed: true,
        completedAt: completedIso, doneAt: completedIso, completedBy: "slack-events",
      },
    });
    const actualMin = timing.actualMinutes != null ? timing.actualMinutes : NO_HOURGLASS_MIN;

    // Points — idempotent on source_key (mirrors log-done so a later reconcile dedupes).
    try {
      await slotStore.earnTaskCredit(OWNER_WORKSPACE_ID, OWNER_USER_ID, {
        source_key: creditKeyFor(task),
        task_id: task.id, title, type: "task", tags: [],
        duration_minutes: props.estimatedMinutes || NO_HOURGLASS_MIN,
        actual_minutes: actualMin, completed_at: completedIso,
      });
    } catch (e) { console.error("[slack-events] credit failed (non-fatal):", e.message); }

    broadcast("blocks-changed", { action: "slack-done", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── ✅ removed → un-complete ──────────────────────────────────────────────
  //
  // v1 ignored this, so a mis-check was stuck done forever with the points banked.
  // The full inverse of handleDone, in the same order, so nothing is left half-done:
  // reopen the row, drop the timing, reverse the credit, restore the queue.
  async function handleUndone(channel, ts) {
    const task = await findLiveTaskByKey(keyFor(channel, ts));
    if (!task) { console.warn(`[slack-events] un-✅ with no task for ${channel}:${ts} — ignored`); return; }
    const props = task.properties || {};
    if (!props.completedAt) return;   // never completed by us (or a Slack retry) — idempotent

    // Reverse the points FIRST, and abort the un-complete entirely if it fails.
    // Without the revoke the balance keeps credit for work that was un-done AND,
    // worse, the ledger row survives so earnTaskCredit's ON CONFLICT DO NOTHING
    // silently awards zero on the eventual re-completion. Slack never retries a
    // reaction_removed (we 200 before dispatch), so a swallowed failure here would
    // never get reconciled. Leaving the task DONE is recoverable by re-toggling the
    // reaction; a half-reversal is not.
    try {
      await slotStore.revokeTaskCredit(OWNER_WORKSPACE_ID, OWNER_USER_ID, creditKeyFor(task));
    } catch (e) {
      console.error("[slack-events] credit revoke failed, leaving the task done so both stores stay consistent:", e.message);
      return;
    }

    // The overlay is the OTHER completion store, and it is cleared before the row
    // for the same reason the revoke is: a failure has to leave both stores "done"
    // rather than half-reversed. If this ran after clearTiming and failed, the
    // overlay would silently re-apply the completion (reconcileTiming re-derives
    // the timing just cleared, the UI keeps rendering the row checked) while the
    // credit stayed revoked. Bailing here keeps completedAt on the row, so
    // re-toggling ✅ re-enters this handler and retries.
    try {
      await pruneDoneOverlay(task);
    } catch (e) {
      console.error("[slack-events] _done prune failed, leaving the task done so both stores stay consistent:", e.message);
      return;
    }

    // Reopen + un-time in one write. clearTiming strips only the ⏱ line it wrote
    // and hard-deletes the timer segment, so Day Review loses the phantom block.
    // `startedAt` / `everStarted` deliberately survive: the work DID start, and a
    // later re-✅ should measure from the original ⏳, not from zero.
    await clearTiming({
      block: task,
      mergeProps: { status: "open" },
      dropProps: ["done", "completed", "completedAt", "doneAt", "completedBy"],
    });

    // Back into the active queue on the Slack side too (E2 reads 🔖 as the queue).
    await addSlackReaction(channel, ts, R_BOOKMARK);

    broadcast("blocks-changed", { action: "slack-undone", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
  }

  // ── dispatch ────────────────────────────────────────────────────────────
  async function processEvent(ev) {
    if (ev.type !== "reaction_added" && ev.type !== "reaction_removed") return;
    // FAIL CLOSED on an unset actor gate, the way verifySlack fails closed on a
    // missing signing secret. This used to be `DRAKE_UID && ...`, which processed
    // EVERY workspace member's reactions when the var was missing. That was already
    // wrong, and E1 widened the blast radius: handleUndone deletes ledger rows and
    // moves a real points balance, and addSlackReaction writes to Slack with
    // Drake's personal user token, so an unset var would hand any member a
    // react-as-Drake primitive.
    if (!DRAKE_UID) { console.error("[slack-events] DRAKE_SLACK_USER_ID unset — ignoring reaction events"); return; }
    if (ev.user !== DRAKE_UID) return;                              // only Drake's reactions
    if (!ev.item || ev.item.type !== "message") return;
    const { channel, ts } = ev.item;
    const eventMs = Math.round(Number(ev.event_ts) * 1000) || Date.now();
    if (ev.type === "reaction_removed") {
      if (ev.reaction === R_START) return clearStart(channel, ts);
      if (ev.reaction === R_BOOKMARK) return handleBookmarkRemoved(channel, ts);
      if (ev.reaction === R_DONE) return handleUndone(channel, ts);
      return;
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
