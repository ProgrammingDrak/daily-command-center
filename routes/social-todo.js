// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { APP_TIME_ZONE, DAY_STATE_FILE, auth, badRequest, blockDB, broadcast, buildDayResponse, buildSkeletonState, capabilities, coerceDateString, crypto, filterLegacyGcalBlocks, getDayFilePath, getRequestOrigin, getTodayStr, intParam, isValidDate, notFound, path, pool, readJSON, route, scoreTaskPoints, session, slotStore, socialStore, updateManifest, writeJSON } = ctx;

// The ONE serializer behind both export surfaces (this route and the browser
// download in public/js/public-todo-share.js). Pure + UMD, so requiring the
// browser file here is deliberate, not a layering accident.
const shareExport = require("../public/js/share-export.js");

// ── Live Todo Share API ──
function makeShareToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function todoShareUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/todo/${token}`;
}

function centsFromBody(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 100), 1000000);
}

function todoActorKey(req) {
  if (req.session?.userId) return `user:${req.session.userId}`;
  const raw = [
    getRequestOrigin(req),
    String(req.headers["user-agent"] || "").slice(0, 300),
    req.sessionID || ""
  ].join("|");
  return "guest:" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function localHHMMFromDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.hour || "09"}:${parts.minute || "00"}`;
}


