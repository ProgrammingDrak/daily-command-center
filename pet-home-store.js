const crypto = require("crypto");
const pool = require("./pg-pool");

const DEFAULT_HOME = {
  pet: {
    name: "Mochi",
    base: "sprout",
    color: "#f2b56b",
    accessory: "bandana"
  },
  home: {
    style: "cozy",
    equippedDecor: ["woven-rug", "sunny-window", "whiteboard", "food-bowl"],
    unlockedDecor: ["woven-rug", "sunny-window", "whiteboard", "food-bowl"]
  }
};

const DECOR_CATALOG = [
  { id: "woven-rug", name: "Woven Rug", cost: 0, zone: "room" },
  { id: "sunny-window", name: "Sunny Window", cost: 0, zone: "room" },
  { id: "whiteboard", name: "Task Whiteboard", cost: 0, zone: "room" },
  { id: "food-bowl", name: "Food Bowl", cost: 0, zone: "care" },
  { id: "garden-pot", name: "Garden Pot", cost: 8, zone: "garden" },
  { id: "slot-corner", name: "Slot Corner", cost: 12, zone: "special" },
  { id: "reading-nook", name: "Reading Nook", cost: 15, zone: "room" },
  { id: "flower-box", name: "Flower Box", cost: 18, zone: "garden" },
  { id: "tiny-fountain", name: "Tiny Fountain", cost: 25, zone: "garden" }
];

function clamp(n, min, max) {
  const value = Number(n);
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeText(value, fallback = "") {
  return String(value == null ? fallback : value).trim().slice(0, 500);
}

function publicUrl(req, slug) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host");
  return `${proto}://${host}/pet/${slug}`;
}

