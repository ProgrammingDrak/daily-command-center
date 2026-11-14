// Extracted-style route module: module.exports(app, ctx).
//
// Slack Events API receiver and server-native recovery loop. A reaction becomes
// a durable DCC record without Claude Desktop or a local Mac:
//   🔖 :bookmark:                -> create a task, then enrich from the full thread
//   👥 :busts_in_silhouette:     -> create a Delegated item due for check-in tomorrow
//   ⌛ :hourglass:               -> stamp the exact startedAt time
//   ✅ :white_check_mark:        -> complete + actualMinutes + points + time_entry
//
// ONE APP, EVERY USER. This route used to be single-tenant: it dropped every
// event whose `ev.user` was not DRAKE_SLACK_USER_ID and wrote everything to one
// owner workspace, so a teammate sharing the DCC got nothing. Now the reaction
// routes by WHO REACTED (lib/slack-actors.js), lands on that person's own day,
// and a reactor with no DCC account is dropped having written nothing anywhere.
// Nobody needs their own Slack app.
//
// HOW THE TENANCY IS EXPRESSED. Everything that depends on whose reaction it is
// lives inside `forActor(actor)`. That was a deliberate choice over threading an
// `actor` argument through thirty functions: the helpers keep their bodies, and
// the five values that used to be module constants (the user token, the owner
// user, the owner workspace, the Slack host, and the actor gate) are read off
// the actor instead. Anything genuinely global (the signing secret, timeouts,
// the enrichment model, the reaction names) stays at mount scope. State that is
// per-tenant survives across actor bindings. Mirror receipts persist settled
// revisions and retry state when the gated schema is present.
//
// TOKENS ARE NOT INTERCHANGEABLE, which is the one real seam here. `slackApi`
// prefers the actor's user token and falls back to the shared bot token, EXCEPT
// for `search.messages`, which has no bot equivalent at all: the hasmy: sweep is
// marked user_required and bot-tier actors skip it instead of erroring. Reactions
// posted on a bot-tier actor's behalf come from the bot, so they do not match a
// hasmy: query either. Both limitations disappear for anyone who later connects
// their own Slack. See docs/slack-setup.md.
//
// Why a webhook and not the search poller: Slack's search API returns no
// "reaction added at" timestamp, so elapsed time could only be guessed to the
// poll interval. reaction_added events carry an exact `event_ts`, so timing is
// to the second and works even when the reactor's machine is asleep.
//
// A reaction event carries only {channel, ts}. The route fetches the message for
// an immediate deterministic title + deeplink, uses local rules to create a readable title. No model call is made.
//
// This path is in AUTH_PUBLIC (server.js), so Clerk/session is skipped and
// verifying the request is Slack's signature is THIS route's job.
const sweepMetrics = require("../lib/slack-sweep-metrics");
const { candidatesSql, recordReceipt } = require("../lib/slack-projection-receipts");
const createTaskTiming = require("../lib/task-timing");
const { slackTarget, sameTarget } = require("../lib/slack-status");
const waitingItems = require("../waiting-items");
const createSlackActors = require("../lib/slack-actors");
const { createSlackOAuth } = require("../lib/slack-oauth");
const {
  addCalendarDays,
  fallbackTitle,
  normalizeSlackMessage,
  slackPermalink,
  sourceNotes,
} = require("../lib/slack-capture");
const { isBlockDone, isStaleWorkEvent } = createTaskTiming;