function nextQuarterHHMM() {
  const [h, m] = localHHMMFromDate().split(":").map(Number);
  const rounded = Math.min(Math.ceil((h * 60 + m) / 15) * 15, 23 * 60 + 45);
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

async function ensureTodoShareTables() {
  await slotStore.ensureSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todo_shares (
      id             SERIAL PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
      token          TEXT NOT NULL UNIQUE,
      access_level   TEXT NOT NULL DEFAULT 'guest_view',
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      settings       JSONB NOT NULL DEFAULT '{}',
      created_by     INTEGER REFERENCES users(id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_viewed_at TIMESTAMPTZ
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_todo_shares_workspace_active ON todo_shares(workspace_id, active, created_at DESC)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todo_sponsorships (
      id               SERIAL PRIMARY KEY,
      workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
      share_id         INTEGER NOT NULL REFERENCES todo_shares(id),
      task_id          TEXT NOT NULL,
      task_date        DATE,
      task_block_id    TEXT,
      task_title       TEXT NOT NULL,
      sponsor_name     TEXT NOT NULL,
      sponsor_email    TEXT,
      sponsor_user_id  INTEGER REFERENCES users(id),
      kind             TEXT NOT NULL DEFAULT 'bounty',
      reward_title     TEXT NOT NULL,
      note             TEXT NOT NULL DEFAULT '',
      value_cents      INTEGER NOT NULL DEFAULT 0,
      slot_reward_id   INTEGER REFERENCES slot_rewards(id),
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE todo_sponsorships ADD COLUMN IF NOT EXISTS task_date DATE");
  await pool.query("ALTER TABLE todo_sponsorships ADD COLUMN IF NOT EXISTS slot_reward_id INTEGER REFERENCES slot_rewards(id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_todo_sponsorships_workspace_status ON todo_sponsorships(workspace_id, status, created_at DESC)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todo_task_reactions (
      id              SERIAL PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
      share_id        INTEGER NOT NULL REFERENCES todo_shares(id),
      task_id         TEXT NOT NULL,
      task_date       DATE,
      task_block_id   TEXT,
      task_title      TEXT NOT NULL DEFAULT '',
      identity_ids    JSONB NOT NULL DEFAULT '[]',
      emoji           TEXT NOT NULL,
      actor_key       TEXT NOT NULL,
      actor_user_id   INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE todo_task_reactions ADD COLUMN IF NOT EXISTS task_date DATE");
  await pool.query("ALTER TABLE todo_task_reactions ADD COLUMN IF NOT EXISTS identity_ids JSONB NOT NULL DEFAULT '[]'");
  await pool.query("DROP INDEX IF EXISTS idx_todo_task_reactions_unique_actor");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_task_reactions_unique_actor_date ON todo_task_reactions(share_id, task_id, COALESCE(task_date, DATE '0001-01-01'), emoji, actor_key)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_todo_task_reactions_share_task ON todo_task_reactions(share_id, task_id, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_todo_task_reactions_share_date ON todo_task_reactions(share_id, task_date, created_at DESC)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todo_task_comments (
      id              SERIAL PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
      share_id        INTEGER NOT NULL REFERENCES todo_shares(id),
      task_id         TEXT NOT NULL,
      task_date       DATE,
      task_block_id   TEXT,
      task_title      TEXT NOT NULL DEFAULT '',
      identity_ids    JSONB NOT NULL DEFAULT '[]',
      body            TEXT NOT NULL,
      author_name     TEXT NOT NULL DEFAULT '',
      author_kind     TEXT NOT NULL DEFAULT 'guest',
      actor_key       TEXT NOT NULL,
      actor_user_id   INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_todo_task_comments_share_task ON todo_task_comments(share_id, task_id, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_todo_task_comments_share_date ON todo_task_comments(share_id, task_date, created_at DESC)");
}

function normalizeTodoShare(row, req) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    token: row.token,
    accessLevel: row.access_level,
    active: row.active,
    settings: row.settings || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastViewedAt: row.last_viewed_at,
    shareUrl: todoShareUrl(req, row.token)
  };
}

async function getActiveTodoShare(workspaceId) {
  await ensureTodoShareTables();
  const { rows } = await pool.query(
    "SELECT * FROM todo_shares WHERE workspace_id = $1 AND active = TRUE ORDER BY created_at DESC LIMIT 1",
    [workspaceId]
  );
  return rows[0] || null;
}

async function findTodoShareByToken(token) {
  await ensureTodoShareTables();
  const { rows } = await pool.query(
    `SELECT s.*, w.name AS workspace_name, w.owner_id AS owner_id, u.username AS owner_username
       FROM todo_shares s
       JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN users u ON u.id = w.owner_id
      WHERE s.token = $1 AND s.active = TRUE`,
    [token]
  );
  return rows[0] || null;
}

function localTimeFromAny(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value)) return value.padStart(5, "0");
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function taskMinutes(start, end, fallback) {
  const parse = (s) => {
    const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = parse(start), b = parse(end);
  if (a != null && b != null && b > a) return b - a;
  const n = Number(fallback);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function publicTaskIdentityIds(input) {
  input = input || {};
  const ids = [
    input.id,
    input.local_id,
    input.localId,
    input.task_id,
    input.taskId,
    input.blockId,
    input.block_id,
    input.source_id,
    input.sourceId,
    input.gcal_event_id
  ];
  return [...new Set(ids.map(v => String(v || "").trim()).filter(Boolean))];
}

function normalizeReactionIdentityIds(value, fallback = {}) {
  let ids = [];
  if (Array.isArray(value)) ids = value;
  else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) ids = parsed;
    } catch {}
  }
  return [...new Set([...ids, ...publicTaskIdentityIds(fallback)].map(v => String(v || "").trim()).filter(Boolean))];
}

function findPublicShareTask(tasks, taskId) {
  const requested = String(taskId || "").trim();
  if (!requested) return null;
  return (tasks || []).find(task => {
    const ids = task && task.identityIds && task.identityIds.length ? task.identityIds : publicTaskIdentityIds(task || {});
    return ids.map(String).includes(requested);
  }) || null;
}

function addReactionToMap(map, row) {
  const taskId = String(row.task_id);
  if (!map[taskId]) {
    const storedIdentityIds = Array.isArray(row.identity_ids) ? row.identity_ids : [];
    const identityIds = normalizeReactionIdentityIds(row.identity_ids, {
      id: row.task_id,
      blockId: row.task_block_id,
      block_id: row.task_block_id
    });
    map[taskId] = {
      taskId,
      taskDate: coerceDateString(row.task_date),
      taskBlockId: row.task_block_id || "",
      taskTitle: row.task_title || "",
      identityIds,
      legacy: storedIdentityIds.length === 0,
      counts: {}
    };
    identityIds.forEach(id => { if (!map[id]) map[id] = map[taskId]; });
  }
  map[taskId].counts[row.emoji] = row.count;
}

// Build a task-id -> { items: [...] } map for comments, aliased across every
// identity id (and a legacy title fallback) exactly like addReactionToMap, so
// the owner feed matches comments to itinerary tasks the same way reactions do.
function addCommentToMap(map, row) {
  const taskId = String(row.task_id);
  if (!map[taskId]) {
    const storedIdentityIds = Array.isArray(row.identity_ids) ? row.identity_ids : [];
    const identityIds = normalizeReactionIdentityIds(row.identity_ids, {
      id: row.task_id,
      blockId: row.task_block_id,
      block_id: row.task_block_id
    });
    map[taskId] = {
      taskId,
      taskDate: coerceDateString(row.task_date),
      taskBlockId: row.task_block_id || "",
      taskTitle: row.task_title || "",
      identityIds,
      legacy: storedIdentityIds.length === 0,
      items: []
    };
    identityIds.forEach(id => { if (!map[id]) map[id] = map[taskId]; });
  }
  map[taskId].items.push({
    body: row.body,
    authorName: row.author_name || "",
    authorKind: row.author_kind || "guest",
    createdAt: row.created_at
  });
}

function publicTaskStatus(task, doneIds) {
  const ids = task.identityIds && task.identityIds.length ? task.identityIds : publicTaskIdentityIds(task);
  if (ids.some(id => doneIds.has(id))) return "done";
  if (task.completed) return "done";
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const m = String(task.end || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "open";
  const endMin = Number(m[1]) * 60 + Number(m[2]);
  return nowMin > endMin ? "overdue" : "open";
}

function publicFeedType(input) {
  const kind = String(input.kind || input.type || "task").toLowerCase();
  const source = String(input.source || "").toLowerCase();
  if (source === "calendar" || source === "gcal" || input.gcal_event_id || input.gcal_calendar_id || ["meeting", "oneone"].includes(kind)) return "calendar";
  if (["responsibility_trigger", "repeat_responsibility", "repeat", "recurring"].includes(kind) || input.is_recurring || input.recurring) return "repeat";
  if (["break", "free_time"].includes(kind)) return "break";
  if (kind === "ooo") return "ooo";
  return "task";
}

function publicFeedTypeLabel(feedType, kind) {
  if (feedType === "calendar") return kind === "oneone" ? "1:1" : "Calendar";
  if (feedType === "repeat") return "Repeat";
  if (feedType === "break") return "Break";
  if (feedType === "ooo") return "OOO";
  if (kind === "public_task") return "Public";
  return "Task";
}

async function getPublicCalendarMap() {
  try {
    const { rows } = await pool.query(
      `SELECT id, summary, background_color, account_key, account_email, is_primary
         FROM gcal_calendars`
    );
    return new Map(rows.map((row) => [String(row.id), {
      id: row.id,
      name: row.summary || row.id,
      color: row.background_color || "#4285f4",
      accountKey: row.account_key || "default",
      accountEmail: row.account_email || "",
      primary: !!row.is_primary
    }]));
  } catch {
    return new Map();
  }
}

// Resolve the workspace tag taxonomy (id -> {name,color}) so guest itinerary
// cards can show the same tag chips the owner sees. Mirrors the client tag index
// (buildTagIndex), which is keyed by block id.
async function getPublicTagMap(workspaceId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, properties
         FROM blocks
        WHERE workspace_id = $1 AND type = 'tag' AND deleted_at IS NULL`,
      [workspaceId]
    );
    return new Map(rows.map((row) => {
      const props = row.properties || {};
      return [String(row.id), { name: props.name || "", color: props.color || "var(--accent)" }];
    }));
  } catch {
    return new Map();
  }
}

function calendarMeta(input, calendarsById) {
  const id = String(input.gcal_calendar_id || input.calendarId || input.calendar_id || "").trim();
  if (!id) return null;
  const known = calendarsById.get(id);
  if (known) return known;
  return {
    id,
    name: String(input.calendarName || input.calendar_name || id).slice(0, 140),
    color: input.calendarColor || input.calendar_color || "#4285f4",
    accountKey: input.accountKey || input.account_key || "",
    accountEmail: input.accountEmail || input.account_email || "",
    primary: false
  };
}

// Points a task is worth on completion, used so visitors can see "what the
// owner is earning for" on both public and redacted-private tasks.
function publicTaskPoints(input) {
  const result = scoreTaskPoints({
    duration_minutes: input.durationMinutes != null ? input.durationMinutes : (input.duration || input.estimated_minutes || input.durMin),
    priority: input.priority,
    type: input.kind || input.type
  });
  return result && result.eligible ? result.awardPoints : 0;
}

function normalizePublicTask(input, doneIds, calendarsById = new Map(), opts = {}) {
  const redacted = !!opts.redacted;
  const kind = String(input.kind || "task").slice(0, 80);
  const feedType = publicFeedType(input);
  const calendar = redacted ? null : calendarMeta(input, calendarsById);
  const identityIds = publicTaskIdentityIds(input);
  // Resolve tag ids -> {name,color} so the guest itinerary mirror can show tag
  // chips. Hidden on redacted (private) tasks. tagsById is built once per share.
  const tagsById = opts.tagsById instanceof Map ? opts.tagsById : null;
  const tags = (redacted || !tagsById)
    ? []
    : (Array.isArray(input.tags) ? input.tags : [])
        .map(id => tagsById.get(String(id)))
        .filter(t => t && t.name)
        .slice(0, 8);
  const task = {
    id: identityIds[0] || crypto.randomUUID(),
    blockId: input.blockId || input.block_id || "",
    title: redacted ? "Private task" : String(input.title || "Untitled task").slice(0, 220),
    detail: redacted ? "" : String(input.detail || input.notes || "").slice(0, 500),
    start: localTimeFromAny(input.start),
    end: localTimeFromAny(input.end),
    priority: redacted ? "" : String(input.priority || "").slice(0, 40),
    source: redacted ? "private" : String(input.source || "manual").slice(0, 80),
    // sourceId stays populated so addTask's dedupe key still works; identityIds
    // already carries the same opaque ids needed for reactions/comments.
    sourceId: String(input.source_id || input.sourceId || input.gcal_event_id || "").slice(0, 200),
    kind: redacted ? "private" : kind,
    itemType: redacted ? "task" : feedType,
    itemTypeLabel: redacted ? "Private" : publicFeedTypeLabel(feedType, kind),
    completed: !!input.completed,
    identityIds,
    calendar,
    gcalCalendarId: calendar ? calendar.id : "",
    tags,
    createdByGuest: !!input.createdByGuestName,
    redacted
  };
  task.durationMinutes = taskMinutes(task.start, task.end, input.duration || input.estimated_minutes || input.durMin);
  task.points = publicTaskPoints(task);
  task.status = publicTaskStatus(task, doneIds);
  return task;
}

async function buildPublicTodoShare(share, dateStr, req) {
  const date = isValidDate(dateStr) ? dateStr : getTodayStr();
  const state = await buildDayResponse(date, null, share.workspace_id);
  // ONE day read, split locally. `getBlocksByDateIncludingDeleted` is a strict superset of
  // `getBlocksByDate` (same table, same date, same order; only the `deleted_at IS NULL`
  // predicate differs), and this handler is genuinely hot: public-todo-share.js polls
  // `GET /api/public/todo-share/:token` every 15s per open viewer, on a day that can hold
  // ~2000 blocks, against a pool capped at 10. Two full-day scans per poll for a superset
  // relationship is pure waste.
  //
  // A failed tombstone read degrades to the live-only read rather than throwing: "cannot
  // tell" must not publish a deleted task, so the hide set falls back to overlay-only and
  // says so. `filterLegacyGcalBlocks` is a pure filter, so applying it before the split is
  // identical for `blocks` and additionally keeps legacy gcal tombstones out of `hiddenIds`.
  // FAILS CLOSED, and round 1 of review got this backwards too. Its first cut degraded to an
  // overlay-only hide set on a failed tombstone read, which IS fail-OPEN: with `tombstoned`
  // empty no `deleted_at` alias reaches `hiddenIds`, so the timeline twin of a task the owner
  // deleted is published again to whoever holds the link, and only pre-B1 `_deleted` entries
  // still hide anything. Nor does the failure cancel itself out — the tombstone-inclusive scan
  // is the LARGER of the two queries on a ~2000-block day, so a statement timeout or pool
  // exhaustion hits it while the narrower live query would have succeeded, which is precisely
  // the state that tripped the branch. The caller answers a generic 500 and the viewer
  // re-polls in 15s, so refusing to publish is cheap and correct.
  let allRows;
  try {
    allRows = await blockDB.getBlocksByDateIncludingDeleted(date, share.workspace_id);
  } catch (e) {
    console.error("[public-share] tombstone read failed for " + date + ", refusing to publish:", e.message);
    throw e;
  }
  const dayRows = filterLegacyGcalBlocks(allRows);
  const blocks = dayRows.filter(b => b && !b.deleted_at);
  const tombstoned = dayRows.filter(b => b && b.deleted_at);
  const root = blocks.find(b => b.type === "day_root");
  const rootProps = root && root.properties ? root.properties : {};
  const rootDone = rootProps._done || {};
  // ── C5b: the ROW is the source, the overlays are a legacy union ──
  //
  // This read had to change in the SAME phase that moved completion onto the row, or the
  // share regressed immediately: a task Drake finished today writes `properties.status`
  // and never touches `_done`, so an overlay-only `doneIds` would have published every
  // one of his completed tasks as `open` (or `overdue`, once its end time passed).
  //
  // The overlay reads stay UNIONED rather than replaced, for the same measured reason
  // public/js/persistence.js keeps them: 23 of the 401 `_done` entries on prod are still
  // the only representation of a real completion, and dropping them would publish 23
  // finished tasks as open on archive-day shares.
  const doneIds = new Set([
    ...((rootDone.ids || []).map(String)),
    ...Object.keys(rootDone.at || {}).map(String)
  ]);
  const hiddenIds = new Set([
    ...((rootProps._deleted || [])).map(String),
    // LEGACY `_pushed` (C3): nothing writes this key any more — the pushed subsystem is
    // deleted and a push is a real move now. Old day_roots still carry it, and a pushed row
    // was never removed from its origin day, only hidden by this overlay, so dropping the
    // read would resurface those rows on old shares. Same decision and the same row counts
    // as public/js/persistence.js reloadPersistedEdits.
    ...(((rootProps._pushed && rootProps._pushed.ids) || [])).map(String)
  ]);
  const aliasesOf = (block) => {
    const p = block.properties || {};
    return publicTaskIdentityIds({
      id: p.local_id || block.id,
      local_id: p.local_id,
      blockId: block.id,
      block_id: block.id,
      source_id: p.source_id,
      sourceId: p.sourceId,
      gcal_event_id: p.gcal_event_id
    });
  };
  // TOMBSTONES (split out of the single day read above). `getBlocksByDate` filters
  // `deleted_at IS NULL`, so a deleted row is simply absent from `blocks` — which is right
  // for the row itself and wrong for its TIMELINE twin, which keeps rendering off
  // `state.schedule.timeline` under the same id. `_deleted` used to hide it; B1/C3 moved
  // deletion to the `deleted_at` column, so nothing has hidden it since. This is the
  // "public share keeps showing tasks Drake deleted" half of the phase.
  for (const block of tombstoned) aliasesOf(block).forEach(id => hiddenIds.add(id));
  for (const block of blocks) {
    const p = block.properties || {};
    const aliases = aliasesOf(block);
    // Row-carried completion, the canonical one as of C5b.
    if (p.status === "done" || p.done === true || p.completedAt) aliases.forEach(id => doneIds.add(id));
    if (aliases.some(id => doneIds.has(id))) aliases.forEach(id => doneIds.add(id));
    if (aliases.some(id => hiddenIds.has(id))) aliases.forEach(id => hiddenIds.add(id));
  }
  const calendarsById = await getPublicCalendarMap();
  const tagsById = await getPublicTagMap(share.workspace_id);
  const tasks = [];
  const seen = new Set();
  const addTask = (task) => {
    const ids = task && task.identityIds && task.identityIds.length ? task.identityIds : publicTaskIdentityIds(task || {});
    if (!task || !task.title || ids.some(id => hiddenIds.has(id))) return;
    const dedupeKey = task.sourceId ? `${task.itemType}:${task.sourceId}` : task.id;
    if (seen.has(task.id) || seen.has(dedupeKey) || ids.some(id => seen.has(`id:${id}`))) return;
    seen.add(task.id);
    seen.add(dedupeKey);
    ids.forEach(id => seen.add(`id:${id}`));
    tasks.push(task);
  };

  for (const item of ((state.schedule && state.schedule.timeline) || [])) {
    if (!item) continue;
    const redacted = item.publicVisibility === "private";
    const task = normalizePublicTask({
      id: item.id || item.source_id,
      local_id: item.local_id || item.localId,
      blockId: item.block_id || item.blockId || "",
      block_id: item.block_id || item.blockId || "",
      title: item.label || item.title,
      start: item.start,
      end: item.end,
      priority: item.priority,
      detail: item.detail || item.description || item.notes,
      source: item.source || "schedule",
      source_id: item.source_id,
      sourceId: item.sourceId,
      gcal_calendar_id: item.gcal_calendar_id,
      calendarName: item.calendarName || item.calendar_name,
      calendarColor: item.calendarColor || item.calendar_color,
      completed: item.completed,
      tags: item.tags,
      kind: item.type
    }, doneIds, calendarsById, { redacted, tagsById });
    addTask(task);
  }

  for (const item of ((state.triage && state.triage.open_items) || [])) {
    if (!item) continue;
    const vis = item.publicVisibility;
    if (vis !== "public" && vis !== "private") continue;
    const task = normalizePublicTask({
      id: item.id,
      local_id: item.local_id,
      title: item.title,
      duration: item.duration_minutes || item.durationMinutes || item.estimated_minutes,
      priority: item.priority,
      detail: item.summary || item.notes,
      source: item.source || "public_share",
      source_id: item.source_id || item.id,
      completed: item.completed,
      tags: item.tags,
      createdByGuestName: item.createdByGuestName,
      kind: item.type || "public_task"
    }, doneIds, calendarsById, { redacted: vis === "private", tagsById });
    addTask(task);
  }

  for (const block of blocks) {
    const p = block.properties || {};
    if (block.type === "day_root") continue;
    const kind = p.kind || block.type;
    if (["delegated_item"].includes(kind)) continue;
    if (!p.title && !p.label) continue;
    const redacted = p.publicVisibility === "private";
    const id = p.local_id || block.id;
    const task = normalizePublicTask({
      id,
      local_id: p.local_id,
      blockId: block.id,
      block_id: block.id,
      title: p.title || p.label,
      start: p.start,
      end: p.end,
      duration: p.duration,
      priority: p.priority,
      detail: p.detail || p.notes,
      source: p.source || block.type,
      source_id: p.source_id || p.gcal_event_id,
      gcal_event_id: p.gcal_event_id,
      gcal_calendar_id: p.gcal_calendar_id,
      calendarName: p.calendarName || p.calendar_name,
      calendarColor: p.calendarColor || p.calendar_color,
      is_recurring: p.is_recurring,
      completed: p.completed,
      tags: p.tags,
      createdByGuestName: p.createdByGuestName,
      kind
    }, doneIds, calendarsById, { redacted, tagsById });
    addTask(task);
  }

  const { rows: sponsors } = await pool.query(
    `SELECT id, task_id, task_date, task_title, sponsor_name, sponsor_user_id, kind, reward_title, note, value_cents, status, created_at
       FROM todo_sponsorships
      WHERE share_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [share.id]
  );
  // The "one bounty per day" cap is per visitor (matches the server check on
  // POST), so the viewer needs to know which active bounties are their own to
  // decide whether their bounty slot is spent.
  const viewerUserId = req?.session?.userId || null;
  const sponsorByTask = new Map();
  for (const s of sponsors) {
    const key = String(s.task_id);
    if (!sponsorByTask.has(key)) sponsorByTask.set(key, []);
    sponsorByTask.get(key).push({
      id: s.id,
      sponsorName: s.sponsor_name,
      kind: s.kind,
      rewardTitle: s.reward_title,
      note: s.note,
      valueCents: s.value_cents,
      status: s.status,
      createdAt: s.created_at,
      mine: !!(viewerUserId && s.sponsor_user_id === viewerUserId)
    });
  }
  for (const task of tasks) task.sponsorships = sponsorByTask.get(String(task.id)) || [];
  const { rows: reactionRows } = await pool.query(
    `SELECT task_id, task_date, task_block_id, task_title, identity_ids, emoji, COUNT(*)::int AS count
       FROM todo_task_reactions
      WHERE share_id = $1
        AND (task_date = $2::date OR task_date IS NULL)
      GROUP BY task_id, task_date, task_block_id, task_title, identity_ids, emoji`,
    [share.id, date]
  );
  const reactionByTask = {};
  reactionRows.forEach(row => addReactionToMap(reactionByTask, row));
  const actorKey = req ? todoActorKey(req) : "";
  const { rows: viewerReactionRows } = actorKey
    ? await pool.query(
        `SELECT task_id, emoji
           FROM todo_task_reactions
          WHERE share_id = $1
            AND actor_key = $2
            AND (task_date = $3::date OR task_date IS NULL)`,
        [share.id, actorKey, date]
      )
    : { rows: [] };
  const viewerByTask = new Map();
  for (const row of viewerReactionRows) {
    const taskId = String(row.task_id);
    if (!viewerByTask.has(taskId)) viewerByTask.set(taskId, []);
    viewerByTask.get(taskId).push(row.emoji);
  }
  const { rows: commentRows } = await pool.query(
    `SELECT task_id, task_date, task_block_id, task_title, identity_ids, body, author_name, author_kind, created_at
       FROM todo_task_comments
      WHERE share_id = $1
        AND (task_date = $2::date OR task_date IS NULL)
      ORDER BY created_at ASC`,
    [share.id, date]
  );
  const commentByTask = {};
  commentRows.forEach(row => addCommentToMap(commentByTask, row));
  for (const task of tasks) {
    const ids = task.identityIds && task.identityIds.length ? task.identityIds : publicTaskIdentityIds(task);
    const reaction = ids.map(id => reactionByTask[id]).find(Boolean);
    task.reactions = reaction && reaction.counts ? reaction.counts : {};
    task.viewerReactions = viewerByTask.get(String(task.id)) || [];
    const comment = ids.map(id => commentByTask[id]).find(Boolean);
    task.comments = comment && comment.items ? comment.items : [];
  }
  tasks.sort((a, b) => (a.status === "done") - (b.status === "done") || (a.start || "99:99").localeCompare(b.start || "99:99"));
  const { rows: rewardRows } = await pool.query(
    `SELECT id, title, kind, value_cents, public_visibility, expires_at, uses_remaining
       FROM slot_rewards
      WHERE workspace_id = $1
        AND deleted_at IS NULL
        AND active = TRUE
        AND kind NOT IN ('miss','reroll','choice','bank_gated')
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (uses_remaining IS NULL OR uses_remaining > 0)
      ORDER BY kind, title
      LIMIT 100`,
    [share.workspace_id]
  );
  // Private rewards still appear so visitors can sponsor them, but redacted to a
  // locked placeholder (mirrors private-task redaction).
  const rewards = rewardRows.map(r => {
    const isPrivate = r.public_visibility === "private";
    return {
      id: r.id,
      title: isPrivate ? "Private reward" : r.title,
      kind: isPrivate ? "private" : r.kind,
      value: isPrivate ? 0 : r.value_cents,
      private: isPrivate
    };
  });
  const tier = capabilities.resolveTier(req);
  return {
    date,
    workspaceName: share.workspace_name || "Daily Command Center",
    ownerUsername: share.owner_username || "",
    updatedAt: new Date().toISOString(),
    tasks,
    calendars: Array.from(calendarsById.values()),
    // Work/personal time-block sections so the guest itinerary mirror can render
    // the same block headers the owner sees (name + range only; not sensitive).
    blocks: ((state.schedule && state.schedule.blocks) || []).map(b => ({
      id: b.id || "", name: b.name || "", start: b.start || "", end: b.end || "", blockType: b.blockType || ""
    })),
    rewards,
    viewer: {
      loggedIn: !!req?.session?.userId,
      username: req?.session?.username || "",
      tier,
      capabilities: capabilities.capabilityMap(tier)
    },
    sponsorships: sponsors.map(({ sponsor_user_id, ...rest }) => rest),
    stats: {
      total: tasks.length,
      done: tasks.filter(t => t.status === "done").length,
      open: tasks.filter(t => t.status !== "done").length,
      sponsored: sponsors.filter(s => s.status !== "dismissed").length,
      tasks: tasks.filter(t => t.itemType === "task").length,
      repeat: tasks.filter(t => t.itemType === "repeat").length,
      calendar: tasks.filter(t => t.itemType === "calendar").length
    }
  };
}

// C5b: this used to be the repo's only FILE-ONLY state writer, and that was a live
// data-loss bug, not just an obstacle to step 4. A guest's submitted task was written to
// `data/state/days/<date>.json` and nowhere else; Railway's filesystem is ephemeral, so the
// only copy did not survive a redeploy. Evidence: ZERO items with `source:"public_share"`
// have ever reached `dcc_state` on prod.
//
// It also made `server.js buildDayResponse` unfixable — a Postgres-first read could not
// treat "no row" as "no day" while the file held state nothing else had. Postgres is the
// durable store now and the file stays as the mirror, which is the same contract
// `persistDccDay` and the day-state ingest already follow.
//
// The DB is read as the BASE (not the file) for the identical reason the six readers in
// routes/dcc.js were repointed: `saveDccState` is `DO UPDATE SET state_json =
// EXCLUDED.state_json`, so basing the write on a stale file would full-replace the real day
// with it. Async because of that read; the single caller awaits.
async function appendPublicShareTriageItem({ share, date, title, durationMinutes, visitorName, visitorEmail, note, req }) {
  const now = new Date().toISOString();
  const localId = "public-" + crypto.randomUUID();
  const item = {
    id: "public_share:" + localId,
    local_id: localId,
    type: "public_task",
    sub_type: "created_task",
    source: "public_share",
    source_ref: todoShareUrl(req, share.token),
    source_id: localId,
    title,
    summary: note,
    notes: note,
    priority: "medium",
    escalation: "normal",
    received_at: now,
    first_seen_at: now,
    last_seen_at: now,
    seen_count: 1,
    duration_minutes: durationMinutes,
    estimated_minutes: durationMinutes,
    publicVisibility: "public",
    queue_label: "Public task",
    source_label: "Public todo",
    createdByGuestName: visitorName,
    createdByGuestEmail: visitorEmail
  };

  const dayFile = getDayFilePath(date);
  // ── This is an UNAUTHENTICATED writer, and `saveDccState` is a FULL REPLACE ──
  //
  // `ON CONFLICT (date, workspace_id) DO UPDATE SET state_json = EXCLUDED.state_json`
  // (db.js) replaces the entire day. So whatever this function picks as its base becomes
  // the day, and a guest holding a share token picks the DATE. That makes the two "just
  // guess a base" fallbacks the earlier cut had into real data loss:
  //
  //   - A FAILED read followed by a successful write replaced the workspace's real day
  //     (timeline, triage history, glymphatic brief) with the file mirror, or with a bare
  //     skeleton when no file existed. On Railway's ephemeral filesystem "no file" IS the
  //     normal post-deploy state, so the realistic outcome was losing the whole row.
  //   - `getDayFilePath` has no workspace segment and `persistDccDay` writes that mirror
  //     for EVERY workspace, so seeding from it when this workspace has no row created
  //     this workspace's row holding ANOTHER tenant's day. And because `buildDayResponse`
  //     is Postgres-first now, that content would then be served authoritatively and
  //     published on this share, turning a transient cross-tenant read into a permanent one.
  //
  // So it fails closed, for exactly the reason `buildDayResponse` blocker 4 does: an outage
  // is an error, not an empty Tuesday. A read we could not complete is never a base to
  // write from, and a no-row read means "no day for THIS workspace" -- never the shared file.
  let row = null;
  try {
    row = await blockDB.getDccState(date, share.workspace_id);
  } catch (e) {
    console.error("[public-todo] day-state read failed for " + date + ":", e.message);
    const err = new Error("Day state is temporarily unavailable; the task was not saved");
    err.statusCode = 503;
    throw err;
  }
  const state = (row && row.state_json) ? row.state_json : buildSkeletonState(date);
  if (!state.triage) state.triage = { open_items: [], resolved_items: [], cycle_count: 0 };
  if (!Array.isArray(state.triage.open_items)) state.triage.open_items = [];
  if (!Array.isArray(state.triage.resolved_items)) state.triage.resolved_items = [];
  // A cap, because this is now a DURABLE unauthenticated append into one JSONB blob and
  // there is no rate limiting anywhere in this app. Unbounded, a share token is enough to
  // grow one row until reads of it get expensive, which degrades the owner's own
  // /api/state/day. Before this change the same abuse only cost an ephemeral file.
  const PUBLIC_ITEM_CAP = 50;
  if (state.triage.open_items.filter(i => i && i.source === "public_share").length >= PUBLIC_ITEM_CAP) {
    const err = new Error("This list has reached its limit of guest-submitted tasks for the day");
    err.statusCode = 429;
    throw err;
  }
  state.triage.open_items.push(item);
  if (state.sweep) state.sweep.open_item_count = state.triage.open_items.length;
  state.last_updated_at = now;
  state.last_updated_by = "public-todo-triage";
  // Postgres FIRST and it must succeed. The whole point is that the guest's task is durable;
  // reporting success after only a file write is what lost them. The file mirror is
  // best-effort after, matching persistDccDay's contract.
  //
  // `user_id` PRESERVES what the row had. The upsert also does `user_id = EXCLUDED.user_id`,
  // so passing null erased the owner's id -- and server.js's boot backfill is
  // `UPDATE dcc_state SET user_id = $1, workspace_id = $2 WHERE user_id IS NULL`, run
  // unconditionally on EVERY restart. A nulled row for workspace A therefore had its
  // workspace_id rewritten to the default workspace on the next deploy, moving A's day out
  // of A entirely; or it collided with the default workspace's own row for that date
  // (PRIMARY KEY (date, workspace_id)), aborting the UPDATE into a catch that then skips
  // ensureWorkspacesForAllUsers for that boot. Deploys are restarts, so a single guest
  // submission armed it.
  await blockDB.saveDccState(date, state, (row && row.user_id) || share.owner_id || null, share.workspace_id);
  // NO FILE MIRROR FROM THE ANONYMOUS PATH. `buildDayResponse`'s blocker 2 claims the
  // cross-tenant leak is closed "BY NOT WRITING" — and this writer, reached by the same
  // anonymous POST, was still writing a workspace's COMPLETE day (timeline, triage history,
  // glymphatic brief) into `data/state/days/<date>.json` and, for today, the global
  // `DAY_STATE_FILE`. Those are the two files `readDccDayState` and `dayStateUnavailable`
  // read on behalf of OTHER workspaces, so the leak was closed on the read side and left open
  // on the write side, in one change.
  //
  // Nothing needs the mirror here any more: Postgres is the durable store as of this phase
  // and `buildDayResponse` prefers the row, so dropping it costs nothing.
  return item;
}

async function activateTodoShareBounty(sponsorship, userId) {
  const sponsorshipDate = coerceDateString(sponsorship.task_date);
  const date = isValidDate(sponsorshipDate) ? sponsorshipDate : getTodayStr();
  const taskId = String(sponsorship.task_id || sponsorship.task_block_id || "");
  const rootId = await blockDB.ensureDayRoot(date, userId || null, sponsorship.workspace_id);
  const root = await blockDB.getBlock(rootId);
  const props = root && root.properties ? root.properties : { date };
  const existing = normalizeBountyState(props._bounty);
  const selfTaskId = existing.self && existing.self.taskId ? String(existing.self.taskId) : "";
  const partnerTaskId = existing.partner && existing.partner.taskId ? String(existing.partner.taskId) : "";
  if (selfTaskId && selfTaskId !== taskId) {
    const err = new Error("Sponsor bounty must stack on today's self bounty task");
    err.statusCode = 409;
    throw err;
  }
  if (partnerTaskId && partnerTaskId !== taskId) {
    const err = new Error("Today's sponsor bounty is already set");
    err.statusCode = 409;
    throw err;
  }
  const partner = partnerTaskId ? existing.partner : {
    taskId,
    taskTitle: sponsorship.task_title,
    placedAt: new Date().toISOString(),
    source: "todo-share",
    sponsorshipId: sponsorship.id,
    sponsorName: sponsorship.sponsor_name || ""
  };
  const bounty = { ...existing, partner };
  await blockDB.updateBlock(rootId, { properties: { ...props, _bounty: bounty } });
  broadcast("blocks-changed", { action: "public-bounty-approved", blockIds: [rootId] }, sponsorship.workspace_id);
  return bounty;
}

// Clear a sponsor (partner) bounty placed via the share, used when the owner
// dismisses the sponsorship. No-op if the slot no longer matches.
async function revokeTodoShareBounty(sponsorship, userId) {
  const sponsorshipDate = coerceDateString(sponsorship.task_date);
  const date = isValidDate(sponsorshipDate) ? sponsorshipDate : getTodayStr();
  const rootId = await blockDB.ensureDayRoot(date, userId || null, sponsorship.workspace_id);
  const root = await blockDB.getBlock(rootId);
  const props = root && root.properties ? root.properties : { date };
  const existing = normalizeBountyState(props._bounty);
  if (!existing.partner || String(existing.partner.sponsorshipId) !== String(sponsorship.id)) return null;
  const bounty = { ...existing, partner: null };
  await blockDB.updateBlock(rootId, { properties: { ...props, _bounty: bounty } });
  broadcast("blocks-changed", { action: "public-bounty-revoked", blockIds: [rootId] }, sponsorship.workspace_id);
  return bounty;
}

// Apply a reward sponsorship to the slot rotation. Two paths, sharing the same
// downstream code as a self-added reward:
//   (a) slot_reward_id set -> append this sponsor to an existing reward's splits
//   (b) otherwise -> create/refresh a sponsor reward (the original INSERT path)
// Returns { reward, slotRewardId }.
async function applyTodoShareReward(sponsorship, workspaceId, opts = {}) {
  if (sponsorship.slot_reward_id) {
    const { rows } = await pool.query(
      "SELECT * FROM slot_rewards WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL",
      [workspaceId, sponsorship.slot_reward_id]
    );
    const existing = rows[0];
    if (existing) {
      const splits = Array.isArray(existing.sponsor_splits) ? existing.sponsor_splits.slice() : [];
      splits.push({
        name: sponsorship.sponsor_name,
        email: sponsorship.sponsor_email || "",
        percent: 0,
        value_cents: sponsorship.value_cents || 0,
        sponsorshipId: sponsorship.id,
        addedAt: new Date().toISOString()
      });
      const { rows: updated } = await pool.query(
        `UPDATE slot_rewards
            SET sponsor_splits = $3,
                active = TRUE,
                sponsor_active = TRUE,
                value_cents = GREATEST(value_cents, $4),
                updated_at = NOW()
          WHERE workspace_id = $1 AND id = $2
          RETURNING *`,
        [workspaceId, sponsorship.slot_reward_id, JSON.stringify(splits), sponsorship.value_cents || 0]
      );
      broadcast("slot-changed", { action: "sponsored-reward-applied" }, workspaceId);
      return { reward: updated[0] || existing, slotRewardId: sponsorship.slot_reward_id };
    }
    // referenced reward is gone; fall through to create a fresh one
  }
  const sponsor = sponsorship.sponsor_name ? ` from ${sponsorship.sponsor_name}` : "";
  const title = `${sponsorship.reward_title}${sponsor}`.slice(0, 180);
  const notes = `Shared todo reward for "${sponsorship.task_title}". ${sponsorship.note || ""}`.trim();
  const sponsorSplits = [{ name: sponsorship.sponsor_name, email: sponsorship.sponsor_email || "", percent: 100, value_cents: sponsorship.value_cents, sponsorshipId: sponsorship.id }];
  const visibility = opts.private ? "private" : "public";
  const expiresAt = opts.expiresAt || null;
  const usesRemaining = (opts.usesRemaining != null && Number.isFinite(Number(opts.usesRemaining)) && Number(opts.usesRemaining) > 0)
    ? Math.min(Number(opts.usesRemaining), 9999)
    : null;
  const { rows: rewardRows } = await pool.query(
    `INSERT INTO slot_rewards
     (workspace_id,title,kind,sponsor_type,sponsor_splits,weight,active,sponsor_active,value_cents,bank_delta_cents,requires_confirmation,cooldown_days,unlock_threshold_cents,notes,public_visibility,expires_at,uses_remaining)
     VALUES ($1,$2,'sponsor','accountability_partner',$3,5,TRUE,TRUE,$4,0,FALSE,0,0,$5,$6,$7,$8)
     ON CONFLICT (workspace_id, title) DO UPDATE
       SET sponsor_splits = EXCLUDED.sponsor_splits,
           value_cents = EXCLUDED.value_cents,
           notes = EXCLUDED.notes,
           active = TRUE,
           deleted_at = NULL,
           weight = GREATEST(slot_rewards.weight, EXCLUDED.weight),
           public_visibility = EXCLUDED.public_visibility,
           expires_at = EXCLUDED.expires_at,
           uses_remaining = EXCLUDED.uses_remaining,
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, title, JSON.stringify(sponsorSplits), sponsorship.value_cents || 0, notes, visibility, expiresAt, usesRemaining]
  );
  broadcast("slot-changed", { action: "sponsored-reward-applied" }, workspaceId);
  return { reward: rewardRows[0], slotRewardId: rewardRows[0].id };
}

function normalizeBountyState(value) {
  if (!value || typeof value !== "object") return { self: null, partner: null };
  if (value.self || value.partner) {
    return {
      self: value.self || null,
      partner: value.partner || null,
    };
  }
  if (value.taskId) return { self: value, partner: null };
  return { self: null, partner: null };
}

app.get("/api/todo-share", async (req, res) => {
  try {
    const share = await getActiveTodoShare(req.workspaceId);
    const pending = share ? await pool.query("SELECT COUNT(*)::int AS count FROM todo_sponsorships WHERE share_id = $1 AND status = 'pending'", [share.id]) : { rows: [{ count: 0 }] };
    res.json({ share: normalizeTodoShare(share, req), pendingCount: pending.rows[0].count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/todo-share", async (req, res) => {
  try {
    let share = await getActiveTodoShare(req.workspaceId);
    if (!share) {
      const { rows } = await pool.query(
        `INSERT INTO todo_shares (workspace_id, token, created_by, settings)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.workspaceId, makeShareToken(), req.session.userId || null, JSON.stringify({ encourageSignup: true })]
      );
      share = rows[0];
    }
    res.status(201).json({ share: normalizeTodoShare(share, req) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/todo-share/rotate", async (req, res) => {
  try {
    const share = await getActiveTodoShare(req.workspaceId);
    if (!share) return res.status(404).json({ error: "Share link is not enabled" });
    const { rows } = await pool.query(
      "UPDATE todo_shares SET token = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
      [share.id, makeShareToken()]
    );
    res.json({ share: normalizeTodoShare(rows[0], req) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// Social layer (multi-user, sponsor-first). Thin adapters over social-store.js.
// All routes are session-gated by the global auth middleware. The signed-in
// user is the actor: the owner for their own queue/feed/allowlist, the sponsor
// when offering a sponsorship to someone else.
// ══════════════════════════════════════════════════════════════════════════

// ── Sponsor allowlist (auto-approval source of truth) ──
// ── JSON route helpers ──
// Most handlers below share one shape: run a store call, send the result as
// JSON, and on a thrown error reply with its statusCode (or 500). `route` wraps
// that boilerplate so each handler is a one-liner. The fn may also drive res
// directly (e.g. res.status(201).json(...)) and return nothing to skip the
// default send. `intParam` parses a numeric path param.

app.get("/api/social/allowlist", route(req => socialStore.listAllowlist(req.session.userId)));

app.post("/api/social/allowlist", route(async (req, res) => {
  const { allowedUserId, scope = "both", note = "" } = req.body || {};
  if (!allowedUserId) throw badRequest("allowedUserId required");
  res.status(201).json(await socialStore.addAllowlistEntry({
    ownerUserId: req.session.userId, allowedUserId, scope, note, createdByUserId: req.session.userId,
  }));
}));

app.delete("/api/social/allowlist/:allowedUserId", route(async (req) => {
  await socialStore.removeAllowlistEntry(req.session.userId, intParam(req, "allowedUserId"));
  return { ok: true };
}));

// ── Friendships (social graph) ──
app.get("/api/social/friends", route(req => socialStore.listFriends(req.session.userId)));

app.get("/api/social/friends/requests", route(req => socialStore.listFriendRequests(req.session.userId)));

// Find a user to friend or sponsor, by exact username.
app.get("/api/social/users/lookup", route(async (req) => {
  const user = await auth.findUserByUsername(String(req.query.username || "").trim());
  if (!user) throw notFound("User not found");
  return { id: user.id, username: user.username };
}));

app.post("/api/social/friends/request", route(async (req, res) => {
  const { addresseeId } = req.body || {};
  if (!addresseeId) throw badRequest("addresseeId required");
  res.status(201).json(await socialStore.requestFriend(req.session.userId, parseInt(addresseeId, 10)));
}));

app.post("/api/social/friends/respond", route(async (req) => {
  const { requesterId, accept } = req.body || {};
  if (!requesterId) throw badRequest("requesterId required");
  return socialStore.respondFriend(req.session.userId, parseInt(requesterId, 10), accept !== false);
}));

app.post("/api/social/friends/block", route(async (req) => {
  const { otherId } = req.body || {};
  if (!otherId) throw badRequest("otherId required");
  return socialStore.blockUser(req.session.userId, parseInt(otherId, 10));
}));

// ── Sponsorships ──
// Offer a sponsorship to another user. The signed-in user is the sponsor.
app.post("/api/social/sponsorships", route(async (req, res) => {
  const { ownerUserId, targetType, targetId, rewardTitle, rewardDefinitionId = null,
          valueCents = 0, chanceShares = null, note = "", routes = null } = req.body || {};
  if (!ownerUserId || ((!targetType || !targetId) && !(Array.isArray(routes) && routes.length))) {
    throw badRequest("ownerUserId and at least one earning route required");
  }
  const first = Array.isArray(routes) && routes[0] || {};
  res.status(201).json(await socialStore.requestSponsorship({
    ownerUserId, sponsorUserId: req.session.userId, sponsorName: req.session.username || null,
    targetType: targetType || (first.type === "casino" ? "slot_machine" : "task"),
    targetId: targetId || first.targetId || (first.thresholdBankUnits ? "bank-units:" + first.thresholdBankUnits : "offer"),
    rewardTitle, rewardDefinitionId, valueCents, chanceShares, note, routes,
  }));
}));

// The signed-in user's incoming offers awaiting review.
app.get("/api/social/sponsorships/pending", route(req => socialStore.listPendingSponsorships(req.session.userId)));

app.post("/api/social/sponsorships/:id/approve", route(req =>
  socialStore.approveSponsorship(intParam(req, "id"), req.session.userId)));

app.post("/api/social/sponsorships/:id/reject", route(req =>
  socialStore.rejectSponsorship(intParam(req, "id"), req.session.userId)));

app.post("/api/social/sponsorships/:id/remove", route(req =>
  socialStore.removeSponsorship(intParam(req, "id"), req.session.userId)));

// ── Reward queue ──
app.get("/api/social/rewards/queue", route(req =>
  socialStore.listRewardQueue(req.session.userId, { status: req.query.status || null })));

app.post("/api/social/rewards/queue/:id/claim", route(req =>
  socialStore.claimReward(intParam(req, "id"), req.session.userId)));

// Schedule a won reward into the itinerary: the front-end places the block,
// then parks the chosen time + block id on the queue row.
app.post("/api/social/rewards/queue/:id/schedule", route((req) => {
  const { scheduledFor = null, blockId = null, expectedBlockId } = req.body || {};
  return socialStore.scheduleReward(intParam(req, "id"), req.session.userId, { scheduledFor, blockId, expectedBlockId });
}));

// Undo a schedule: reward returns to the queue (front-end removes the block).
app.post("/api/social/rewards/queue/:id/unschedule", route(req =>
  socialStore.unscheduleReward(intParam(req, "id"), req.session.userId)));

// Completing a scheduled reward's itinerary task is the real "burn". The
// front-end calls this with the completed block id; it redeems the parked
// reward (no-op when the block has none) and broadcasts so the queue refreshes.
app.post("/api/social/rewards/redeem-by-block", route(async (req) => {
  const blockId = (req.body && req.body.blockId) || null;
  const result = await socialStore.redeemScheduledByBlock(req.session.userId, blockId);
  if (result.changed) broadcast("slot-changed", { action: "reward-redeemed" }, req.workspaceId);
  return result;
}));

app.post("/api/social/rewards/queue/:id/redeem", route((req) => {
  // `actualSeconds` is the "Go do it now" stopwatch elapsed, recorded on the
  // redeem event so we can show how long the reward actually took.
  const actualSeconds = (req.body && req.body.actualSeconds != null) ? Number(req.body.actualSeconds) : null;
  return socialStore.redeemReward(intParam(req, "id"), req.session.userId,
    Number.isFinite(actualSeconds) ? { actualSeconds } : {});
}));

app.post("/api/social/rewards/queue/:id/discard", route(req =>
  socialStore.discardReward(intParam(req, "id"), req.session.userId)));

// ── Feed (opt-in publishing; private/work tasks can never publish) ──
app.get("/api/social/feed", route(req =>
  socialStore.listFriendsFeed(req.session.userId, { limit: parseInt(req.query.limit, 10) || 50 })));

app.post("/api/social/feed/:id/publish", route(req =>
  socialStore.publishPost(intParam(req, "id"), req.session.userId, { caption: (req.body || {}).caption || null })));

app.post("/api/social/feed/:id/hide", route(req =>
  socialStore.hidePost(intParam(req, "id"), req.session.userId)));

app.get("/api/todo-share/sponsorships", async (req, res) => {
  try {
    await ensureTodoShareTables();
    const { rows } = await pool.query(
      `SELECT *
         FROM todo_sponsorships
        WHERE workspace_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/todo-share/reactions", async (req, res) => {
  try {
    await ensureTodoShareTables();
    const requestedDate = coerceDateString(req.query.date);
    const date = isValidDate(requestedDate) ? requestedDate : getTodayStr();
    const share = await getActiveTodoShare(req.workspaceId);
    if (!share) return res.json({ date, reactions: {}, rows: [] });
    const { rows } = await pool.query(
      `SELECT task_id, task_date, task_block_id, task_title, identity_ids, emoji, COUNT(*)::int AS count
         FROM todo_task_reactions
        WHERE workspace_id = $1
          AND share_id = $2
          AND (task_date = $3::date OR task_date IS NULL)
        GROUP BY task_id, task_date, task_block_id, task_title, identity_ids, emoji
        ORDER BY task_title ASC, emoji ASC`,
      [req.workspaceId, share.id, date]
    );
    const byTask = {};
    rows.forEach(row => addReactionToMap(byTask, row));
    res.json({ date, shareId: share.id, reactions: byTask, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/todo-share/comments", async (req, res) => {
  try {
    await ensureTodoShareTables();
    const requestedDate = coerceDateString(req.query.date);
    const date = isValidDate(requestedDate) ? requestedDate : getTodayStr();
    const share = await getActiveTodoShare(req.workspaceId);
    if (!share) return res.json({ date, comments: {}, rows: [] });
    const { rows } = await pool.query(
      `SELECT task_id, task_date, task_block_id, task_title, identity_ids, body, author_name, author_kind, created_at
         FROM todo_task_comments
        WHERE workspace_id = $1
          AND share_id = $2
          AND (task_date = $3::date OR task_date IS NULL)
        ORDER BY created_at ASC`,
      [req.workspaceId, share.id, date]
    );
    const byTask = {};
    rows.forEach(row => addCommentToMap(byTask, row));
    res.json({ date, shareId: share.id, comments: byTask, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/todo-share/sponsorships/:id/status", async (req, res) => {
  try {
    await ensureTodoShareTables();
    await slotStore.ensureSchema();
    const status = String(req.body?.status || "").toLowerCase();
    if (!["approved", "dismissed", "pending"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const { rows: existingRows } = await pool.query(
      `SELECT *
         FROM todo_sponsorships
        WHERE id = $1 AND workspace_id = $2`,
      [Number(req.params.id), req.workspaceId]
    );
    if (!existingRows[0]) return res.status(404).json({ error: "Sponsorship not found" });
    let sponsorship = existingRows[0];
    let bounty = null;
    let reward = null;
    let slotRewardId = sponsorship.slot_reward_id || null;
    const userId = req.session?.userId || null;
    if (status === "approved" && sponsorship.kind === "bounty") {
      // Re-apply (idempotent) - sponsorships now activate on submit.
      bounty = await activateTodoShareBounty(sponsorship, userId);
    }
    if (status === "approved" && sponsorship.kind === "reward") {
      const applied = await applyTodoShareReward(sponsorship, req.workspaceId);
      reward = applied.reward;
      slotRewardId = applied.slotRewardId;
    }
    if (status === "dismissed" && sponsorship.kind === "bounty") {
      await revokeTodoShareBounty(sponsorship, userId);
    }
    if (status === "dismissed" && sponsorship.kind === "reward" && slotRewardId) {
      // Remove this sponsor's split; soft-delete the reward if nothing remains.
      const { rows: rewardRows } = await pool.query(
        "SELECT * FROM slot_rewards WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL",
        [req.workspaceId, slotRewardId]
      );
      const existingReward = rewardRows[0];
      if (existingReward) {
        const splits = (Array.isArray(existingReward.sponsor_splits) ? existingReward.sponsor_splits : [])
          .filter(split => String(split && split.sponsorshipId) !== String(sponsorship.id));
        if (!splits.length) {
          await pool.query("UPDATE slot_rewards SET deleted_at = NOW(), active = FALSE, updated_at = NOW() WHERE workspace_id = $1 AND id = $2", [req.workspaceId, slotRewardId]);
        } else {
          await pool.query("UPDATE slot_rewards SET sponsor_splits = $3, updated_at = NOW() WHERE workspace_id = $1 AND id = $2", [req.workspaceId, slotRewardId, JSON.stringify(splits)]);
        }
        broadcast("slot-changed", { action: "sponsored-reward-revoked" }, req.workspaceId);
      }
    }
    const { rows } = await pool.query(
      `UPDATE todo_sponsorships
          SET status = $3,
              slot_reward_id = COALESCE($4, slot_reward_id),
              updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING *`,
      [Number(req.params.id), req.workspaceId, status, slotRewardId]
    );
    sponsorship = rows[0];
    broadcast("todo-share-changed", { action: "sponsorship-status", id: sponsorship.id }, req.workspaceId);
    res.json({ sponsorship, reward, bounty });
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
});

app.get("/api/public/todo-share/:token", async (req, res) => {
  try {
    const share = await findTodoShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: "Shared todo list is unavailable" });
    await pool.query("UPDATE todo_shares SET last_viewed_at = NOW() WHERE id = $1", [share.id]);
    res.json(await buildPublicTodoShare(share, req.query.date, req));
  } catch (e) {
    // Same convention as the sibling POST below, and C5b is what gave this route a real
    // failure path: `buildPublicTodoShare` calls `buildDayResponse`, which now THROWS on an
    // unreadable day where it used to return a skeleton. This endpoint is ANONYMOUS and
    // polled every 15s, so a DB blip would otherwise hand a guest
    // "Day state unavailable for <date>: Postgres read failed and no file mirror exists".
    //
    // Failing closed here while the owner's own /api/state/day degrades to an empty day is
    // deliberate, not an accident of which caller was edited: a published list showing
    // nothing is indistinguishable from a list with nothing on it, and this one has an
    // audience.
    console.error("[public-todo] share read failed:", e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Could not load this list right now" });
  }
});

// ── Guest activity inbox ─────────────────────────────────────────────────────
// Comments and reactions were already stored, already fetched, and already drawn
// as chips on the itinerary row — but there was nowhere to answer "what did
// people say today". A per-row chip only works if you already know which row to
// look at, which is exactly what the owner doesn't know.
//
// One reverse-chronological union of the three things a visitor can leave
// behind. Guest-CREATED tasks are deliberately NOT here: they land in triage and
// already have an approval surface, so listing them again would be two inboxes
// for one decision.
//
// "Unread" rides `todo_shares.settings.activity_seen_at` rather than
// localStorage, so the badge follows the owner across devices instead of
// resetting on whichever browser last opened the modal.
const ACTIVITY_LIMIT = 60;

async function buildGuestActivity(workspaceId, share, { limit = ACTIVITY_LIMIT } = {}) {
  const capped = Math.max(1, Math.min(limit, 200));
  const [comments, reactions, sponsorships] = await Promise.all([
    pool.query(
      `SELECT task_id, task_date, task_title, body, author_name, author_kind, created_at
         FROM todo_task_comments
        WHERE workspace_id = $1 AND share_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, share.id, capped]
    ),
    pool.query(
      `SELECT task_id, task_date, task_title, emoji, actor_user_id, created_at
         FROM todo_task_reactions
        WHERE workspace_id = $1 AND share_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, share.id, capped]
    ),
    pool.query(
      `SELECT id, task_id, task_date, task_title, sponsor_name, reward_title, note,
              value_cents, kind, status, created_at
         FROM todo_sponsorships
        WHERE workspace_id = $1 AND share_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, share.id, capped]
    )
  ]);

  const items = [
    ...comments.rows.map(row => ({
      kind: "comment",
      at: row.created_at,
      actorName: row.author_name || "Guest",
      actorKind: row.author_kind || "guest",
      taskId: row.task_id,
      taskDate: row.task_date,
      taskTitle: row.task_title || "",
      body: row.body || ""
    })),
    ...reactions.rows.map(row => ({
      kind: "reaction",
      at: row.created_at,
      // Reactions carry no author name (only a hashed actor key), so there is
      // nothing honest to show but the tier. Inventing "Guest 4f2a" would read
      // as an identity the system does not actually have.
      actorName: row.actor_user_id ? "A signed-in visitor" : "A visitor",
      actorKind: row.actor_user_id ? "user" : "guest",
      taskId: row.task_id,
      taskDate: row.task_date,
      taskTitle: row.task_title || "",
      emoji: row.emoji
    })),
    ...sponsorships.rows.map(row => ({
      kind: "sponsorship",
      at: row.created_at,
      actorName: row.sponsor_name || "Someone",
      actorKind: "guest",
      taskId: row.task_id,
      taskDate: row.task_date,
      taskTitle: row.task_title || "",
      sponsorshipId: row.id,
      rewardTitle: row.reward_title || "",
      note: row.note || "",
      valueCents: row.value_cents || 0,
      offerKind: row.kind || "reward",
      status: row.status || "pending"
    }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, capped);

  const seenAt = (share.settings && share.settings.activity_seen_at) || null;
  return {
    items,
    seenAt,
    latestAt: items.length ? items[0].at : null,
    unreadCount: seenAt
      ? items.filter(item => new Date(item.at) > new Date(seenAt)).length
      : items.length
  };
}

app.get("/api/todo-share/activity", async (req, res) => {
  try {
    await ensureTodoShareTables();
    const share = await getActiveTodoShare(req.workspaceId);
    // No share link enabled is a normal state, not an error: the modal renders
    // an empty inbox and the badge stays at zero.
    if (!share) return res.json({ items: [], seenAt: null, latestAt: null, unreadCount: 0 });
    // `intParam` reads a PATH param; this is a query string, so parse it here.
    const requested = parseInt(req.query.limit, 10);
    res.json(await buildGuestActivity(req.workspaceId, share, {
      limit: Number.isFinite(requested) ? requested : ACTIVITY_LIMIT
    }));
  } catch (e) {
    console.error("[todo-share] activity read failed:", e);
    res.status(500).json({ error: "Could not load guest activity right now" });
  }
});

app.post("/api/todo-share/activity/seen", async (req, res) => {
  try {
    await ensureTodoShareTables();
    const share = await getActiveTodoShare(req.workspaceId);
    if (!share) return res.json({ seenAt: null });
    // Stamp with the newest item the CLIENT actually rendered, not NOW(): a
    // comment that lands between the read and this write would otherwise be
    // marked seen without ever having been shown.
    const requested = req.body && req.body.seenAt ? new Date(req.body.seenAt) : null;
    const seenAt = (requested && !isNaN(requested)) ? requested.toISOString() : new Date().toISOString();
    const { rows } = await pool.query(
      `UPDATE todo_shares
          SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('activity_seen_at', $2::text),
              updated_at = NOW()
        WHERE id = $1
      RETURNING settings`,
      [share.id, seenAt]
    );
    res.json({ seenAt: (rows[0] && rows[0].settings && rows[0].settings.activity_seen_at) || seenAt });
  } catch (e) {
    console.error("[todo-share] activity seen failed:", e);
    res.status(500).json({ error: "Could not save that right now" });
  }
});

// ── Export ───────────────────────────────────────────────────────────────────
// The "never going to use DCC" audience: hand them the day in a format their own
// system already reads. Serialization lives in public/js/share-export.js, shared
// verbatim with the browser download, so the two can't drift on what a task is.
//
// A range is capped at MAX_EXPORT_DAYS. Each day is a full `buildPublicTodoShare`
// (one day read plus a tombstone scan), the endpoint is ANONYMOUS, and the caller
// picks the bounds: an uncapped `from`/`to` is a link that runs 3650 day-reads
// against a pool capped at 10. Same reasoning as the guest-task date clamp above.
const MAX_EXPORT_DAYS = 31;

function exportDatesFrom(query) {
  const today = getTodayStr();
  const single = coerceDateString(query.date);
  const rawFrom = coerceDateString(query.from);
  const rawTo = coerceDateString(query.to);
  if (!rawFrom && !rawTo) {
    const date = isValidDate(single) ? single : today;
    return { dates: [date], from: date, to: date };
  }
  const from = isValidDate(rawFrom) ? rawFrom : today;
  const to = isValidDate(rawTo) ? rawTo : from;
  if (to < from) { const e = new Error("Range ends before it starts"); e.statusCode = 400; throw e; }
  const dates = [];
  const cursor = new Date(`${from}T12:00:00Z`);
  const last = new Date(`${to}T12:00:00Z`);
  while (cursor <= last && dates.length < MAX_EXPORT_DAYS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { dates, from: dates[0], to: dates[dates.length - 1] };
}

app.get("/api/public/todo-share/:token/export", async (req, res) => {
  try {
    const share = await findTodoShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: "Shared todo list is unavailable" });
    const format = String(req.query.format || "csv").toLowerCase();
    if (!shareExport.isFormat(format)) {
      return res.status(400).json({ error: "Unsupported format. Use csv, ics, or md." });
    }
    const { dates, from, to } = exportDatesFrom(req.query || {});
    const tasks = [];
    let workspaceName = "";
    let ownerUsername = "";
    for (const date of dates) {
      const day = await buildPublicTodoShare(share, date, req);
      workspaceName = workspaceName || day.workspaceName || "";
      ownerUsername = ownerUsername || day.ownerUsername || "";
      // The projection is day-scoped and leaves `date` implicit, which is fine for
      // a single-day payload and wrong the moment two days are in one file. Stamp
      // it here rather than teaching the projection about ranges.
      for (const task of (day.tasks || [])) if (task) tasks.push(Object.assign({}, task, { date }));
    }
    const meta = {
      workspaceName,
      owner: ownerUsername,
      date: from === to ? from : "",
      from,
      to,
      url: todoShareUrl(req, share.token)
    };
    const body = shareExport.serialize(format, tasks, meta);
    res.setHeader("Content-Type", shareExport.mimeFor(format));
    res.setHeader("Content-Disposition",
      `attachment; filename="${shareExport.filenameFor(meta, format)}"`);
    // A share link is rotatable and the day changes under it; a cached export is a
    // stale one handed out under a live URL.
    res.setHeader("Cache-Control", "no-store");
    res.send(body);
  } catch (e) {
    // Same fail-closed convention as the share GET: an anonymous caller never sees
    // Postgres text, and a partial file is worse than no file because it reads as
    // a complete day with tasks missing.
    console.error("[public-todo] export failed:", e);
    res.status(e.statusCode || 500).json({
      error: e.statusCode ? e.message : "Could not build that export right now"
    });
  }
});

app.post("/api/public/todo-share/:token/tasks", async (req, res) => {
  try {
    const share = await findTodoShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: "Shared todo list is unavailable" });
    const body = req.body || {};
    const title = String(body.title || "").trim().slice(0, 220);
    if (!title) return res.status(400).json({ error: "Task title is required" });
    const durationMinutes = Math.max(1, Math.min(240, Math.round(Number(body.durationMinutes || body.duration || 30) || 30)));
    const visitorName = String(body.visitorName || body.visitor_name || "").trim().slice(0, 80);
    const visitorEmail = String(body.visitorEmail || body.visitor_email || "").trim().slice(0, 180);
    const note = String(body.note || "").trim().slice(0, 1000);
    // CLAMPED to today or tomorrow. The 50-item cap is per (date, workspace) and the guest
    // chose the date, so without this it bounded nothing: a script walks dates, 50 items each,
    // minting a `dcc_state` row per date across every date Postgres accepts. `isValidDate` is
    // only a shape check (`/^\d{4}-\d{2}-\d{2}$/`, no range). Costs nothing to close — the real
    // client never sends `date` at all (public-todo-share.js posts name, email, title,
    // durationMinutes, note), so an arbitrary one is a stale client or an attempt to spread
    // past the cap.
    const todayStr = getTodayStr();
    const tomorrowStr = new Date(new Date(`${todayStr}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    const requestedDate = isValidDate(body.date) ? body.date : todayStr;
    const date = (requestedDate === todayStr || requestedDate === tomorrowStr) ? requestedDate : todayStr;
    // AWAITED as of C5b: the writer persists to Postgres now, and its DB save throws on
    // failure. Without the await this handler would answer 201 for a task that never landed,
    // and the enclosing catch (which turns it into a 500) would never see the rejection.
    const triageItem = await appendPublicShareTriageItem({
      share,
      date,
      title,
      durationMinutes,
      visitorName,
      visitorEmail,
      note,
      req
    });
    broadcast("dcc-state-changed", { source: "public-todo-triage", date }, share.workspace_id);
    broadcast("todo-share-changed", { action: "public-triage-create", id: triageItem.id }, share.workspace_id);
    res.status(201).json({ triageItem });
  } catch (e) {
    // C5b: the writer reaches Postgres now, so a `saveDccState` rejection lands here — and
    // this endpoint is ANONYMOUS. Raw Postgres error text carries table, column and
    // constraint names. Log the detail, return it only for the statuses this code raises
    // deliberately (503 unavailable, 429 guest cap), whose messages are written for a guest.
    console.error("[public-todo] guest task create failed:", e);
    // 500 by default, not 400. Every genuine validation failure in this handler is an early
    // `return res.status(400)`, so what reaches this catch is either a status this code set
    // deliberately (503 unavailable, 429 cap) or something unexpected — and telling a guest
    // "bad request" when Postgres is down is a lie that sends them to re-edit a fine task.
    // Found by probing with the DB stopped: `findTodoShareByToken` throws before the writer is
    // even reached, so an outage surfaced here as a 400.
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Could not save that task right now" });
  }
});

app.post("/api/public/todo-share/:token/sponsorships", async (req, res) => {
  try {
    const share = await findTodoShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: "Shared todo list is unavailable" });
    await ensureTodoShareTables();
    await slotStore.ensureSchema();
    const body = req.body || {};
    const tier = capabilities.resolveTier(req);
    const kind = String(body.kind || "bounty").toLowerCase() === "reward" ? "reward" : "bounty";
    // Capability gate: bounties require an account; reward sponsorship is guest-open.
    const capability = kind === "bounty" ? "place_bounty" : "sponsor_reward";
    if (!capabilities.can(tier, capability)) {
      return res.status(403).json({
        error: kind === "bounty" ? "Sign in to place a bounty" : "You can not sponsor rewards",
        capability,
        requiredTier: capabilities.CAPABILITY_MIN_TIER[capability]
      });
    }
    const sponsorName = String(body.sponsorName || body.sponsor_name || req.session?.username || "").trim().slice(0, 80);
    // Reward offers can target a specific task or the slot machine directly.
    const rewardTarget = kind === "reward" && String(body.target || body.rewardTarget || "").toLowerCase() === "slot" ? "slot" : "task";
    let taskId = String(body.taskId || body.task_id || "").trim().slice(0, 200);
    let taskTitle = String(body.taskTitle || body.task_title || "").trim().slice(0, 220);
    if (rewardTarget === "slot") { taskId = "slot-machine"; taskTitle = "Slot machine"; }
    const requestedDate = coerceDateString(body.date || body.taskDate || body.task_date);
    const taskDate = isValidDate(requestedDate) ? requestedDate : getTodayStr();
    // Private flag and slot-machine lifespan (expiry date and/or win-count cap).
    const rewardPrivate = body.rewardPrivate === true || body.private === true || body.public_visibility === "private";
    let rewardExpiresAt = null;
    if (rewardTarget === "slot") {
      if (body.expiresAt || body.expires_at) {
        const d = new Date(body.expiresAt || body.expires_at);
        if (!Number.isNaN(d.getTime())) rewardExpiresAt = d.toISOString();
      } else if (body.expiresInDays != null && body.expiresInDays !== "") {
        const days = Number(body.expiresInDays);
        if (Number.isFinite(days) && days > 0) rewardExpiresAt = new Date(Date.now() + Math.min(days, 365) * 86400000).toISOString();
      }
    }
    let rewardUses = null;
    if (rewardTarget === "slot" && body.uses != null && body.uses !== "") {
      const n = Number(body.uses);
      if (Number.isFinite(n) && n > 0) rewardUses = Math.min(Math.round(n), 9999);
    }
    // Optional reference to an existing reward already in the owner's rotation.
    let slotRewardId = null;
    let existingReward = null;
    if (kind === "reward" && (body.slotRewardId || body.rewardId || body.reward_id)) {
      const wantId = Number(body.slotRewardId || body.rewardId || body.reward_id);
      if (Number.isFinite(wantId)) {
        const { rows: rewardRows } = await pool.query(
          "SELECT id, title FROM slot_rewards WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL AND active = TRUE",
          [share.workspace_id, wantId]
        );
        if (!rewardRows[0]) return res.status(404).json({ error: "That reward is no longer available" });
        slotRewardId = rewardRows[0].id;
        existingReward = rewardRows[0];
      }
    }
    const rewardTitle = String(
      body.rewardTitle || body.reward_title || (existingReward && existingReward.title) ||
      (kind === "reward" ? "Sponsored reward" : "Double points bounty")
    ).trim().slice(0, 160);
    if (!sponsorName) return res.status(400).json({ error: "Your name is required" });
    if (!taskId || !taskTitle) return res.status(400).json({ error: rewardTarget === "slot" ? "Could not attach to the slot machine" : "Pick a task to sponsor" });
    if (kind === "reward" && !rewardTitle && !slotRewardId) return res.status(400).json({ error: "Reward description is required" });
    if (kind === "bounty") {
      const { rows: existingBounties } = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM todo_sponsorships
          WHERE share_id = $1
            AND sponsor_user_id = $2
            AND kind = 'bounty'
            AND created_at::date = CURRENT_DATE
            AND status <> 'dismissed'`,
        [share.id, req.session.userId]
      );
      if (existingBounties[0].count >= 1) return res.status(429).json({ error: "You can offer one bounty per day" });
    }
    // Record the sponsorship as already-approved (it activates on submit now).
    const { rows } = await pool.query(
      `INSERT INTO todo_sponsorships
       (workspace_id, share_id, task_id, task_date, task_block_id, task_title, sponsor_name, sponsor_email, sponsor_user_id, kind, reward_title, note, value_cents, slot_reward_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'approved')
       RETURNING *`,
      [
        share.workspace_id,
        share.id,
        taskId,
        taskDate,
        String(body.taskBlockId || body.task_block_id || "").slice(0, 200) || null,
        taskTitle,
        sponsorName,
        String(body.sponsorEmail || body.sponsor_email || "").trim().slice(0, 180) || null,
        req.session?.userId || null,
        kind,
        rewardTitle,
        String(body.note || "").trim().slice(0, 1000),
        centsFromBody(body.value || body.valueDollars || body.value_dollars),
        slotRewardId
      ]
    );
    let sponsorship = rows[0];
    // Activate immediately. If it fails, delete the row so no orphan stays behind.
    let reward = null;
    let bounty = null;
    try {
      if (kind === "bounty") {
        bounty = await activateTodoShareBounty(sponsorship, share.owner_id || null);
      } else {
        const applied = await applyTodoShareReward(sponsorship, share.workspace_id, { private: rewardPrivate, expiresAt: rewardExpiresAt, usesRemaining: rewardUses });
        reward = applied.reward;
        if (applied.slotRewardId && applied.slotRewardId !== sponsorship.slot_reward_id) {
          const { rows: updated } = await pool.query(
            "UPDATE todo_sponsorships SET slot_reward_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
            [sponsorship.id, applied.slotRewardId]
          );
          sponsorship = updated[0] || sponsorship;
        }
      }
    } catch (activationError) {
      await pool.query("DELETE FROM todo_sponsorships WHERE id = $1", [sponsorship.id]);
      throw activationError;
    }
    broadcast("todo-share-changed", { action: "sponsorship-create", id: sponsorship.id }, share.workspace_id);
    res.status(201).json({ ...sponsorship, reward, bounty });
  } catch (e) {
    // ANONYMOUS endpoint, same convention as the share GET and the guest task POST. C5b is what
    // made this reachable: `buildPublicTodoShare` now THROWS on a failed tombstone read and
    // `buildDayResponse` throws on an unreadable day, so a pool timeout or schema error inside
    // them was echoed verbatim here — and `public-todo-share.js` does `alert(e.message)`, so a
    // link holder got a browser alert full of table and constraint names. Hardening the
    // function without hardening all four of its callers is what left this open.
    //
    // 500, not 400: telling a guest their request was malformed when the server is down means
    // nothing retries. Deliberate statuses (503/429) keep their own guest-written text.
    console.error("[public-todo] sponsorship failed:", e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Could not record that right now" });
  }
});

app.post("/api/public/todo-share/:token/reactions", async (req, res) => {
  try {
    const share = await findTodoShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: "Shared todo list is unavailable" });
    const body = req.body || {};
    if (!capabilities.can(capabilities.resolveTier(req), "react")) return res.status(403).json({ error: "You can not react", capability: "react" });
    const emoji = String(body.emoji || "").trim();
    if (!["👍", "🙌", "🔥", "💪", "🎉", "❤️"].includes(emoji)) return res.status(400).json({ error: "Unsupported reaction" });
    const requestedDate = coerceDateString(body.date || body.taskDate || body.task_date || req.query.date);
    const taskDate = isValidDate(requestedDate) ? requestedDate : getTodayStr();
    const requestedTaskId = String(body.taskId || body.task_id || "").trim().slice(0, 200);
    if (!requestedTaskId) return res.status(400).json({ error: "Task is required" });
    const shareData = await buildPublicTodoShare(share, taskDate, req);
    const task = findPublicShareTask(shareData.tasks, requestedTaskId);
    if (!task) return res.status(404).json({ error: "Task is not available on this shared list" });
    const identityIds = task.identityIds && task.identityIds.length ? task.identityIds : publicTaskIdentityIds(task);
    const taskId = String(task.id);
    const taskBlockId = String(task.blockId || "").slice(0, 200) || null;
    const taskTitle = String(task.title || "").trim().slice(0, 220);
    const actorKey = todoActorKey(req);
    const deleted = await pool.query(
      `DELETE FROM todo_task_reactions
        WHERE share_id = $1 AND task_id = $2 AND emoji = $3 AND actor_key = $4 AND task_date = $5::date
        RETURNING id`,
      [share.id, taskId, emoji, actorKey, taskDate]
    );
    let active = false;
    if (!deleted.rowCount) {
      await pool.query(
        `INSERT INTO todo_task_reactions
         (workspace_id, share_id, task_id, task_date, task_block_id, task_title, identity_ids, emoji, actor_key, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          share.workspace_id,
          share.id,
          taskId,
          taskDate,
          taskBlockId,
          taskTitle,
          JSON.stringify(identityIds),
          emoji,
          actorKey,
          req.session?.userId || null
        ]
      );
      active = true;
    }
    const { rows: countRows } = await pool.query(
      `SELECT emoji, COUNT(*)::int AS count
         FROM todo_task_reactions
        WHERE share_id = $1 AND task_id = $2
          AND task_date = $3::date
        GROUP BY emoji`,
      [share.id, taskId, taskDate]
    );
    const { rows: viewerRows } = await pool.query(
      `SELECT emoji
         FROM todo_task_reactions
        WHERE share_id = $1 AND task_id = $2 AND actor_key = $3 AND task_date = $4::date`,
      [share.id, taskId, actorKey, taskDate]
    );
    const counts = {};
    countRows.forEach(row => { counts[row.emoji] = row.count; });
    broadcast("todo-share-changed", { action: "reaction", taskId, taskDate, emoji, active }, share.workspace_id);
    res.json({ counts, viewerReactions: viewerRows.map(row => row.emoji), active });
  } catch (e) {
    // ANONYMOUS endpoint, same convention as the share GET and the guest task POST. C5b is what
    // made this reachable: `buildPublicTodoShare` now THROWS on a failed tombstone read and
    // `buildDayResponse` throws on an unreadable day, so a pool timeout or schema error inside
    // them was echoed verbatim here — and `public-todo-share.js` does `alert(e.message)`, so a
    // link holder got a browser alert full of table and constraint names. Hardening the
    // function without hardening all four of its callers is what left this open.
    //
    // 500, not 400: telling a guest their request was malformed when the server is down means
    // nothing retries. Deliberate statuses (503/429) keep their own guest-written text.
    console.error("[public-todo] reaction failed:", e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Could not save that reaction right now" });
  }
});

app.post("/api/public/todo-share/:token/comments", async (req, res) => {
  try {
    const share = await findTodoShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: "Shared todo list is unavailable" });
    await ensureTodoShareTables();
    const tier = capabilities.resolveTier(req);
    if (!capabilities.can(tier, "comment")) return res.status(403).json({ error: "You can not comment", capability: "comment" });
    const body = req.body || {};
    const text = String(body.body || body.comment || "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "Comment is required" });
    const requestedDate = coerceDateString(body.date || body.taskDate || body.task_date || req.query.date);
    const taskDate = isValidDate(requestedDate) ? requestedDate : getTodayStr();
    const requestedTaskId = String(body.taskId || body.task_id || "").trim().slice(0, 200);
    if (!requestedTaskId) return res.status(400).json({ error: "Task is required" });
    const shareData = await buildPublicTodoShare(share, taskDate, req);
    const task = findPublicShareTask(shareData.tasks, requestedTaskId);
    if (!task) return res.status(404).json({ error: "Task is not available on this shared list" });
    const identityIds = task.identityIds && task.identityIds.length ? task.identityIds : publicTaskIdentityIds(task);
    const taskId = String(task.id);
    const taskBlockId = String(task.blockId || "").slice(0, 200) || null;
    const taskTitle = String(task.title || "").trim().slice(0, 220);
    const authorName = String(body.authorName || body.author_name || req.session?.username || "Guest").trim().slice(0, 80) || "Guest";
    const authorKind = req.session?.userId ? "user" : "guest";
    const actorKey = todoActorKey(req);
    const { rows } = await pool.query(
      `INSERT INTO todo_task_comments
       (workspace_id, share_id, task_id, task_date, task_block_id, task_title, identity_ids, body, author_name, author_kind, actor_key, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING body, author_name, author_kind, created_at`,
      [
        share.workspace_id,
        share.id,
        taskId,
        taskDate,
        taskBlockId,
        taskTitle,
        JSON.stringify(identityIds),
        text,
        authorName,
        authorKind,
        actorKey,
        req.session?.userId || null
      ]
    );
    const { rows: listRows } = await pool.query(
      `SELECT body, author_name, author_kind, created_at
         FROM todo_task_comments
        WHERE share_id = $1 AND task_id = $2 AND task_date = $3::date
        ORDER BY created_at ASC`,
      [share.id, taskId, taskDate]
    );
    const comments = listRows.map(row => ({
      body: row.body,
      authorName: row.author_name || "",
      authorKind: row.author_kind || "guest",
      createdAt: row.created_at
    }));
    broadcast("todo-share-changed", { action: "comment", taskId, taskDate }, share.workspace_id);
    res.status(201).json({ comment: comments[comments.length - 1], comments });
  } catch (e) {
    // ANONYMOUS endpoint, same convention as the share GET and the guest task POST. C5b is what
    // made this reachable: `buildPublicTodoShare` now THROWS on a failed tombstone read and
    // `buildDayResponse` throws on an unreadable day, so a pool timeout or schema error inside
    // them was echoed verbatim here — and `public-todo-share.js` does `alert(e.message)`, so a
    // link holder got a browser alert full of table and constraint names. Hardening the
    // function without hardening all four of its callers is what left this open.
    //
    // 500, not 400: telling a guest their request was malformed when the server is down means
    // nothing retries. Deliberate statuses (503/429) keep their own guest-written text.
    console.error("[public-todo] comment failed:", e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : "Could not post that comment right now" });
  }
});

};
