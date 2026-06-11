// Extracted from server.js — mounted via routes/index pattern: module.exports(app, ctx).
// ctx carries shared server-scope helpers/stores; see server.js where ctx is built.

module.exports = function mount(app, ctx) {
  const { APP_TIME_ZONE, DAY_STATE_FILE, auth, badRequest, blockDB, broadcast, buildDayResponse, buildSkeletonState, capabilities, coerceDateString, crypto, filterLegacyGcalBlocks, getDayFilePath, getRequestOrigin, getTodayStr, intParam, isValidDate, notFound, path, pool, readJSON, route, scoreTaskPoints, session, slotStore, socialStore, updateManifest, writeJSON } = ctx;

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
  const blocks = filterLegacyGcalBlocks(await blockDB.getBlocksByDate(date, share.workspace_id));
  const root = blocks.find(b => b.type === "day_root");
  const rootProps = root && root.properties ? root.properties : {};
  const rootDone = rootProps._done || {};
  const doneIds = new Set([
    ...((rootDone.ids || []).map(String)),
    ...Object.keys(rootDone.at || {}).map(String)
  ]);
  const hiddenIds = new Set([
    ...((rootProps._deleted || [])).map(String),
    ...(((rootProps._pushed && rootProps._pushed.ids) || [])).map(String)
  ]);
  for (const block of blocks) {
    const p = block.properties || {};
    const aliases = publicTaskIdentityIds({
      id: p.local_id || block.id,
      local_id: p.local_id,
      blockId: block.id,
      block_id: block.id,
      source_id: p.source_id,
      sourceId: p.sourceId,
      gcal_event_id: p.gcal_event_id
    });
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

function appendPublicShareTriageItem({ share, date, title, durationMinutes, visitorName, visitorEmail, note, req }) {
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
  const state = readJSON(dayFile, null) || buildSkeletonState(date);
  if (!state.triage) state.triage = { open_items: [], resolved_items: [], cycle_count: 0 };
  if (!Array.isArray(state.triage.open_items)) state.triage.open_items = [];
  if (!Array.isArray(state.triage.resolved_items)) state.triage.resolved_items = [];
  state.triage.open_items.push(item);
  if (state.sweep) state.sweep.open_item_count = state.triage.open_items.length;
  state.last_updated_at = now;
  state.last_updated_by = "public-todo-triage";
  writeJSON(dayFile, state);
  updateManifest(date);
  if (date === getTodayStr()) writeJSON(DAY_STATE_FILE, state);
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
          valueCents = 0, chanceShares = null, note = "" } = req.body || {};
  if (!ownerUserId || !targetType || !targetId) throw badRequest("ownerUserId, targetType, targetId required");
  res.status(201).json(await socialStore.requestSponsorship({
    ownerUserId, sponsorUserId: req.session.userId, sponsorName: req.session.username || null,
    targetType, targetId, rewardTitle, rewardDefinitionId, valueCents, chanceShares, note,
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
  const { scheduledFor = null, blockId = null } = req.body || {};
  return socialStore.scheduleReward(intParam(req, "id"), req.session.userId, { scheduledFor, blockId });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const date = isValidDate(body.date) ? body.date : getTodayStr();
    const triageItem = appendPublicShareTriageItem({
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
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
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
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  } catch (e) { res.status(400).json({ error: e.message }); }
});

};