function generateSlug() {
  return crypto.randomBytes(9).toString("base64url");
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pet_homes (
      workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id),
      user_id            INTEGER REFERENCES users(id),
      pet                JSONB NOT NULL DEFAULT '{}',
      home               JSONB NOT NULL DEFAULT '{}',
      food_level         INTEGER NOT NULL DEFAULT 50,
      mood_level         INTEGER NOT NULL DEFAULT 55,
      decor_currency     INTEGER NOT NULL DEFAULT 0,
      share_slug         TEXT UNIQUE,
      public_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pet_home_events (
      id             SERIAL PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
      user_id        INTEGER REFERENCES users(id),
      event_type     TEXT NOT NULL,
      source_type    TEXT NOT NULL DEFAULT 'manual',
      source_key     TEXT NOT NULL,
      actor_name     TEXT,
      message        TEXT,
      metadata       JSONB NOT NULL DEFAULT '{}',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pet_home_events_source
      ON pet_home_events(workspace_id, source_type, source_key);

    CREATE INDEX IF NOT EXISTS idx_pet_home_events_workspace_created
      ON pet_home_events(workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS pet_task_suggestions (
      id              SERIAL PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
      visitor_name    TEXT NOT NULL,
      title           TEXT NOT NULL,
      note            TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'pending',
      approved_block_id TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pet_task_suggestions_workspace_status
      ON pet_task_suggestions(workspace_id, status, created_at DESC);
  `);
}

async function ensureHome(workspaceId, userId) {
  await ensureSchema();
  const now = new Date().toISOString();
  const { rows } = await pool.query("SELECT * FROM pet_homes WHERE workspace_id = $1", [workspaceId]);
  if (rows[0]) return rows[0];
  const inserted = await pool.query(
    `INSERT INTO pet_homes (workspace_id, user_id, pet, home, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5)
     RETURNING *`,
    [workspaceId, userId || null, DEFAULT_HOME.pet, DEFAULT_HOME.home, now]
  );
  return inserted.rows[0];
}

function shapeHome(row) {
  const pet = { ...DEFAULT_HOME.pet, ...(row.pet || {}) };
  const home = { ...DEFAULT_HOME.home, ...(row.home || {}) };
  return {
    workspaceId: row.workspace_id,
    pet,
    home,
    foodLevel: row.food_level,
    moodLevel: row.mood_level,
    decorCurrency: row.decor_currency,
    shareSlug: row.share_slug,
    publicEnabled: row.public_enabled,
    updatedAt: row.updated_at,
    decorCatalog: DECOR_CATALOG
  };
}

async function recentEvents(workspaceId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, event_type, actor_name, message, metadata, created_at
     FROM pet_home_events
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit]
  );
  return rows;
}

async function listSuggestions(workspaceId, status = null) {
  const params = [workspaceId];
  let where = "workspace_id = $1";
  if (status) {
    params.push(status);
    where += " AND status = $2";
  }
  const { rows } = await pool.query(
    `SELECT id, visitor_name, title, note, status, approved_block_id, created_at, updated_at
     FROM pet_task_suggestions
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT 100`,
    params
  );
  return rows;
}

async function getState(workspaceId, userId) {
  const home = await ensureHome(workspaceId, userId);
  return {
    home: shapeHome(home),
    events: await recentEvents(workspaceId),
    suggestions: await listSuggestions(workspaceId)
  };
}

async function updateState(workspaceId, userId, patch) {
  const existing = await ensureHome(workspaceId, userId);
  const current = shapeHome(existing);
  const petPatch = patch.pet && typeof patch.pet === "object" ? patch.pet : {};
  const homePatch = patch.home && typeof patch.home === "object" ? patch.home : {};
  const pet = {
    ...current.pet,
    ...petPatch,
    name: safeText(petPatch.name, current.pet.name).slice(0, 40) || current.pet.name,
    color: safeText(petPatch.color, current.pet.color).slice(0, 24) || current.pet.color
  };
  const home = {
    ...current.home,
    ...homePatch,
    equippedDecor: Array.isArray(homePatch.equippedDecor) ? homePatch.equippedDecor.slice(0, 24) : current.home.equippedDecor,
    unlockedDecor: Array.isArray(homePatch.unlockedDecor) ? homePatch.unlockedDecor.slice(0, 64) : current.home.unlockedDecor
  };
  const publicEnabled = patch.publicEnabled == null ? current.publicEnabled : !!patch.publicEnabled;
  const decorCurrency = patch.decorCurrency == null ? current.decorCurrency : clamp(patch.decorCurrency, 0, 1000000);
  const { rows } = await pool.query(
    `UPDATE pet_homes
     SET pet = $1, home = $2, public_enabled = $3, decor_currency = $4, updated_at = NOW()
     WHERE workspace_id = $5
     RETURNING *`,
    [pet, home, publicEnabled, decorCurrency, workspaceId]
  );
  return getState(workspaceId, userId || rows[0].user_id);
}

async function enableShare(workspaceId, userId) {
  let home = await ensureHome(workspaceId, userId);
  let slug = home.share_slug;
  while (!slug) {
    const candidate = generateSlug();
    const { rows } = await pool.query("SELECT workspace_id FROM pet_homes WHERE share_slug = $1", [candidate]);
    if (!rows.length) slug = candidate;
  }
  const updated = await pool.query(
    `UPDATE pet_homes SET share_slug = $1, public_enabled = TRUE, updated_at = NOW()
     WHERE workspace_id = $2 RETURNING *`,
    [slug, workspaceId]
  );
  return shapeHome(updated.rows[0]);
}

async function rotateShare(workspaceId, userId) {
  await ensureHome(workspaceId, userId);
  let slug = null;
  while (!slug) {
    const candidate = generateSlug();
    const { rows } = await pool.query("SELECT workspace_id FROM pet_homes WHERE share_slug = $1", [candidate]);
    if (!rows.length) slug = candidate;
  }
  const updated = await pool.query(
    `UPDATE pet_homes SET share_slug = $1, public_enabled = TRUE, updated_at = NOW()
     WHERE workspace_id = $2 RETURNING *`,
    [slug, workspaceId]
  );
  return shapeHome(updated.rows[0]);
}

async function awardTaskCare(workspaceId, userId, payload) {
  const home = await ensureHome(workspaceId, userId);
  const taskId = safeText(payload.task_id || payload.taskId, "");
  if (!taskId) throw new Error("task_id required");
  const sourceDate = safeText(payload.sourceDate || payload.source_date, new Date().toISOString().slice(0, 10)).slice(0, 10);
  const sourceKey = `${sourceDate}:${taskId}`;
  const points = clamp(payload.awardPoints || payload.award_points || 8, 1, 80);
  const foodDelta = clamp(Math.round(points / 2), 4, 18);
  const moodDelta = clamp(Math.round(points / 3), 3, 12);
  const currencyDelta = clamp(Math.round(points / 5), 1, 16);
  const event = await pool.query(
    `INSERT INTO pet_home_events
       (workspace_id, user_id, event_type, source_type, source_key, message, metadata)
     VALUES ($1,$2,'task_feed','task_completion',$3,$4,$5)
     ON CONFLICT (workspace_id, source_type, source_key) DO NOTHING
     RETURNING id`,
    [
      workspaceId,
      userId || home.user_id || null,
      sourceKey,
      `${safeText(payload.title, "Task")} fed the pet.`,
      { taskId, sourceDate, foodDelta, moodDelta, currencyDelta, title: safeText(payload.title, "Task") }
    ]
  );
  if (!event.rows.length) return { awarded: false, home: shapeHome(home) };
  const updated = await pool.query(
    `UPDATE pet_homes
     SET food_level = LEAST(100, food_level + $1),
         mood_level = LEAST(100, mood_level + $2),
         decor_currency = decor_currency + $3,
         updated_at = NOW()
     WHERE workspace_id = $4
     RETURNING *`,
    [foodDelta, moodDelta, currencyDelta, workspaceId]
  );
  return { awarded: true, foodDelta, moodDelta, currencyDelta, home: shapeHome(updated.rows[0]) };
}

async function getPublicHome(shareSlug, todayStr) {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT * FROM pet_homes WHERE share_slug = $1 AND public_enabled = TRUE",
    [shareSlug]
  );
  const home = rows[0];
  if (!home) return null;
  const workspaceId = home.workspace_id;
  const blocks = await pool.query(
    `SELECT id, type, date, properties, sort_order, created_at
     FROM blocks
     WHERE workspace_id = $1 AND date = $2 AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [workspaceId, todayStr]
  );
  const dayRoot = blocks.rows.find(b => b.type === "day_root");
  const doneIds = new Set((((dayRoot || {}).properties || {})._done || {}).ids || []);
  const tasks = blocks.rows
    .filter(b => b.type !== "day_root")
    .map(b => ({ block: b, props: b.properties || {} }))
    .filter(({ props }) => props.publicVisibility !== "private")
    .filter(({ props }) => props.title || props.label || props.text)
    .filter(({ props }) => !["meeting", "break", "ooo"].includes(String(props.kind || props.type || "").toLowerCase()))
    .map(({ block, props }) => ({
      id: block.id,
      title: props.title || props.label || props.text,
      start: props.start || null,
      end: props.end || null,
      priority: props.priority || "",
      status: doneIds.has(props.local_id || block.id) || doneIds.has(block.id) ? "done" : "open"
    }));
  return {
    home: shapeHome(home),
    tasks,
    events: await recentEvents(workspaceId, 30),
    today: todayStr
  };
}

async function addEncouragement(shareSlug, visitorName, message) {
  const { rows } = await pool.query(
    "SELECT workspace_id FROM pet_homes WHERE share_slug = $1 AND public_enabled = TRUE",
    [shareSlug]
  );
  if (!rows[0]) return null;
  const workspaceId = rows[0].workspace_id;
  const cleanName = safeText(visitorName, "Guest").slice(0, 60) || "Guest";
  const cleanMessage = safeText(message, "").slice(0, 500);
  if (!cleanMessage) throw new Error("message required");
  const sourceKey = `encouragement:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
  await pool.query(
    `INSERT INTO pet_home_events (workspace_id, event_type, source_type, source_key, actor_name, message)
     VALUES ($1,'encouragement','visitor',$2,$3,$4)`,
    [workspaceId, sourceKey, cleanName, cleanMessage]
  );
  return { ok: true };
}

async function addSuggestion(shareSlug, visitorName, title, note) {
  const { rows } = await pool.query(
    "SELECT workspace_id FROM pet_homes WHERE share_slug = $1 AND public_enabled = TRUE",
    [shareSlug]
  );
  if (!rows[0]) return null;
  const workspaceId = rows[0].workspace_id;
  const cleanName = safeText(visitorName, "Guest").slice(0, 60) || "Guest";
  const cleanTitle = safeText(title, "").slice(0, 160);
  if (!cleanTitle) throw new Error("title required");
  const inserted = await pool.query(
    `INSERT INTO pet_task_suggestions (workspace_id, visitor_name, title, note)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [workspaceId, cleanName, cleanTitle, safeText(note, "").slice(0, 500)]
  );
  await pool.query(
    `INSERT INTO pet_home_events (workspace_id, event_type, source_type, source_key, actor_name, message, metadata)
     VALUES ($1,'task_suggestion','visitor',$2,$3,$4,$5)`,
    [workspaceId, `suggestion:${inserted.rows[0].id}`, cleanName, cleanTitle, { suggestionId: inserted.rows[0].id }]
  );
  return inserted.rows[0];
}

async function markSuggestion(workspaceId, id, status, approvedBlockId = null) {
  const { rows } = await pool.query(
    `UPDATE pet_task_suggestions
     SET status = $1, approved_block_id = COALESCE($2, approved_block_id), updated_at = NOW()
     WHERE id = $3 AND workspace_id = $4
     RETURNING *`,
    [status, approvedBlockId, id, workspaceId]
  );
  return rows[0] || null;
}

module.exports = {
  DECOR_CATALOG,
  publicUrl,
  ensureSchema,
  getState,
  updateState,
  enableShare,
  rotateShare,
  awardTaskCare,
  getPublicHome,
  addEncouragement,
  addSuggestion,
  listSuggestions,
  markSuggestion
};