module.exports = function mount(app, ctx) {
  const { pool, blockDB, slotStore, broadcast, crypto, getTodayStr, APP_TIME_ZONE } = ctx;

  const measureSweep = process.env.SLACK_RECONCILE_METRICS === "1";
  if (measureSweep) sweepMetrics.instrumentPool(pool);

  const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
  const TZ = APP_TIME_ZONE || "America/New_York";
  const ENRICHMENT_MODEL = "slack-rules-v1";
  const SLACK_API_TIMEOUT_MS = Math.max(1_000, Number(process.env.SLACK_API_TIMEOUT_MS || 20_000));
  const RECONCILE_ENABLED = process.env.SLACK_RECONCILE_ENABLED !== "0"
    && (process.env.NODE_ENV === "production" || process.env.SLACK_RECONCILE_ENABLED === "1");
  const RECONCILE_MS = Math.max(60_000, Number(process.env.SLACK_RECONCILE_INTERVAL_MS || 300_000));
  const DELEGATE_IMPORT_AFTER_RAW = String(process.env.SLACK_DELEGATE_IMPORT_AFTER || "").trim();
  const DELEGATE_IMPORT_AFTER_PARSED = Date.parse(DELEGATE_IMPORT_AFTER_RAW);
  const DELEGATE_IMPORT_AFTER_MS = Number.isFinite(DELEGATE_IMPORT_AFTER_PARSED)
    ? DELEGATE_IMPORT_AFTER_PARSED
    : Number.POSITIVE_INFINITY;
  if (RECONCILE_ENABLED && process.env.NODE_ENV === "production" && !Number.isFinite(DELEGATE_IMPORT_AFTER_PARSED)) {
    throw new Error("SLACK_DELEGATE_IMPORT_AFTER must be a stable ISO timestamp when Slack reconciliation is enabled in production");
  }

  // Who a reaction belongs to. The env identity stays the first-checked, DB-free
  // fallback, so the original single-tenant deployment keeps behaving exactly as
  // it did. See lib/slack-actors.js.
  // Tier 2. `openGrant` is what lets a DB-backed identity be user tier: without
  // it every stored token is ignored and everyone stays bot tier, which is exactly
  // the pre-OAuth behaviour. Wrapped rather than passed directly so a server with
  // no SLACK_TOKEN_ENC_KEY boots normally and only complains if a grant is
  // actually present to open.
  const slackOAuth = createSlackOAuth({ apiTimeoutMs: SLACK_API_TIMEOUT_MS });
  const actors = createSlackActors({
    pool,
    apiTimeoutMs: SLACK_API_TIMEOUT_MS,
    openGrant: (sealed) => slackOAuth.openGrant(sealed),
  });
  // Published so routes/slack-oauth.js shares this instance — one redirect URI and
  // one encryption key across the process, rather than two modules each reading env.
  ctx.slackOAuth = slackOAuth;

  const NO_HOURGLASS_MIN = 5;         // 🔖 → ✅ with no ⌛ ⇒ assume 5 minutes
  const R_BOOKMARK = "bookmark";
  const R_START = "hourglass";
  const R_DONE = "white_check_mark";
  const R_DELEGATE = "busts_in_silhouette";

  // Deterministic per-message key, identical to the poller's (slack-bookmark-to-dcc.py).
  // Two people bookmarking the SAME message each get their own task: the key is
  // identical but every lookup is fenced by the actor's workspace, so there is no
  // collision between tenants.
  const keyFor = (channel, ts) => `slack-bookmark:${channel}:${ts}`;
  const delegateKeyFor = (channel, ts) => `slack-delegate:${channel}:${ts}`;
  const delegateCompletionKeyFor = (channel, ts) => `slack-delegate-completion:${channel}:${ts}`;
  const pendingDoneKeyFor = (channel, ts) => `slack-done-pending:${channel}:${ts}`;
  const taskKeyPrecedence = `(COALESCE(properties->>'kind', '') = 'slack_reaction_tombstone') ASC,
    deleted_at IS NULL DESC, created_at DESC`;

  // Everything outside this set is user-owned delegated-item state. The stored
  // snapshot lets reaction removal delete only a pristine auto-created item.
  // Any edit, including a future field this route does not yet know about, makes
  // the snapshot differ and preserves the item.
  const DELEGATE_SYSTEM_KEYS = new Set([
    "delegate_auto_snapshot", "source", "source_id", "source_message_preview",
    "slack_channel", "slack_ts", "slack_thread_ts", "slack_author",
    "slack_channel_name", "captured_at", "capture_status", "captureTitle", "captureNotes",
    "enrichment_status", "enrichment_attempts", "enrichment_next_attempt_at",
    "enrichment_last_error", "enrichment_model", "enriched_at", "aiTitle",
    "aiSummary", "idempotency_key", "created_by", "created_at",
    "slack_delegate_reaction_removed_at", "slackDelegateChangedAt",
    "slackDelegateClusterIds",
  ]);
  function delegateUserState(props) {
    const state = {};
    for (const key of Object.keys(props || {}).sort()) {
      if (!DELEGATE_SYSTEM_KEYS.has(key)) state[key] = props[key];
    }
    return state;
  }
  function delegateIsUntouched(props) {
    if (!props || !props.delegate_auto_snapshot) return false;
    return JSON.stringify(delegateUserState(props)) === JSON.stringify(props.delegate_auto_snapshot);
  }
  function stampDelegateSnapshot(props) {
    return { ...props, delegate_auto_snapshot: delegateUserState(props) };
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
  // (extracted from handleDone, E1) so the itinerary read path can close a ⌛ timer
  // that some OTHER surface completed. See that module's header. Actor-independent:
  // it takes the same pool, blockDB and zone whoever reacted, so it stays hoisted.
  const { startWork, pauseWork, completeWork, reopenWork } = createTaskTiming({ pool, blockDB, timeZone: TZ });

  function completionMutationId(actionId, taskId, direction) {
    const seed = `${actionId || "slack"}:${taskId}:${direction}`;
    return `slack:${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
  }

  // The old cursor is used only until the explicitly gated schema is installed.
  const mirrorCursors = new Map();
  const historySearches = new Map();
  const searchCooldowns = new Map();
  let receiptsAvailable = null;

  async function checkReceiptSchema() {
    const { rows } = await pool.query("SELECT to_regclass('slack_projection_receipts') IS NOT NULL AS available");
    receiptsAvailable = rows[0]?.available === true;
  }
  const projectionQueues = new Map();

  // ── Reaction-write failure state ─────────────────────────────────────────
  //
  // The projector retried permanently-dead writes forever. Measured in prod
  // (railway logs): 20 of 46 log lines in one window were reactions.remove
  // failures — 12 channel_not_found, 6 message_not_found, 2 RATELIMITED. Only
  // `no_reaction` was ever treated as terminal, so every deleted Slack task
  // re-attempted three removals per five-minute reconcile pass, indefinitely,
  // and eventually walked the whole backlog into Slack's rate limiter.
  //
  // The local poller (claude-brain/scripts/slack-bookmark-to-dcc.py) already
  // solved this; these are its two rules, ported. Keep the two lists in step.
  //
  // MESSAGE-level, not reaction-level: if the message or channel is gone, every
  // reaction on it is equally hopeless, so one dead marker covers all four
  // emoji rather than each learning the same thing separately.
  const PERMANENT_REACTION_ERRORS = new Set([
    "message_not_found", "channel_not_found", "is_archived",
    "not_in_channel", "no_item_specified",
  ]);
  // Expiring rather than permanent, deliberately. `channel_not_found` is not
  // always forever — a private channel the token was later invited to, or a
  // Slack consistency blip, both read the same from here. A long TTL stops the
  // five-minute churn while still letting a genuine recovery heal itself.
  // Floored at 0 rather than a minute so the expiry is testable without a real
  // sleep; 0 means "never remember", i.e. the old behaviour. Prod does not set
  // this, so the 24h default is what actually runs.
  const DEAD_MESSAGE_TTL_MS = Math.max(0, Number(process.env.SLACK_DEAD_MESSAGE_TTL_MS ?? 86_400_000));
  const DEAD_MESSAGE_MAX = 5_000;
  const deadMessages = new Map();            // "channel:ts" -> { code, at }
  // Slack limits applications per team. Use the configured Slack host as a
  // conservative key for legacy identities without a team ID.
  const reactionCooldowns = new Map();       // Slack team or host -> resumeAtMs
  // Floor of 0 rather than a second so the pause is testable without a real
  // sleep; 0 disables it outright, matching how the other tunables here behave.
  // Prod does not set this, so the 60s default is what actually runs.
  const RATE_LIMIT_BACKOFF_MS = Math.max(0, Number(process.env.SLACK_RATE_LIMIT_BACKOFF_MS ?? 60_000));

  function deadMessageCode(channel, ts, workspaceId) {
    const entry = deadMessages.get(`${workspaceId || ""}:${channel}:${ts}`);
    if (!entry) return null;
    if (Date.now() - entry.at > DEAD_MESSAGE_TTL_MS) { deadMessages.delete(`${workspaceId || ""}:${channel}:${ts}`); return null; }
    return entry.code;
  }
  function markMessageDead(channel, ts, code, workspaceId) {
    if (deadMessages.size >= DEAD_MESSAGE_MAX) {
      const cutoff = Date.now() - DEAD_MESSAGE_TTL_MS;
      for (const [key, entry] of deadMessages) if (entry.at <= cutoff) deadMessages.delete(key);
      // Still full of live entries: drop the oldest insertion so the Map stays
      // bounded. A dropped marker costs one wasted retry, never a wrong answer.
      if (deadMessages.size >= DEAD_MESSAGE_MAX) deadMessages.delete(deadMessages.keys().next().value);
    }
    deadMessages.set(`${workspaceId || ""}:${channel}:${ts}`, { code, at: Date.now() });
  }

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

  // ══════════════════════════════════════════════════════════════════════════
  // Everything below is per-actor. `actor` decides which Slack token speaks and
  // which DCC user and workspace get written; see lib/slack-actors.js.
  // ══════════════════════════════════════════════════════════════════════════
  function forActor(actor) {
    const USER_TOKEN = (actor.tokens && actor.tokens.user) || "";
    const BOT_TOKEN = (actor.tokens && actor.tokens.bot) || "";
    const ANY_TOKEN = USER_TOKEN || BOT_TOKEN;
    // Same owner the Sweep Suite service path writes to (server.js attachSweepServiceAuth)
    // when this is the env actor, and the reacting teammate's own account otherwise.
    const OWNER_USER_ID = actor.userId;
    const OWNER_WORKSPACE_ID = actor.workspaceId;
    const SLACK_HOST = actor.slackHost;
    const actorKey = JSON.stringify([OWNER_USER_ID, actor.slackUserId, actor.slackTeamId, actor.tier]);
    // Bot-tier actors share the app's reaction quota within a Slack team.
    const cooldownKey = actor.slackTeamId
      ? JSON.stringify(["team", actor.slackTeamId])
      : JSON.stringify(["host", SLACK_HOST]);

    const saveReceipt = (id, revision, outcome, nextAttempt) =>
      recordReceipt(pool, OWNER_WORKSPACE_ID, actorKey, id, revision, outcome, nextAttempt);

    function reactionPaused() {
      return (reactionCooldowns.get(cooldownKey) || 0) > Date.now();
    }

    let cooldownChecked = false;
    async function loadReactionCooldown() {
      if (reactionPaused() || cooldownChecked) return reactionPaused();
      if (receiptsAvailable === null && typeof pool.connect === "function") await checkReceiptSchema();
      if (!receiptsAvailable) return false;
      const { rows } = await pool.query(`
        SELECT next_attempt_at AS resume_at FROM slack_projection_receipts
        WHERE workspace_id = '' AND actor_key = $1 AND block_id = ''
          AND next_attempt_at > clock_timestamp()
      `, [cooldownKey]);
      cooldownChecked = true;
      if (rows[0]?.resume_at) reactionCooldowns.set(cooldownKey, Math.max(reactionCooldowns.get(cooldownKey) || 0, new Date(rows[0].resume_at).getTime()));
      return reactionPaused();
    }

    async function syncLinkedTriage(block, reason, atMs) {
      if (!(block && (block.properties || {}).triageId) || typeof ctx.transitionLinkedTriage !== "function") return;
      try { await ctx.transitionLinkedTriage(block, reason, atMs); }
      catch (error) { console.error(`[slack-events] Triage ${reason} sync failed (non-fatal):`, error.message); }
    }

    // `options.token` is "user_required" for the one method with no bot
    // equivalent (search.messages). Everything else prefers the actor's own user
    // token and falls back to the shared bot token, so a user-tier actor behaves
    // byte-for-byte the way the single-tenant version did.
    async function slackApi(method, params, options = {}) {
      const needsUser = options.token === "user_required";
      const token = needsUser ? USER_TOKEN : ANY_TOKEN;
      if (!token) {
        const error = new Error(needsUser
          ? `Slack ${method} requires a user token and this actor has none`
          : `Slack ${method} failed: no Slack token is configured`);
        error.code = needsUser ? "slack_needs_user_token" : "slack_no_token";
        throw error;
      }
      const body = new URLSearchParams();
      Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
      });
      const usePost = options.post === true;
      const url = `https://slack.com/api/${method}${usePost ? "" : `?${body.toString()}`}`;
      if (method === "reactions.add" || method === "reactions.remove") sweepMetrics.count("slackWrites");
      const response = await fetch(url, {
        method: usePost ? "POST" : "GET",
        signal: globalThis.AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(usePost ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(usePost ? { body: body.toString() } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        const error = new Error(`Slack ${method} failed: ${data.error || response.status}`);
        error.code = response.status === 429 ? "ratelimited" : data.error || `http_${response.status}`;
        // Slack answers a 429 with Retry-After in seconds. Honour its number
        // rather than guessing; the fallback only applies when it is absent.
        const retryHeader = response.headers?.get?.("retry-after");
        const retryAfter = retryHeader?.trim() ? Number(retryHeader) : NaN;
        if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = retryAfter * 1000;
        throw error;
      }
      return data;
    }

    async function captureSlackMessage(channel, ts, seed) {
      let raw = seed || null;
      if (!raw || !raw.text) {
        const result = await slackApi("reactions.get", { channel, timestamp: ts, full: true });
        raw = result.message || result;
      }
      const capture = normalizeSlackMessage(raw, { ts });
      capture.ts = capture.ts || String(ts);
      capture.threadTs = capture.threadTs || capture.ts;
      if (!capture.permalink) {
        try {
          const link = await slackApi("chat.getPermalink", { channel, message_ts: capture.ts });
          capture.permalink = link.permalink || "";
        } catch (error) {
          console.warn(`[slack-events] canonical permalink lookup failed for ${channel}:${ts}:`, error.message);
        }
      }
      capture.permalink = capture.permalink || slackPermalink(SLACK_HOST, channel, capture.ts, capture.threadTs);
      if (!capture.text) throw new Error("Slack message text was empty");
      return capture;
    }

    function captureProperties(kind, channel, ts, capture) {
      const capturedAt = new Date().toISOString();
      const title = fallbackTitle(capture && capture.text);
      const permalink = (capture && capture.permalink) || slackPermalink(SLACK_HOST, channel, ts, capture && capture.threadTs);
      const notes = sourceNotes(kind, { ...(capture || {}), permalink });
      return {
        title,
        captureTitle: title,
        captureNotes: notes,
        source: kind === "delegate" ? "slack-delegate" : "slack-bookmark",
        source_id: permalink,
        source_message_preview: String(capture && capture.text || "").slice(0, 1000),
        slack_channel: channel,
        slack_ts: ts,
        slack_thread_ts: String(capture && capture.threadTs || ts),
        slack_author: String(capture && capture.user || "unknown"),
        slack_channel_name: String(capture && capture.channelName || "slack"),
        // Waiting keeps exact Slack coordinates so a later check-in draft lands
        // back in the reacted thread without parsing a display URL.
        contact: {
          channel: "slack",
          address: String(channel || ""),
          sourceRef: permalink,
          threadTs: String(capture && capture.threadTs || ts),
          messageTs: String(capture && capture.ts || ts),
        },
        captured_at: capturedAt,
        capture_status: capture && capture.text ? "captured" : "retry",
        enrichment_status: "complete",
        enrichment_attempts: 0,
        enrichment_next_attempt_at: null,
        enrichment_model: ENRICHMENT_MODEL,
        notes,
      };
    }

    // Settle old enrichment jobs locally. Preserve titles changed by the user.
    async function enrichBlock(blockOrId) {
      const block = await blockDB.getBlock(typeof blockOrId === "string" ? blockOrId : blockOrId.id);
      if (!block || block.deleted_at || String(block.workspace_id) !== String(OWNER_WORKSPACE_ID)) return false;
      const props = block.properties || {};
      if (props.kind === "slack_reaction_tombstone" || !props.slack_channel || !props.slack_ts) return false;
      if (props.enrichment_model === ENRICHMENT_MODEL && props.enrichment_status === "complete") return true;
      const displayField = props.kind === "delegated_item" ? "myTask" : "title";
      const title = props[displayField] || "";
      const canReplace = !title || title === props.captureTitle || title === "Slack task" || title === "Slack bookmark";
      const untouchedDelegate = props.kind === "delegated_item" && delegateIsUntouched(props);
      const generated = fallbackTitle(props.source_message_preview || props.captureTitle || title);
      const merged = { ...props, captureTitle: generated,
        enrichment_status: "complete", enrichment_model: ENRICHMENT_MODEL,
        enrichment_next_attempt_at: null, enrichment_last_error: null };
      if (canReplace && (props.kind !== "delegated_item" || untouchedDelegate)) merged[displayField] = generated;
      await blockDB.updateBlock(block.id, { properties: untouchedDelegate ? stampDelegateSnapshot(merged) : merged });
      broadcast("blocks-changed", { action: "slack-enriched", blockIds: [block.id], date: block.date || null }, OWNER_WORKSPACE_ID);
      return true;
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    // Find the itinerary task for a bookmarked message. Reaction events have no
    // date, so this is the date-INDEPENDENT twin of the quick-task idempotency
    // lookup (routes/dcc.js), scoped to the actor's workspace. `date` is cast to a
    // plain YYYY-MM-DD string so downstream (ensureDayRoot / credit) is safe.
    //
    // The workspace fence is also the whole multi-tenant story for lookups: the
    // idempotency key is the same string for everyone who reacts to a message, so
    // this predicate is what keeps one person's 🔖 from finding another's task.
    //
    // TOMBSTONES ARE INCLUDED, mirroring findBriefBlock (routes/dcc.js, PR #253).
    // This was the last resurrection path in the codebase: with `deleted_at IS NULL`
    // in the WHERE clause, re-adding 🔖 to a message whose task the user had
    // cancelled found nothing and minted a brand-new task. A live row still wins
    // (`deleted_at IS NULL DESC`), so every other caller behaves exactly as before —
    // they just have to say they want a live row, via findLiveTaskByKey.
    async function findTaskByKey(idemKey, client = pool) {
      const { rows } = await client.query(
        // workspace_id is selected so the timer row's delete fence in
        // lib/task-timing.js has a tenant to check against rather than falling
        // through its "unknown workspace" branch.
        `SELECT id, type, parent_id, to_char(date, 'YYYY-MM-DD') AS date, properties, deleted_at, user_id, workspace_id FROM blocks
          WHERE properties->>'idempotency_key' = $1 AND workspace_id = $2
          ORDER BY ${taskKeyPrecedence} LIMIT 1`,
        [idemKey, OWNER_WORKSPACE_ID]
      );
      return rows[0] || null;
    }
    // Lifecycle handlers (⌛ / un-⌛ / ✅ / un-✅) act on live rows only: a
    // tombstoned task is one the user cancelled, and reactions on it are noise.
    async function findLiveTaskByKey(idemKey, client) {
      const t = await findTaskByKey(idemKey, client);
      return t && !t.deleted_at && (t.properties || {}).kind !== "slack_reaction_tombstone" ? t : null;
    }
    // A ✅ can follow either capture reaction. Check both on every retry so a
    // delegate does not wait through three bookmark-only reads before it closes.
    async function findReactedRowsWithRetry(channel, ts, tries = 3) {
      for (let i = 0; i < tries; i++) {
        const [bookmark, delegate] = await Promise.all([
          findLiveTaskByKey(keyFor(channel, ts)),
          findLiveTaskByKey(delegateKeyFor(channel, ts)),
        ]);
        if (bookmark || delegate) return { bookmark, delegate };
        if (i < tries - 1) await new Promise(r => setTimeout(r, 400));
      }
      return { bookmark: null, delegate: null };
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
    // On a user-tier actor this re-add is a reaction BY that person, so Slack
    // echoes a `reaction_added` event straight back at us. That is harmless by
    // construction: it routes to handleBookmark, which finds the (still live) task
    // and returns. No loop, no duplicate — see the test that pins it. On a bot-tier
    // actor the reaction is the bot's, so there is no echo and no hasmy: match.
    // Both reaction writers share one gate and one classifier, because they fail
    // in exactly the same ways and diverged only in which "already in the desired
    // state" answer they forgive (already_reacted vs no_reaction).
    //
    // Returns true for "Slack is in the state we asked for, or never will be" and
    // false only for a failure worth retrying. Callers have always ignored the
    // value; it is the reconcile loop's repeat attempt that this actually saves.
    function reactionWriteBlocked(channel, ts, name, verb) {
      if (!ANY_TOKEN) {
        console.warn(`[slack-events] no Slack token for user ${OWNER_USER_ID} - cannot ${verb} :${name}:`);
        return true;
      }
      const dead = deadMessageCode(channel, ts, OWNER_WORKSPACE_ID);
      if (dead) return true;                       // already learned, silently
      if (reactionPaused()) return true;      // rate-limited, see below
      return false;
    }

    // `settled` means stop asking: either Slack agrees with us, or it never will.
    async function classifyReactionFailure(error, channel, ts, name, verb, client = pool) {
      if (PERMANENT_REACTION_ERRORS.has(error.code)) {
        // Logged once per message, at info level, where this used to repeat every
        // five minutes per emoji per dead row. Once is structural rather than
        // guarded: marking the message dead makes reactionWriteBlocked short-circuit
        // every later write, so the classifier is only ever reached the first time.
        console.log(`[slack-events] ${channel}:${ts} is unreachable (${error.code}) - no further reaction writes`);
        markMessageDead(channel, ts, error.code, OWNER_WORKSPACE_ID);
        return { settled: true };
      }
      if (error.code === "ratelimited") {
        // Stop the rest of this pass rather than walking the remaining backlog
        // into the same wall — the poller breaks its loop here for the same
        // reason. The mirror is explicitly allowed latency, so draining across
        // several reconcile passes costs nothing.
        const backoff = error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS;
        const resumeAt = Date.now() + backoff;
        reactionCooldowns.set(cooldownKey, Math.max(reactionCooldowns.get(cooldownKey) || 0, resumeAt));
        sweepMetrics.count("rateLimited");
        if (receiptsAvailable) {
          await recordReceipt(client, "", cooldownKey, "", "", "cooldown", new Date(resumeAt));
        }
        console.warn(`[slack-events] rate-limited by Slack; pausing reaction writes for ${Math.round(backoff / 1000)}s`);
        return { settled: false };
      }
      // Anything else is genuinely worth another go — missing_scope before a
      // reinstall is the motivating example.
      console.error(`[slack-events] reactions.${verb} :${name}: failed:`, error.message);
      return { settled: false };
    }

    async function addSlackReaction(channel, ts, name, client) {
      if (await loadReactionCooldown()) return false;
      if (reactionWriteBlocked(channel, ts, name, "add")) return !!deadMessageCode(channel, ts, OWNER_WORKSPACE_ID);
      try {
        await slackApi("reactions.add", { channel, timestamp: ts, name }, { post: true });
        return true;
      } catch (e) {
        if (e.code === "already_reacted") return true;
        return (await classifyReactionFailure(e, channel, ts, name, "add", client)).settled;
      }
    }
    async function removeSlackReaction(channel, ts, name, client) {
      if (await loadReactionCooldown()) return false;
      if (reactionWriteBlocked(channel, ts, name, "remove")) return !!deadMessageCode(channel, ts, OWNER_WORKSPACE_ID);
      try {
        await slackApi("reactions.remove", { channel, timestamp: ts, name }, { post: true });
        return true;
      } catch (e) {
        if (e.code === "no_reaction") return true;
        return (await classifyReactionFailure(e, channel, ts, name, "remove", client)).settled;
      }
    }

    // A removal can be delivered before its matching add finishes. A single-write
    // hidden idempotency row ensures the delayed add cannot leave a phantom task.
    // This is intentionally not create-then-delete: a failed second write could
    // otherwise expose an empty delegated card permanently.
    async function createReactionTombstone(kind, channel, ts, eventMs = Date.now()) {
      const idemKey = kind === "delegate" ? delegateKeyFor(channel, ts) : keyFor(channel, ts);
      if (await findTaskByKey(idemKey)) return;
      const created = await blockDB.createBlock({
        type: "block",
        parent_id: null,
        date: null,
        properties: {
          kind: "slack_reaction_tombstone",
          source: kind === "delegate" ? "slack-delegate" : "slack-bookmark",
          status: "cancelled",
          hidden: true,
          idempotency_key: idemKey,
          slack_channel: channel,
          slack_ts: ts,
          created_by: "slack-events-tombstone",
          created_at: new Date().toISOString(),
          ...(kind === "bookmark"
            ? { slackBookmarkChangedAt: new Date(eventMs).toISOString() }
            : { slackDelegateChangedAt: new Date(eventMs).toISOString() }),
        },
        user_id: OWNER_USER_ID,
        workspace_id: OWNER_WORKSPACE_ID,
      });
      return created;
    }

    async function writePendingDoneIntent(channel, ts, eventMs, status) {
      const idemKey = pendingDoneKeyFor(channel, ts);
      const existing = await findTaskByKey(idemKey);
      const changedAt = new Date(eventMs).toISOString();
      if (existing && !existing.deleted_at) {
        const props = existing.properties || {};
        const previousMs = Date.parse(props.pendingDoneChangedAt || props.pendingCompletedAt || "");
        if (Number.isFinite(previousMs) && eventMs <= previousMs) return existing;
        return blockDB.updateBlock(existing.id, { properties: {
          ...props,
          status,
          pendingDoneChangedAt: changedAt,
          ...(status === "pending" ? { pendingCompletedAt: changedAt } : {}),
        } });
      }
      if (existing && existing.deleted_at) return existing;
      return blockDB.createBlock({
        type: "block",
        parent_id: null,
        date: null,
        properties: {
          kind: "slack_done_intent",
          source: "slack-reaction-intent",
          status,
          hidden: true,
          idempotency_key: idemKey,
          slack_channel: channel,
          slack_ts: ts,
          pendingDoneChangedAt: changedAt,
          ...(status === "pending" ? { pendingCompletedAt: changedAt } : {}),
          created_by: "slack-events",
          created_at: new Date().toISOString(),
        },
        user_id: OWNER_USER_ID,
        workspace_id: OWNER_WORKSPACE_ID,
      });
    }

    const createPendingDoneIntent = (channel, ts, eventMs) => writePendingDoneIntent(channel, ts, eventMs, "pending");
    const cancelPendingDoneIntent = (channel, ts, eventMs) => writePendingDoneIntent(channel, ts, eventMs, "cancelled");

    async function applyPendingDoneIntent(channel, ts) {
      const pending = await findLiveTaskByKey(pendingDoneKeyFor(channel, ts));
      if (!pending || (pending.properties || {}).status !== "pending") return false;
      const atMs = Date.parse((pending.properties || {}).pendingCompletedAt || "");
      await handleDone(channel, ts, Number.isFinite(atMs) ? atMs : Date.now(), pending.id);
      await blockDB.updateBlock(pending.id, { properties: {
        ...(pending.properties || {}),
        status: "applied",
        pendingAppliedAt: new Date().toISOString(),
      } });
      return true;
    }

    // ── 🔖 create ───────────────────────────────────────────────────────────
    async function handleBookmark(channel, ts, seed, eventMs = Date.now(), recovery = false) {
      const idemKey = keyFor(channel, ts);
      let existing = await findTaskByKey(idemKey);
      if (existing && recovery) return;
      if (existing) {
        const existingProps = existing.properties || {};
        const previousMs = Date.parse(existingProps.slackBookmarkChangedAt || "");
        const isOrderTombstone = existingProps.kind === "slack_reaction_tombstone";
        if (Number.isFinite(previousMs) && (eventMs < previousMs || (eventMs === previousMs && !isOrderTombstone))) return;
        if (isOrderTombstone) {
          await blockDB.deleteBlock(existing.id);
          existing = null;
        }
      }
      if (existing) {
        const existingProps = existing.properties || {};
        const previousMs = Date.parse(existingProps.slackBookmarkChangedAt || "");
        if (existing.deleted_at) {
          if (typeof blockDB.undeleteBlock !== "function") return;
          const restored = await blockDB.undeleteBlock(existing.id);
          const restoredProps = restored.properties || {};
          const next = { ...restoredProps, status: restoredProps.status === "cancelled" ? "open" : restoredProps.status, slackBookmarkChangedAt: new Date(eventMs).toISOString() };
          delete next.startedAt;
          delete next.activeWorkSessionId;
          delete next.startedBy;
          if (JSON.stringify(next) !== JSON.stringify(restoredProps)) await blockDB.updateBlock(restored.id, { properties: next });
          await syncLinkedTriage({ ...restored, properties: next }, "scheduled", eventMs);
          broadcast("blocks-changed", { action: "slack-bookmark-restore", blockIds: [existing.id], date: existing.date }, OWNER_WORKSPACE_ID);
        } else if (!Number.isFinite(previousMs) || eventMs > previousMs) {
          await blockDB.updateBlock(existing.id, { properties: { ...existingProps, slackBookmarkChangedAt: new Date(eventMs).toISOString() } });
        }
        await applyPendingDoneIntent(channel, ts);
        return;
      }

      // A completed delegate can exist before this queued bookmark event runs.
      // Move bookmark ownership onto its canonical task instead of creating a
      // second open row beside completed work. Bookmark removal transfers it back.
      const completedDelegate = await findLiveTaskByKey(delegateKeyFor(channel, ts));
      const completedDelegateProps = (completedDelegate && completedDelegate.properties) || {};
      if (completedDelegate && (completedDelegateProps.status === "done" || completedDelegateProps.completedAt)) {
        const delegateTask = await linkedDelegateTask(completedDelegate);
        if (delegateTask) {
          const transferredProps = {
            ...(delegateTask.properties || {}),
            source: "slack-bookmark",
            idempotency_key: idemKey,
            delegatedItemId: completedDelegate.id,
            ...(!recovery && { slackBookmarkChangedAt: new Date(eventMs).toISOString() }),
          };
          await blockDB.updateBlock(delegateTask.id, { properties: transferredProps });
          broadcast("blocks-changed", {
            action: "slack-bookmark-claim-delegate-task",
            blockIds: [delegateTask.id, completedDelegate.id],
            date: delegateTask.date,
          }, OWNER_WORKSPACE_ID);
          await applyPendingDoneIntent(channel, ts);
          return;
        }
      }
      const date = getTodayStr();
      const seedCapture = seed && seed.text ? normalizeSlackMessage(seed, { ts }) : null;
      const capture = seedCapture || { ts, threadTs: ts, text: "", user: "unknown", channelName: "slack", permalink: slackPermalink(SLACK_HOST, channel, ts) };
      capture.permalink = capture.permalink || slackPermalink(SLACK_HOST, channel, ts);
      const captured = captureProperties("bookmark", channel, ts, capture);
      const props = {
        ...captured,
        status: "open", kind: "task",
        estimatedMinutes: NO_HOURGLASS_MIN,
        priority: "Medium",
        source: "slack-bookmark", created_by: "slack-events",
        created_at: new Date().toISOString(),
        ...(!recovery && { slackBookmarkChangedAt: new Date(eventMs).toISOString() }),
        start: "09:00", end: addMin("09:00", NO_HOURGLASS_MIN),
        idempotency_key: idemKey,
      };
      const created = await blockDB.createItineraryTask({ date, properties: props, userId: OWNER_USER_ID, workspaceId: OWNER_WORKSPACE_ID, score: true });
      broadcast("blocks-changed", { action: "slack-bookmark-create", blockIds: [created.id], date }, OWNER_WORKSPACE_ID);
      let block = { id: created.id, date, properties: props, workspace_id: OWNER_WORKSPACE_ID };
      if (!seedCapture) {
        try { block = await refreshCapture(block, "bookmark"); }
        catch (error) { console.warn(`[slack-events] message capture retry for ${channel}:${ts}:`, error.message); }
      }
      await enrichBlock(block);
      await applyPendingDoneIntent(channel, ts);
    }

    async function waitingTarget(item, client) {
      const own = slackTarget(item.properties, SLACK_HOST);
      if (own) return own;
      const ref = (item.properties || {}).linkedBlockId;
      if (!ref) return null;
      const linked = await blockDB.findUniqueLiveBlockByReference(ref, OWNER_WORKSPACE_ID, client);
      if (!linked || linked.deleted_at || String(linked.workspace_id) !== String(OWNER_WORKSPACE_ID)) return null;
      return slackTarget(linked.properties, SLACK_HOST);
    }

    async function linkedWaitingForMessage(channel, ts, includeDeleted = false, client = pool) {
      // SQL excludes only explicit mismatches. The JS resolver owns URL parsing
      // and target precedence, and ambiguity is checked before filtering by target.
      const coordinates = alias => `jsonb_build_object(
        'slack_channel', ${alias}.properties->'slack_channel', 'slack_ts', ${alias}.properties->'slack_ts',
        'contact', jsonb_build_object('sourceRef', ${alias}.properties->'contact'->'sourceRef'),
        'source_id', ${alias}.properties->'source_id', 'sourceRef', ${alias}.properties->'sourceRef',
        'source_url', ${alias}.properties->'source_url', 'slack_url', ${alias}.properties->'slack_url',
        'permalink', ${alias}.properties->'permalink')`;
      const candidates = alias => `(NOT COALESCE(${alias}.properties->>'slack_channel' ~ '^[CDG][A-Z0-9]+$'
          AND ${alias}.properties->>'slack_ts' ~ '^[0-9]+[.][0-9]+$', false)
          OR (${alias}.properties->>'slack_channel' = $3 AND ${alias}.properties->>'slack_ts' = $4))`;
      const { rows } = await sweepMetrics.phase("waiting", () => client.query(`
        SELECT w.id, w.workspace_id, w.deleted_at, ${coordinates("w")}
          || jsonb_build_object('source', w.properties->'source', 'status', w.properties->'status',
             'completedAt', w.properties->'completedAt') AS properties,
          linked.targets AS slack_linked_targets
        FROM blocks w
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(t.target) AS targets, count(*) AS matches,
                 bool_or(t.possible) AS possible FROM (
            SELECT ${coordinates("b")} AS target, ${candidates("b")} AS possible
            FROM blocks b
            WHERE b.workspace_id = w.workspace_id
              AND (b.id = w.properties->>'linkedBlockId'
                OR b.properties->>'local_id' = w.properties->>'linkedBlockId')
              AND b.deleted_at IS NULL
            LIMIT 2
          ) t
        ) linked ON true
        WHERE w.workspace_id = $1 AND w.properties->>'kind' = 'delegated_item'
          AND ($2::boolean OR w.deleted_at IS NULL)
          AND ${candidates("w")}
          AND (
            (w.properties->>'slack_channel' = $3 AND w.properties->>'slack_ts' = $4)
            OR w.properties->'contact'->'sourceRef' IS NOT NULL
            OR w.properties ?| ARRAY['source_id','sourceRef','source_url','slack_url','permalink']
            OR (linked.matches = 1 AND linked.possible)
          )
      `, [OWNER_WORKSPACE_ID, includeDeleted, channel, ts]));
      return rows.filter(item => {
        const targets = item.slack_linked_targets || [];
        const target = slackTarget(item.properties, SLACK_HOST)
          || (targets.length === 1 ? slackTarget(targets[0], SLACK_HOST) : null);
        return String(item.workspace_id) === String(OWNER_WORKSPACE_ID) && sameTarget(target, { channel, ts });
      });
    }

    async function isLinkedWaitingEcho(channel, ts) {
      const bookmark = await findLiveTaskByKey(keyFor(channel, ts));
      if ((bookmark && bookmark.properties || {}).slackWaitingManaged) return true;
      return (await linkedWaitingForMessage(channel, ts, true)).some(item =>
        (item.properties || {}).source !== "slack-delegate" || (item.properties || {}).status === "unblocked");
    }

    async function handleDelegate(channel, ts, seed, eventMs = Date.now(), recovery = false) {
      if (await isLinkedWaitingEcho(channel, ts)) return;
      const idemKey = delegateKeyFor(channel, ts);
      let existing = await findTaskByKey(idemKey);
      if (existing && recovery) return;
      if (existing) {
        const existingProps = existing.properties || {};
        const previousMs = Date.parse(existingProps.slackDelegateChangedAt || "");
        const isOrderTombstone = existingProps.kind === "slack_reaction_tombstone";
        if (Number.isFinite(previousMs) && (eventMs < previousMs || (eventMs === previousMs && !isOrderTombstone))) return;
        if (isOrderTombstone) {
          await blockDB.deleteBlock(existing.id);
          existing = null;
        }
      }
      if (existing) {
        const existingProps = existing.properties || {};
        const previousMs = Date.parse(existingProps.slackDelegateChangedAt || "");
        if (existing.deleted_at) {
          if (typeof ctx.restoreWaitingCluster !== "function") return;
          await ctx.restoreWaitingCluster({
            itemId: existing.id,
            restoredAt: new Date(eventMs).toISOString(),
            workspaceId: OWNER_WORKSPACE_ID,
            broadcastAction: "slack-delegate-restore",
          });
        } else if (!Number.isFinite(previousMs) || eventMs > previousMs) {
          await blockDB.updateBlock(existing.id, { properties: {
            ...existingProps,
            slackDelegateChangedAt: new Date(eventMs).toISOString(),
          } });
        }
        await applyPendingDoneIntent(channel, ts);
        return;
      }
      const seedCapture = seed && seed.text ? normalizeSlackMessage(seed, { ts }) : null;
      const capture = seedCapture || { ts, threadTs: ts, text: "", user: "unknown", channelName: "slack", permalink: slackPermalink(SLACK_HOST, channel, ts) };
      capture.permalink = capture.permalink || slackPermalink(SLACK_HOST, channel, ts);
      const captured = captureProperties("delegate", channel, ts, capture);
      let props = {
        ...captured,
        title: "",
        myTask: captured.captureTitle,
        kind: "delegated_item",
        waitingReason: "delegated",
        status: "open",
        checkInMode: "date",
        checkInDate: addCalendarDays(getTodayStr(), 1),
        checkInDays: 1,
        idempotency_key: idemKey,
        created_by: "slack-events",
        created_at: new Date().toISOString(),
        ...(!recovery && { slackDelegateChangedAt: new Date(eventMs).toISOString() }),
      };
      props = stampDelegateSnapshot(props);
      const created = await blockDB.createBlock({
        type: "block", parent_id: null, date: null, properties: props,
        user_id: OWNER_USER_ID, workspace_id: OWNER_WORKSPACE_ID,
      });
      broadcast("blocks-changed", { action: "slack-delegate-create", blockIds: [created.id] }, OWNER_WORKSPACE_ID);
      let block = { id: created.id, date: null, properties: props, workspace_id: OWNER_WORKSPACE_ID };
      if (!seedCapture) {
        try { block = await refreshCapture(block, "delegate"); }
        catch (error) { console.warn(`[slack-events] delegate capture retry for ${channel}:${ts}:`, error.message); }
      }
      await enrichBlock(block);

      // Events for one Slack message are serialized. A ✅ queued before this 👥
      // cannot see the future Waiting row, so reconcile the late capture here.
      // Reuse the completed bookmark task and do not award its credit twice.
      const bookmark = await findLiveTaskByKey(keyFor(channel, ts));
      const bookmarkProps = (bookmark && bookmark.properties) || {};
      if (bookmark && (bookmarkProps.status === "done" || bookmarkProps.completedAt)) {
        if (typeof ctx.completeWaitingItem !== "function") throw new Error("Waiting completion service is unavailable");
        await ctx.completeWaitingItem({
          itemId: created.id,
          linkedTaskRef: bookmark.id,
          completedAt: bookmarkProps.completedAt || bookmarkProps.doneAt || new Date(eventMs).toISOString(),
          completedBy: "slack-events",
          userId: OWNER_USER_ID,
          workspaceId: OWNER_WORKSPACE_ID,
          broadcastAction: "slack-delegate-late-capture-done",
        });
      }
      await applyPendingDoneIntent(channel, ts);
    }

    // A Waiting item is not itself an itinerary task. When ✅ closes a delegate,
    // materialize one normal task on today, then let the canonical Waiting service
    // complete both rows together. A bookmark on the same message is reused instead.
    async function ensureDelegateCompletionTask(item, channel, ts) {
      const idemKey = delegateCompletionKeyFor(channel, ts);
      const existing = await findLiveTaskByKey(idemKey);
      if (existing) return existing;
      const itemProps = item.properties || {};
      const duration = Math.max(1, Number(itemProps.estimatedMinutes || itemProps.duration || itemProps.durMin) || NO_HOURGLASS_MIN);
      const date = getTodayStr();
      const title = itemProps.myTask || itemProps.aiTitle || itemProps.captureTitle || itemProps.title || "Delegated Slack task";
      const props = {
        title,
        kind: "task",
        status: "open",
        estimatedMinutes: duration,
        priority: itemProps.priority || "Medium",
        source: "slack-delegate-completion",
        source_id: itemProps.source_id || "",
        notes: itemProps.notes || itemProps.captureNotes || "Delegated from Slack",
        contact: itemProps.contact || undefined,
        slack_channel: channel,
        slack_ts: ts,
        slack_thread_ts: itemProps.slack_thread_ts || ts,
        delegatedItemId: item.id,
        created_by: "slack-events",
        created_at: new Date().toISOString(),
        start: "09:00",
        end: addMin("09:00", duration),
        idempotency_key: idemKey,
      };
      const created = await blockDB.createItineraryTask({
        date, properties: props, userId: OWNER_USER_ID, workspaceId: OWNER_WORKSPACE_ID, score: true,
      });
      return (await blockDB.getBlock(created.id))
        || { id: created.id, date, type: "block", properties: props, workspace_id: OWNER_WORKSPACE_ID, user_id: OWNER_USER_ID };
    }

    async function linkedDelegateTask(item) {
      const linkedRef = String(((item && item.properties) || {}).linkedBlockId || "").trim();
      if (!linkedRef) return null;
      const task = await blockDB.findUniqueLiveBlockByReference(linkedRef, OWNER_WORKSPACE_ID);
      return task && !task.deleted_at && (task.properties || {}).kind !== "slack_reaction_tombstone"
        ? task
        : null;
    }

    async function handleDelegateRemoved(channel, ts, eventMs = Date.now()) {
      if (await isLinkedWaitingEcho(channel, ts)) return;
      const item = await findLiveTaskByKey(delegateKeyFor(channel, ts));
      if (!item) {
        const existing = await findTaskByKey(delegateKeyFor(channel, ts));
        if (existing) {
          const props = existing.properties || {};
          const previousMs = Date.parse(props.slackDelegateChangedAt || "");
          if (!Number.isFinite(previousMs) || eventMs > previousMs) {
            if (typeof blockDB.updateDeletedBlockProperties !== "function") {
              throw new Error("Deleted Waiting ordering service is unavailable");
            }
            await blockDB.updateDeletedBlockProperties(existing.id, {
              ...props,
              slackDelegateChangedAt: new Date(eventMs).toISOString(),
            }, OWNER_WORKSPACE_ID);
          }
          return;
        }
        await createReactionTombstone("delegate", channel, ts, eventMs);
        return;
      }
      const props = item.properties || {};
      const previousMs = Date.parse(props.slackDelegateChangedAt || "");
      if (Number.isFinite(previousMs) && eventMs < previousMs) return;
      if (typeof ctx.deleteWaitingCluster !== "function") throw new Error("Waiting deletion service is unavailable");
      await ctx.deleteWaitingCluster({
        itemId: item.id,
        deletedAt: new Date(eventMs).toISOString(),
        workspaceId: OWNER_WORKSPACE_ID,
        broadcastAction: "slack-delegate-cancel",
      });
      const bookmark = await findLiveTaskByKey(keyFor(channel, ts));
      if (bookmark) await projectTaskToSlack(bookmark);
      else await removeUnownedWorkReactions(channel, ts, [R_START, R_DONE]);
    }

    async function removeUnownedWorkReactions(channel, ts, names, completedDelegateOnly = false) {
      if (await loadReactionCooldown()) return;
      await withProjectionLock(`${OWNER_WORKSPACE_ID}:${channel}:${ts}`, async client => {
        if (receiptsAvailable) {
          const bookmark = await findLiveTaskByKey(keyFor(channel, ts), client);
          const task = await findLiveTaskByKey(delegateCompletionKeyFor(channel, ts), client);
          const delegate = await findLiveTaskByKey(delegateKeyFor(channel, ts), client);
          if (bookmark || task) return;
          if (completedDelegateOnly ? !isBlockDone(delegate, null) : delegate) return;
        }
        for (const name of names) await removeSlackReaction(channel, ts, name, client);
      });
    }

    // Removing Slack's bookmark removes the canonical DCC task too. If it is
    // active, settle that session first so deleting the task never loses work.
    async function handleBookmarkRemoved(channel, ts, eventMs = Date.now()) {
      const idemKey = keyFor(channel, ts);
      const task = await findLiveTaskByKey(idemKey);
      if (!task) {
        const existing = await findTaskByKey(idemKey);
        if (existing && existing.deleted_at && (existing.properties || {}).kind !== "slack_reaction_tombstone") return;
        if (existing && (existing.properties || {}).kind === "slack_reaction_tombstone") {
          const props = existing.properties || {};
          const previousMs = Date.parse(props.slackBookmarkChangedAt || "");
          if (!Number.isFinite(previousMs) || eventMs > previousMs) {
            await blockDB.updateBlock(existing.id, { properties: { ...props, slackBookmarkChangedAt: new Date(eventMs).toISOString() } });
          }
          return;
        }
        await createReactionTombstone("bookmark", channel, ts, eventMs);
        return;
      }
      const props = task.properties || {};
      const previousMs = Date.parse(props.slackBookmarkChangedAt || "");
      if (Number.isFinite(previousMs) && eventMs < previousMs) return;
      if (isStaleWorkEvent(props, eventMs)) return;
      const delegate = await findLiveTaskByKey(delegateKeyFor(channel, ts));
      const delegateProps = (delegate && delegate.properties) || {};
      if (delegate && String(delegateProps.linkedBlockId || "") === String(task.id)) {
        const transferredProps = {
          ...props,
          source: "slack-delegate-completion",
          idempotency_key: delegateCompletionKeyFor(channel, ts),
          delegatedItemId: delegate.id,
          slackBookmarkChangedAt: new Date(eventMs).toISOString(),
        };
        const transferred = await blockDB.updateBlock(task.id, { properties: transferredProps });
        await projectTaskToSlack({ ...task, properties: (transferred && transferred.properties) || transferredProps });
        broadcast("blocks-changed", {
          action: "slack-bookmark-transfer-to-delegate",
          blockIds: [task.id, delegate.id],
          date: task.date,
        }, OWNER_WORKSPACE_ID);
        return;
      }
      const removedProps = { ...props, slackBookmarkChangedAt: new Date(eventMs).toISOString() };
      const stamped = await blockDB.updateBlock(task.id, { properties: removedProps });
      task.properties = stamped && stamped.properties ? stamped.properties : removedProps;
      if ((task.properties || {}).startedAt) {
        await pauseWork({ block: task, atMs: eventMs, actor: "slack", actionId: `bookmark-remove:${channel}:${ts}:${eventMs}` });
      }
      await blockDB.deleteBlock(task.id);
      await syncLinkedTriage(task, "release", eventMs);
      if (receiptsAvailable) await projectTaskToSlack(task);
      else {
        await removeSlackReaction(channel, ts, R_START);
        await removeSlackReaction(channel, ts, R_DONE);
      }
      broadcast("blocks-changed", { action: "slack-bookmark-cancel", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
    }

    // ── ⌛ start ────────────────────────────────────────────────────────────
    async function taskForWorkReaction(channel, ts) {
      const rows = await findReactedRowsWithRetry(channel, ts);
      const linked = rows.delegate && await linkedDelegateTask(rows.delegate);
      if (linked) return linked;
      const delegateProps = (rows.delegate && rows.delegate.properties) || {};
      if (rows.delegate && (delegateProps.status === "done" || delegateProps.completedAt)) return null;
      if (rows.bookmark) {
        if (rows.delegate) {
          const props = rows.delegate.properties || {};
          if (String(props.linkedBlockId || "") !== String(rows.bookmark.id)) {
            await blockDB.updateBlock(rows.delegate.id, { properties: { ...props, linkedBlockId: rows.bookmark.id } });
          }
        }
        return rows.bookmark;
      }
      if (!rows.delegate) return null;
      let task = await findLiveTaskByKey(delegateCompletionKeyFor(channel, ts));
      if (!task) task = await ensureDelegateCompletionTask(rows.delegate, channel, ts);
      const props = rows.delegate.properties || {};
      if (String(props.linkedBlockId || "") !== String(task.id)) {
        await blockDB.updateBlock(rows.delegate.id, { properties: { ...props, linkedBlockId: task.id } });
      }
      return task;
    }

    async function handleStart(channel, ts, eventMs, actionId = null) {
      const task = await taskForWorkReaction(channel, ts);
      if (!task) {
        const delegate = await findLiveTaskByKey(delegateKeyFor(channel, ts));
        if (delegate && isBlockDone(delegate, null)) await removeUnownedWorkReactions(channel, ts, [R_START], true);
        else console.warn(`[slack-events] ⌛ with no task for ${channel}:${ts} — ignored`);
        return;
      }
      const started = await startWork({ block: task, atMs: eventMs, actor: "slack", actionId: actionId || `${channel}:${ts}:${eventMs}` });
      if (!started.changed && (started.reason === "not-trackable" || started.reason === "completed")) {
        if (receiptsAvailable) await projectTaskToSlack(task);
        else await removeSlackReaction(channel, ts, R_START);
      }
      broadcast("blocks-changed", { action: "slack-start", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
    }

    // ── ⌛ removed → clear a not-yet-completed start ──────────────────────────
    async function clearStart(channel, ts, eventMs = Date.now(), actionId = null) {
      const rows = await findReactedRowsWithRetry(channel, ts);
      const task = (rows.delegate && await linkedDelegateTask(rows.delegate))
        || rows.bookmark
        || await findLiveTaskByKey(delegateCompletionKeyFor(channel, ts));
      if (!task) return;
      await pauseWork({ block: task, atMs: eventMs, actor: "slack", actionId });
      broadcast("blocks-changed", { action: "slack-start-clear", blockIds: [task.id], date: task.date }, OWNER_WORKSPACE_ID);
    }

    async function awardSlackCompletion(task, fallbackCompletedIso) {
      const finalProps = task.properties || {};
      const title = finalProps.title || "Slack task";
      try {
        await slotStore.earnTaskCredit(OWNER_WORKSPACE_ID, OWNER_USER_ID, {
          source_key: creditKeyFor(task),
          task_id: task.id, title, type: finalProps.type || "task", tags: finalProps.tags || [],
          priority: finalProps.priority || "",
          duration_minutes: finalProps.estimatedMinutes || NO_HOURGLASS_MIN,
          points_duration_minutes: finalProps.pointsDurationMinutes || undefined,
          actual_minutes: finalProps.actualMinutes || 0,
          completed_at: finalProps.completedAt || fallbackCompletedIso,
        });
      } catch (e) { console.error("[slack-events] credit failed (non-fatal):", e.message); }
    }

    // ── ✅ complete ───────────────────────────────────────────────────────────
    async function handleDone(channel, ts, eventMs, actionId = null) {
      const rows = await findReactedRowsWithRetry(channel, ts, 1);
      if (!rows.bookmark && !rows.delegate) {
        await createPendingDoneIntent(channel, ts, eventMs);
        return;
      }
      const completedIso = new Date(eventMs).toISOString();

      // 👥 is the primary lifecycle when both capture reactions exist. Reuse the
      // bookmark task if present, which prevents two itinerary rows and two credits.
      if (rows.delegate) {
        const delegateProps = rows.delegate.properties || {};
        if (delegateProps.status === "done" || delegateProps.completedAt) return;
        if (typeof ctx.completeWaitingItem !== "function") throw new Error("Waiting completion service is unavailable");
        const task = await linkedDelegateTask(rows.delegate)
          || rows.bookmark
          || await ensureDelegateCompletionTask(rows.delegate, channel, ts);
        const result = await ctx.completeWaitingItem({
          itemId: rows.delegate.id,
          linkedTaskRef: task.id,
          completedAt: completedIso,
          completedBy: "slack-events",
          userId: OWNER_USER_ID,
          workspaceId: OWNER_WORKSPACE_ID,
          broadcastAction: "slack-delegate-done",
        });
        await awardSlackCompletion(result.task || task, completedIso);
        await syncLinkedTriage(result.task || task, "done", eventMs);
        return;
      }

      const task = rows.bookmark;
      const props = task.properties || {};
      if (props.completedAt) return;   // already done (Slack retry), idempotent
      const mutationId = completionMutationId(actionId || completedIso, task.id, "complete");
      const durable = await blockDB.setTaskCompletion({
        taskRef: task.id,
        completed: true,
        completedAt: completedIso,
        taskDate: task.date || null,
        mutationId,
        expectedRevision: props._completionRevision || null,
        userId: OWNER_USER_ID,
        workspaceId: OWNER_WORKSPACE_ID,
      });
      const canonical = durable.task || task;
      const completion = await completeWork({ block: canonical, atMs: eventMs, actor: "slack-events", actionId: mutationId, normalizeExisting: true });
      if (!completion.changed && !durable.duplicate) return;
      // Completion owns the active-work cleanup on both surfaces. completeWork
      // closes the DCC session; remove the matching Slack signal immediately.
      // The reconciliation loop remains the retry path if this write cannot land.
      if (receiptsAvailable) await projectTaskToSlack(canonical);
      else await removeSlackReaction(channel, ts, R_START);
      await awardSlackCompletion(canonical, completedIso);
      await syncLinkedTriage(canonical, "done", eventMs);

      broadcast("blocks-changed", {
        action: "slack-done",
        blockIds: durable.broadcastIds || [task.id],
        dependencyTransitions: durable.dependencyTransitions || [],
        date: task.date,
      }, OWNER_WORKSPACE_ID);
    }

    // ── ✅ removed → un-complete ──────────────────────────────────────────────
    //
    // v1 ignored this, so a mis-check was stuck done forever with the points banked.
    // The full inverse of handleDone, in the same order, so nothing is left half-done:
    // reopen the row, drop the timing, reverse the credit, restore the queue.
    async function handleUndone(channel, ts, eventMs = Date.now(), actionId = null) {
      const pending = await findLiveTaskByKey(pendingDoneKeyFor(channel, ts));
      if (pending) await cancelPendingDoneIntent(channel, ts, eventMs);
      const [bookmark, delegate] = await Promise.all([
        findLiveTaskByKey(keyFor(channel, ts)),
        findLiveTaskByKey(delegateKeyFor(channel, ts)),
      ]);
      const delegateProps = (delegate && delegate.properties) || {};
      const reopenDelegate = !!delegate && (delegateProps.status === "done" || !!delegateProps.completedAt);
      let task = bookmark;
      if (reopenDelegate) {
        task = await linkedDelegateTask(delegate)
          || await findLiveTaskByKey(delegateCompletionKeyFor(channel, ts))
          || bookmark;
      }
      if (!task && reopenDelegate) {
        if (isStaleWorkEvent(delegateProps, eventMs)) return;
        if (typeof ctx.reopenWaitingItem !== "function") throw new Error("Waiting reopen service is unavailable");
        await ctx.reopenWaitingItem({
          itemId: delegate.id,
          reopenedAt: new Date(eventMs).toISOString(),
          userId: OWNER_USER_ID,
          workspaceId: OWNER_WORKSPACE_ID,
          broadcastAction: "slack-delegate-undone",
        });
        return;
      }
      if (!task) {
        if (!pending) await cancelPendingDoneIntent(channel, ts, eventMs);
        return;
      }
      const props = task.properties || {};
      if (!props.completedAt) return;   // never completed by us (or a Slack retry) — idempotent
      if (isStaleWorkEvent(props, eventMs)) return;

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
      // rather than half-reversed. If this ran after reopening the row and failed, the
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

      let durable;
      if (reopenDelegate) {
        if (typeof ctx.reopenWaitingItem !== "function") throw new Error("Waiting reopen service is unavailable");
        const result = await ctx.reopenWaitingItem({
          itemId: delegate.id,
          taskRef: task.id,
          reopenedAt: new Date(eventMs).toISOString(),
          userId: OWNER_USER_ID,
          workspaceId: OWNER_WORKSPACE_ID,
          broadcastAction: "slack-delegate-undone",
        });
        durable = { task: result.task || task, broadcastIds: [delegate.id, task.id], dependencyTransitions: [] };
      } else {
        const mutationId = completionMutationId(actionId || eventMs, task.id, "reopen");
        durable = await blockDB.setTaskCompletion({
          taskRef: task.id,
          completed: false,
          completedAt: null,
          taskDate: task.date || null,
          mutationId,
          expectedRevision: props._completionRevision || null,
          userId: OWNER_USER_ID,
          workspaceId: OWNER_WORKSPACE_ID,
        });
        const canonical = durable.task || task;
        await reopenWork({ block: canonical, atMs: eventMs, actor: "slack-events", actionId: mutationId });
      }

      // Back into the active queue on the Slack side too (E2 reads 🔖 as the queue).
      if (bookmark) {
        if (receiptsAvailable) await projectTaskToSlack(durable.task || task);
        else await addSlackReaction(channel, ts, R_BOOKMARK);
      }
      await syncLinkedTriage(durable.task || task, "scheduled", eventMs);

      if (!reopenDelegate) {
        broadcast("blocks-changed", {
          action: "slack-undone",
          blockIds: durable.broadcastIds || [task.id],
          dependencyTransitions: durable.dependencyTransitions || [],
          date: task.date,
        }, OWNER_WORKSPACE_ID);
      }
    }

    // `hasmy:` is a USER-token search with no bot-token equivalent, which is why
    // this is the one call marked user_required. A bot-tier actor cannot run it at
    // all, so runReconciliation skips the sweep for them rather than logging a
    // failure every five minutes.
    async function searchPage(query, page) {
      if ((searchCooldowns.get(cooldownKey) || 0) > Date.now()) return null;
      try {
        return await slackApi("search.messages", { query, count: 100, sort: "timestamp", page }, {
          token: "user_required",
        });
      } catch (error) {
        if (error.code !== "ratelimited") throw error;
        const resumeAt = Date.now() + (error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS);
        searchCooldowns.set(cooldownKey, Math.max(searchCooldowns.get(cooldownKey) || 0, resumeAt));
        sweepMetrics.count("rateLimited");
        return null;
      }
    }

    async function searchSlack(query, history = false) {
      if (history) {
        const key = JSON.stringify([OWNER_WORKSPACE_ID, actorKey, query]);
        const today = new Date().toISOString().slice(0, 10);
        const state = historySearches.get(key) || { ranges: [{ before: today }], page: 1 };
        const range = state.ranges[0];
        const filter = range.on
          ? `on:${range.on}`
          : `before:${range.before}${range.after ? ` after:${range.after}` : ""}`;
        const result = await searchPage(`${query} ${filter}`, state.page);
        if (!result) return [];
        const pages = Number(result.messages?.paging?.pages || 1);
        if (pages > 100 && !range.on) {
          sweepMetrics.count("saturatedHistory");
          const dayMs = 86_400_000;
          const oldest = Date.parse(range.after || "2013-01-01");
          const newest = Date.parse(range.before);
          const middle = new Date(oldest + Math.floor((newest - oldest) / (2 * dayMs)) * dayMs)
            .toISOString().slice(0, 10);
          if (oldest < Date.parse(middle) && Date.parse(middle) < newest) {
            state.ranges.splice(0, 1, { ...range, before: middle }, { on: middle }, { ...range, after: middle });
          } else {
            state.ranges.splice(0, 1, { on: new Date(newest - dayMs).toISOString().slice(0, 10) });
          }
          state.page = 1;
        } else if (state.page < Math.min(pages, 100)) {
          state.page += 1;
        } else {
          if (pages > 100) sweepMetrics.count("saturatedHistory");
          state.ranges.shift();
          state.page = 1;
        }
        if (state.ranges.length) historySearches.set(key, state);
        else historySearches.delete(key);
        return result.messages?.matches || [];
      }
      const matches = [];
      const seen = new Set();
      let page = 1;
      let pages = 1;
      while (page <= pages && page <= 10) {
        const result = await searchPage(query, page);
        if (!result) break;
        const messages = result.messages || {};
        pages = Math.max(1, Number(messages.paging && messages.paging.pages || 1));
        for (const match of messages.matches || []) {
          const channel = match.channel && typeof match.channel === "object" ? match.channel.id : match.channel;
          const key = `${channel || ""}:${match.ts || ""}`;
          if (!channel || !match.ts || seen.has(key)) continue;
          seen.add(key);
          matches.push(match);
        }
        page += 1;
      }
      return matches;
    }

    async function refreshCapture(block, kind, seed) {
      const initialProps = block.properties || {};
      const seedChannel = seed && seed.channel && typeof seed.channel === "object"
        ? seed.channel.id
        : seed && seed.channel;
      const channel = String(initialProps.slack_channel || seedChannel || "");
      const ts = String(initialProps.slack_ts || seed && seed.ts || "");
      if (!channel || !ts) throw new Error("Slack capture coordinates were missing");
      const capture = await captureSlackMessage(channel, ts, seed);
      const captured = captureProperties(kind, channel, ts, capture);
      // Slack calls can take seconds. Re-read before merging so a UI edit made
      // during capture always wins over this delayed automation write.
      const latest = await blockDB.getBlock(block.id);
      if (!latest || latest.deleted_at || String(latest.workspace_id) !== String(OWNER_WORKSPACE_ID)) return block;
      const props = latest.properties || {};
      const displayField = kind === "delegate" ? "myTask" : "title";
      const currentTitle = props[displayField] || "";
      const canReplace = !currentTitle || currentTitle === props.captureTitle || currentTitle === "Slack task" || currentTitle === "Slack bookmark";
      const untouchedDelegate = kind === "delegate" && delegateIsUntouched(props);
      const merged = {
        ...props,
        ...captured,
        enrichment_attempts: Number(props.enrichment_attempts || 0),
        enrichment_status: "complete",
      };
      // `notes` and all delegated-item form fields are user-owned. Capture may
      // replace the generated notes only while the entire item remains pristine.
      const canReplaceNotes = !props.notes || (!!props.captureNotes && props.notes === props.captureNotes);
      if (!canReplaceNotes || (kind === "delegate" && !untouchedDelegate)) merged.notes = props.notes;
      if (kind === "delegate") merged.title = props.title || "";
      if (kind === "delegate" && !untouchedDelegate) merged.contact = props.contact;
      merged[displayField] = canReplace && (kind !== "delegate" || untouchedDelegate)
        ? captured.captureTitle
        : currentTitle;
      if (props.aiTitle) merged.aiTitle = props.aiTitle;
      if (props.aiSummary) merged.aiSummary = props.aiSummary;
      if (props.enriched_at) merged.enriched_at = props.enriched_at;
      const finalProps = untouchedDelegate ? stampDelegateSnapshot(merged) : merged;
      await blockDB.updateBlock(block.id, { properties: finalProps });
      return { ...latest, properties: finalProps };
    }

    function searchHit(kind, match) {
      const channel = String(match.channel?.id || match.channel || "");
      const ts = String(match.ts || "");
      if (!channel || !ts) return null;
      if (kind === "delegate" && Number(ts.split(".")[0]) * 1000 < DELEGATE_IMPORT_AFTER_MS) return null;
      return { match, channel, ts, idemKey: kind === "delegate" ? delegateKeyFor(channel, ts) : keyFor(channel, ts) };
    }

    async function reconcileMatches(kind, matches) {
      const hits = new Map();
      for (const match of matches) {
        const hit = searchHit(kind, match);
        if (hit && !hits.has(hit.idemKey)) hits.set(hit.idemKey, hit);
      }
      const keys = [...hits.keys()];
      sweepMetrics.count("keys", keys.length);
      for (let start = 0; start < keys.length; start += 100) {
        const batch = keys.slice(start, start + 100);
        const { rows } = await pool.query(`
          SELECT DISTINCT ON (properties->>'idempotency_key')
                 properties->>'idempotency_key' AS key,
                 deleted_at IS NOT NULL OR COALESCE(properties->>'kind' = 'slack_reaction_tombstone', false) AS blocked,
                 properties->>'capture_status' = 'captured'
                   AND COALESCE(properties->>'source_message_preview', '') <> '' AS captured,
                 properties->>'enrichment_status' = 'complete' AS enriched,
                 properties->>'enrichment_next_attempt_at' AS next_attempt
          FROM blocks
          WHERE workspace_id = $1 AND properties->>'idempotency_key' = ANY($2::text[])
          ORDER BY properties->>'idempotency_key', ${taskKeyPrecedence}
        `, [OWNER_WORKSPACE_ID, batch]);
        const byKey = new Map(rows.map(row => [row.key, row]));
        for (const key of batch) {
          const row = byKey.get(key);
          if (row?.blocked) continue;
          const enrichmentDue = row && !row.enriched
            && (!row.next_attempt || Date.parse(row.next_attempt) <= Date.now());
          if (row?.captured && !enrichmentDue) continue;
          await reconcileMatch(kind, hits.get(key).match);
        }
      }
      return hits.size;
    }

    async function reconcileMatch(kind, match) {
      const hit = searchHit(kind, match);
      if (!hit) return { skipped: true };
      return queueMessage(actor.slackUserId, hit.channel, hit.ts, () => reconcileHit(kind, hit));
    }

    async function reconcileHit(kind, { channel, ts, idemKey, match }) {
      let block = await findTaskByKey(idemKey);
      if (!block) {
        if (kind === "delegate") await handleDelegate(channel, ts, match, Date.now(), true);
        else await handleBookmark(channel, ts, match, Date.now(), true);
        return { created: true };
      }
      if (block.deleted_at || (block.properties || {}).kind === "slack_reaction_tombstone") return { skipped: true };
      if ((block.properties || {}).capture_status !== "captured" || !(block.properties || {}).source_message_preview) {
        try { block = await refreshCapture(block, kind, match); }
        catch (error) { console.warn(`[slack-events] capture retry still failing for ${idemKey}:`, error.message); }
      }
      const props = block.properties || {};
      const due = !props.enrichment_next_attempt_at || Date.parse(props.enrichment_next_attempt_at) <= Date.now();
      if (props.enrichment_status !== "complete" && due) await enrichBlock(block);
      return { updated: true };
    }

    async function retryPendingEnrichment(limit = 25) {
      const { rows } = await pool.query(
        `SELECT id
           FROM blocks
          WHERE workspace_id = $1
            AND deleted_at IS NULL
            AND properties->>'source' IN ('slack-bookmark', 'slack-delegate')
            AND COALESCE(properties->>'kind', '') <> 'slack_reaction_tombstone'
            AND COALESCE(properties->>'enrichment_status', 'pending') <> 'complete'
            AND (properties->>'enrichment_next_attempt_at' IS NULL
              OR properties->>'enrichment_next_attempt_at' <= TO_CHAR(
                NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ))
          ORDER BY created_at ASC
          LIMIT $2`,
        [OWNER_WORKSPACE_ID, limit]
      );
      let enriched = 0;
      for (const block of rows) if (await enrichBlock(block)) enriched += 1;
      return enriched;
    }

    async function projectTaskToSlack(block, repair = null) {
      sweepMetrics.count("projections");
      if (reactionPaused()) return false;
      if (!block || String(block.workspace_id || "") !== String(OWNER_WORKSPACE_ID || "")) return false;
      const p = block.properties || {};
      const delegatedItem = p.kind === "delegated_item";
      const bookmarkTask = p.source === "slack-bookmark";
      const delegateTask = p.source === "slack-delegate-completion";
      if (!delegatedItem && !bookmarkTask && !delegateTask) return false;
      if (await loadReactionCooldown()) return false;
      const target = delegatedItem ? await waitingTarget(block) : slackTarget(p, SLACK_HOST);
      if (!target) {
        if (repair) repair.ineligible = true;
        return false;
      }
      const queueKey = `${OWNER_WORKSPACE_ID}:${target.channel}:${target.ts}`;
      const previous = projectionQueues.get(queueKey) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => withProjectionLock(queueKey, async client => {
        if (reactionPaused()) return false;
        // Route arguments and mirror pages may have waited behind a newer change.
        // Always read the durable row inside the queue, never replay the snapshot.
        const fresh = await blockDB.getBlockIncludingDeleted(block.id, client);
        if (!fresh || String(fresh.workspace_id) !== String(OWNER_WORKSPACE_ID)) {
          if (repair) repair.ineligible = true;
          return false;
        }
        const props = fresh.properties || {};
        const currentTarget = props.kind === "delegated_item" ? await waitingTarget(fresh, client) : slackTarget(props, SLACK_HOST);
        if (!sameTarget(target, currentTarget)) return false;
        if (repair && fresh.deleted_at && props.kind === "slack_reaction_tombstone") {
          repair.ineligible = true;
          return false;
        }
        if (repair) repair.target = target;
        const items = await linkedWaitingForMessage(target.channel, target.ts, false, client);
        const markerIds = new Set((props.dependencyWaitingItemIds || [props.dependencyWaitingItemId]).filter(Boolean).map(String));
        const dependencies = [];
        for (const id of markerIds) {
          const item = await blockDB.getBlockIncludingDeleted(id, client);
          if (item && String(item.workspace_id) === String(OWNER_WORKSPACE_ID)) dependencies.push(item);
        }
        const waiting = items.concat(dependencies).some(item => !item.deleted_at && waitingItems.isOpen(item));
        const writes = [];
        const write = (name, add) => writes.push([name, add]);
        // 👥 is message-level Waiting membership. Multiple dependencies share it.
        const keepCapture = items.some(item => !item.deleted_at && item.properties.source === "slack-delegate" && item.properties.status !== "unblocked");
        if (items.length || props.kind === "delegated_item" || props.slackWaitingManaged || markerIds.size) {
          write(R_DELEGATE, waiting || keepCapture || (props.kind === "delegated_item" && !fresh.deleted_at &&
            (waitingItems.isOpen(fresh) || (props.source === "slack-delegate" && props.status !== "unblocked"))));
        }
        if (props.kind === "delegated_item") {
          // Captured delegates retain their completion mirror. Manually linked
          // Waiting rows let the real task own ✅, and unblocked is never done.
          if (props.source === "slack-delegate" && props.status !== "unblocked") {
            write(R_DONE, !fresh.deleted_at && isBlockDone(fresh, null));
          }
        } else {
          const done = !fresh.deleted_at && isBlockDone(fresh, null);
          const active = !fresh.deleted_at && !waiting && !done && !!props.startedAt;
          if (props.source === "slack-bookmark") write(R_BOOKMARK, !fresh.deleted_at);
          write(R_DONE, done);
          write(R_START, active);
        }
        let settled = true;
        for (const [name, add] of writes) {
          // No user parameter: Slack removes only the token owner's reaction.
          const ok = await (add ? addSlackReaction : removeSlackReaction)(target.channel, target.ts, name, client);
          settled = ok && settled;
          if (reactionPaused()) break;
        }
        return settled;
      }));
      projectionQueues.set(queueKey, next);
      try { return await next; }
      catch (error) { console.warn(`[slack-events] projection retry for ${block.id}:`, error.message); return false; }
      finally { if (projectionQueues.get(queueKey) === next) projectionQueues.delete(queueKey); }
    }

    async function withProjectionLock(key, project) {
      if (!receiptsAvailable) return project();
      const client = await pool.connect();
      let failure;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["slack-projection:" + key]);
        const result = await project(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        // Destroy a failed client so the pool releases its transaction lock.
        client.release(failure);
      }
    }

    async function mirrorDccCompletions() {
      if (!ANY_TOKEN) return 0;
      if (await loadReactionCooldown()) {
        sweepMetrics.count("cooldown");
        return 0;
      }
      if (!receiptsAvailable) return mirrorWithoutReceipts();

      const { rows } = await pool.query(candidatesSql, [OWNER_WORKSPACE_ID, actorKey, 20]);
      let mirrored = 0;
      for (const candidate of rows) {
        if (reactionPaused()) break;
        const repair = {};
        let settled = false;
        try {
          const block = await blockDB.getBlockIncludingDeleted(candidate.id);
          if (!block || String(block.workspace_id) !== String(OWNER_WORKSPACE_ID)
              || block.properties?.kind === "slack_reaction_tombstone") {
            repair.ineligible = true;
          } else {
            settled = await projectTaskToSlack(block, repair);
          }
        } catch {
          // Leave the revision retryable, including ambiguous links and query failures.
          console.warn("[slack-events] mirror candidate read or resolution failed");
        }
        const dead = repair.target && deadMessages.get(
          `${OWNER_WORKSPACE_ID}:${repair.target.channel}:${repair.target.ts}`);
        if (repair.ineligible) {
          sweepMetrics.count("ineligible");
          await saveReceipt(candidate.id, candidate.revision, "settled");
        } else if (settled && dead) {
          sweepMetrics.count("unreachable");
          await saveReceipt(candidate.id, candidate.revision, "unreachable", new Date(dead.at + DEAD_MESSAGE_TTL_MS));
        } else if (settled) {
          sweepMetrics.count("settled");
          await saveReceipt(candidate.id, candidate.revision, "settled");
          mirrored += 1;
        } else {
          sweepMetrics.count("retries");
          await saveReceipt(candidate.id, candidate.revision, "retry", new Date(
            Math.max(reactionCooldowns.get(cooldownKey) || 0, Date.now() + RECONCILE_MS)));
        }
      }
      return mirrored;
    }

    // Preserve recovery while running with the old schema.
    async function mirrorWithoutReceipts() {
      const cursor = mirrorCursors.get(OWNER_WORKSPACE_ID) || null;
      const { rows } = await pool.query(
        `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, properties, deleted_at, workspace_id, updated_at::text AS updated_at
          FROM blocks
          WHERE workspace_id = $1
            AND (properties->>'source' IN ('slack-bookmark', 'slack-delegate', 'slack-delegate-completion')
              OR properties->>'kind' = 'delegated_item')
            AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz
              OR (updated_at = $2::timestamptz AND id > $3))
          ORDER BY updated_at ASC, id ASC
          LIMIT $4`,
        [OWNER_WORKSPACE_ID, cursor && cursor.updatedAt, cursor && cursor.id || "", 20]
      );
      if (!rows.length) {
        mirrorCursors.delete(OWNER_WORKSPACE_ID);
        return 0;
      }
      let mirrored = 0;
      for (const block of rows) {
        const eligible = (block.properties || {}).kind === "delegated_item"
          ? await waitingTarget(block) : slackTarget(block.properties, SLACK_HOST);
        if (!eligible) continue;
        if (!await projectTaskToSlack(block)) return mirrored;
        mirrored += 1;
      }
      const last = rows[rows.length - 1];
      mirrorCursors.set(OWNER_WORKSPACE_ID, { updatedAt: last.updated_at, id: last.id });
      return mirrored;
    }

    return {
      actor,
      enrichBlock, reconcileMatch, reconcileMatches, refreshCapture, searchSlack,
      handleBookmark, handleBookmarkRemoved, handleDelegate, handleDelegateRemoved,
      handleStart, clearStart, handleDone, handleUndone,
      projectTaskToSlack, retryPendingEnrichment, mirrorDccCompletions,
    };
  }

  // The actor whose token should speak for a given workspace's rows. A workspace
  // nobody has linked returns null so the projection is skipped rather than
  // posted under the wrong person's name.
  async function forWorkspace(workspaceId) {
    const actor = await actors.actorForWorkspace(workspaceId);
    return actor ? forActor(actor) : null;
  }

  // Other route modules close over the shared ctx object. Publishing this
  // projector gives generic DCC mutations an immediate Slack side effect while
  // the periodic reconciliation remains the retry safety net.
  async function syncSlackTaskReactions(blockOrId) {
    const block = typeof blockOrId === "object" && blockOrId
      ? blockOrId
      : await blockDB.getBlockIncludingDeleted(blockOrId);
    if (!block) return false;
    const bound = await forWorkspace(block.workspace_id);
    return bound ? bound.projectTaskToSlack(block) : false;
  }
  ctx.syncSlackTaskReactions = syncSlackTaskReactions;
  // Published for GET /api/me/integrations (server.js), which needs the read-only
  // per-user link status without reaching into this route's internals.
  ctx.slackActors = actors;

  let reconciliationRunning = false;
  async function runReconciliation() {
    if (!measureSweep) return reconcile();
    const result = await sweepMetrics.withSweepMetrics(reconcile);
    console.info("[slack-events] reconciliation metrics", JSON.stringify(result.metrics));
    return result;
  }

  async function reconcile() {
    if (reconciliationRunning) return { skipped: "already_running" };
    reconciliationRunning = true;
    let lockClient = null;
    let locked = true;
    const stats = { bookmarks: 0, delegates: 0, enriched: 0, mirrored: 0, actors: 0 };
    try {
      // ONE global lock for the whole pass, not one per actor: the sweep is a
      // background repair, and serializing every tenant behind a single lock is
      // both cheaper and immune to a partial-lock ordering bug.
      if (typeof pool.connect === "function") {
        lockClient = await pool.connect();
        await lockClient.query("BEGIN");
        const lock = await lockClient.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [1_934_816_113]);
        locked = !!(lock.rows[0] && lock.rows[0].locked);
      }
      if (!locked) return { skipped: "lock_held" };

      await checkReceiptSchema();
      const roster = await actors.listActors();
      stats.actors = roster.length;
      if (!roster.length) {
        console.warn("[slack-events] no Slack identities are linked — nothing to reconcile");
        return { ...stats, skipped: "no_actors" };
      }

      for (const actor of roster) {
        const bound = forActor(actor);
        // hasmy: needs a user token AND `search:read`. Gating on token presence
        // alone was right when the only user token was Drake's legacy one, which
        // happens to carry search:read. A Tier 2 grant is deliberately minimal
        // (reactions only), so that actor HAS a token and still cannot search —
        // and without this check the sweep would fail missing_scope every five
        // minutes, per actor, forever. Unknown scopes stay permissive, so the env
        // identity keeps sweeping exactly as before. See makeActor.
        if (actors.actorHasScope(actor, "search:read")) {
          for (const [kind, query, stat] of [
            ["bookmark", "hasmy::bookmark:", "bookmarks"],
            ["delegate", "hasmy::busts_in_silhouette:", "delegates"],
          ]) {
            let matches = [];
            try {
              matches = await bound.searchSlack(query);
            } catch {
              console.warn(`[slack-events] ${kind} search failed`);
            }
            try {
              matches.push(...await bound.searchSlack(query, true));
            } catch {
              console.warn(`[slack-events] ${kind} history repair failed`);
            }
            try {
              stats[stat] += await sweepMetrics.phase("lookup", () => bound.reconcileMatches(kind, matches));
            } catch {
              console.warn(`[slack-events] ${kind} reconciliation failed`);
            }
          }
        }

        try { stats.enriched += await bound.retryPendingEnrichment(); }
        catch (error) { console.error(`[slack-events] enrichment retry failed for user ${actor.userId}:`, error.message); }

        try { stats.mirrored += await sweepMetrics.phase("mirror", bound.mirrorDccCompletions); }
        catch (error) { console.error(`[slack-events] completion mirror failed for user ${actor.userId}:`, error.message); }
      }
      return stats;
    } finally {
      if (lockClient) {
        let rollbackError;
        try { await lockClient.query("ROLLBACK"); }
        catch (error) { rollbackError = error; }
        lockClient.release(rollbackError);
      }
      reconciliationRunning = false;
    }
  }

  // ── dispatch ────────────────────────────────────────────────────────────
  const messageQueues = new Map();
  let warnedUnconfigured = false;
  function enqueueEvent(ev, teamId) {
    return queueMessage(ev?.user, ev?.item?.channel, ev?.item?.ts, () => processEvent(ev, teamId));
  }

  function queueMessage(user, channel, ts, work) {
    const key = channel && ts ? `${user || "?"}:${channel}:${ts}` : "unkeyed";
    const previous = messageQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    messageQueues.set(key, next);
    return next.finally(() => {
      if (messageQueues.get(key) === next) messageQueues.delete(key);
    });
  }

  async function processEvent(ev, teamId) {
    if (ev.type !== "reaction_added" && ev.type !== "reaction_removed") return;
    if (!ev.item || ev.item.type !== "message") return;

    // FAIL CLOSED on a reactor we cannot resolve, the way verifySlack fails closed
    // on a missing signing secret. The old gate was a single env var, and when it
    // was unset the route processed EVERY workspace member's reactions: handleUndone
    // deletes ledger rows and moves a real points balance, and addSlackReaction
    // writes to Slack with a personal user token, so an unset var handed any member
    // a react-as-someone-else primitive. Resolution is now per person and an
    // unresolved reactor gets nothing, so there is no config value that can widen
    // this to everybody.
    const actor = await actors.resolveActor(ev.user, teamId);
    if (!actor) {
      if (!warnedUnconfigured && !actors.envActor() && !actors.hasBotToken()) {
        warnedUnconfigured = true;
        console.error("[slack-events] no env identity and no SLACK_BOT_TOKEN — every reaction will be ignored");
      }
      return;
    }
    if (receiptsAvailable === null && typeof pool.connect === "function") await checkReceiptSchema();
    const bound = forActor(actor);

    const { channel, ts } = ev.item;
    const eventMs = Math.round(Number(ev.event_ts) * 1000) || Date.now();
    const actionId = ev._eventId || `${ev.type}:${channel}:${ts}:${ev.reaction}:${ev.event_ts || eventMs}`;
    if (ev.type === "reaction_removed") {
      if (ev.reaction === R_START) return bound.clearStart(channel, ts, eventMs, actionId);
      if (ev.reaction === R_BOOKMARK) return bound.handleBookmarkRemoved(channel, ts, eventMs);
      if (ev.reaction === R_DELEGATE) return bound.handleDelegateRemoved(channel, ts, eventMs);
      if (ev.reaction === R_DONE) return bound.handleUndone(channel, ts, eventMs, actionId);
      return;
    }
    if (ev.reaction === R_BOOKMARK) return bound.handleBookmark(channel, ts, null, eventMs);
    if (ev.reaction === R_DELEGATE) return bound.handleDelegate(channel, ts, null, eventMs);
    if (ev.reaction === R_START) return bound.handleStart(channel, ts, eventMs, actionId);
    if (ev.reaction === R_DONE) return bound.handleDone(channel, ts, eventMs, actionId);
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
      // team_id rides on the envelope, not the event, and auto-linking needs it to
      // decide whether this workspace is allowed to claim a DCC account at all.
      const teamId = body.team_id
        || (body.authorizations && body.authorizations[0] && body.authorizations[0].team_id)
        || null;
      enqueueEvent({ ...body.event, _eventId: body.event_id || null }, teamId)
        .catch(e => console.error("[slack-events] process failed:", e && e.message));
    }
  });

  app.post("/api/dcc/slack-reconcile", async (_req, res) => {
    try { res.json({ ok: true, ...(await runReconciliation()) }); }
    catch (error) { console.error("[slack-events] manual reconcile failed:", error.message); res.status(503).json({ ok: false, error: error.message }); }
  });

  if (RECONCILE_ENABLED) {
    const first = setTimeout(() => runReconciliation().catch((e) => console.error("[slack-events] startup reconcile failed:", e.message)), 15_000);
    const interval = setInterval(() => runReconciliation().catch((e) => console.error("[slack-events] reconcile failed:", e.message)), RECONCILE_MS);
    if (typeof first.unref === "function") first.unref();
    if (typeof interval.unref === "function") interval.unref();
  }

  return {
    fallbackTitle,
    runReconciliation,
    actors,
    // Manual / test surface. `enrichBlock` binds to the block's own workspace so a
    // manual call cannot enrich one person's task using another's token;
    // `reconcileMatch` has no block to key off yet, so it runs as the env actor.
    enrichBlock: async (blockOrId) => {
      const block = typeof blockOrId === "string" ? await blockDB.getBlock(blockOrId) : blockOrId;
      if (!block) return false;
      const bound = await forWorkspace(block.workspace_id);
      return bound ? bound.enrichBlock(block) : false;
    },
    reconcileMatch: async (kind, match) => {
      const envIdentity = actors.envActor();
      if (!envIdentity) return { skipped: true };
      return forActor(envIdentity).reconcileMatch(kind, match);
    },
  };
};
