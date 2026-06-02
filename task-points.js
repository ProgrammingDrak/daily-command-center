const crypto = require("crypto");
const pool = require("./pg-pool");
const slotStore = require("./slot-store");

const EFFORT_POINTS = { tiny: 5, small: 10, medium: 25, large: 50, major: 100 };
const IMPORTANCE_MULTIPLIER = { low: 0.5, normal: 1, important: 1.5, high_leverage: 2, mission_critical: 3 };
const TIMING_MULTIPLIER = { late: 0.7, unplanned_same_day: 0.9, during_planned_time: 1.2, before_deadline: 1.5, meaningfully_early: 1.8 };
const QUALITY_MULTIPLIER = { weak: 0.3, rough: 0.8, done: 1, excellent: 1.2 };

const BONUS_TYPES = new Set([
  "hard_thing",
  "right_bet",
  "beat_odds",
  "protected_priority",
  "unblocked",
  "recovered_momentum",
  "learned_from_bad_outcome",
]);
const NORMAL_BONUS_TYPES = new Set(["hard_thing", "right_bet", "protected_priority", "unblocked", "recovered_momentum", "learned_from_bad_outcome"]);

function clampProbability(value) {
  const n = Number(value);
  return [0.25, 0.5, 0.8].includes(n) ? n : null;
}

function normalizeKey(value, allowed, fallback) {
  const key = String(value || "").toLowerCase().trim();
  return allowed[key] !== undefined ? key : fallback;
}

function inferEffort(durationMinutes) {
  const min = Number(durationMinutes) || 0;
  if (min <= 15) return "tiny";
  if (min <= 45) return "small";
  if (min <= 90) return "medium";
  if (min <= 180) return "large";
  return "major";
}

function inferImportance(priority) {
  const p = String(priority || "").toLowerCase();
  if (p.includes("mission") || p.includes("critical")) return "mission_critical";
  if (p.includes("urgent") || p.includes("highest")) return "high_leverage";
  if (p.includes("high")) return "important";
  if (p.includes("low") || p.includes("trivial")) return "low";
  return "normal";
}

function parseTime(value, date) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value);
  const dt = raw.includes("T") ? new Date(raw) : new Date(`${date || new Date().toISOString().slice(0, 10)}T${raw.length === 5 ? raw + ":00" : raw}`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function timingBucket(input) {
  const completed = parseTime(input.completed_at || input.completedAt || new Date().toISOString(), input.date);
  const start = parseTime(input.start || input.planned_start, input.date);
  const end = parseTime(input.end || input.planned_end || input.due_at, input.date);
  if (!completed || (!start && !end)) return "unplanned_same_day";
  if (end && completed > end) return "late";
  if (start && completed <= new Date(start.getTime() - 60 * 60000)) return "meaningfully_early";
  if (start && completed < start) return "before_deadline";
  if (start && end && completed >= start && completed <= end) return "during_planned_time";
  if (end && completed <= end) return "before_deadline";
  return "unplanned_same_day";
}

function calculateTaskPoints(input = {}) {
  const effort = normalizeKey(input.effort_size || input.effortSize, EFFORT_POINTS, inferEffort(input.duration_minutes || input.durationMinutes));
  const importance = normalizeKey(input.importance, IMPORTANCE_MULTIPLIER, inferImportance(input.priority));
  const quality = normalizeKey(input.quality, QUALITY_MULTIPLIER, "done");
  const timing = timingBucket(input);
  const base = EFFORT_POINTS[effort];
  const raw = base * IMPORTANCE_MULTIPLIER[importance] * TIMING_MULTIPLIER[timing] * QUALITY_MULTIPLIER[quality];
  const points = Math.max(1, Math.round(raw));
  return {
    points,
    base,
    effort,
    importance,
    timing,
    quality,
    multipliers: {
      importance: IMPORTANCE_MULTIPLIER[importance],
      timing: TIMING_MULTIPLIER[timing],
      quality: QUALITY_MULTIPLIER[quality],
    },
  };
}

function taskBaseValue(input = {}) {
  const effort = normalizeKey(input.effort_size || input.effortSize, EFFORT_POINTS, inferEffort(input.duration_minutes || input.durationMinutes));
  const importance = normalizeKey(input.importance, IMPORTANCE_MULTIPLIER, inferImportance(input.priority));
  return Math.round(EFFORT_POINTS[effort] * IMPORTANCE_MULTIPLIER[importance]);
}

function bonusPoints(input = {}) {
  const type = String(input.type || "").trim();
  if (!BONUS_TYPES.has(type)) throw new Error("invalid bonus type");
  const intensity = String(input.intensity || "normal").toLowerCase();
  if (type === "hard_thing") return intensity === "major" ? 50 : intensity === "small" ? 10 : 25;
  if (type === "right_bet") return intensity === "major" ? 40 : 20;
  if (type === "beat_odds") {
    const probability = clampProbability(input.predicted_success_probability || input.predictedSuccessProbability) || 0.5;
    return Math.max(15, Math.min(75, Math.round(taskBaseValue(input) * (1 - probability) * 0.75)));
  }
  if (type === "protected_priority") return 25;
  if (type === "unblocked") return 30;
  if (type === "recovered_momentum") return 15;
  if (type === "learned_from_bad_outcome") return 20;
  return 0;
}

async function ensureSchema() {
  await slotStore.ensureSchema();
  await pool.query("ALTER TABLE slot_point_ledger ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'");
}

async function insertLedger({ workspaceId, userId, delta, sourceType, sourceKey, description, metadata }) {
  await ensureSchema();
  await slotStore.ensureAccount(workspaceId, userId);
  const { rows } = await pool.query(
    `INSERT INTO slot_point_ledger (workspace_id, user_id, delta, source_type, source_key, description, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id, source_type, source_key) DO NOTHING
     RETURNING *`,
    [workspaceId, userId || null, delta, sourceType, sourceKey, description, metadata || {}]
  );
  if (rows[0]) {
    await pool.query("UPDATE slot_accounts SET point_balance = point_balance + $2, updated_at=NOW() WHERE workspace_id=$1", [workspaceId, delta]);
  }
  const state = await slotStore.getState(workspaceId, userId);
  return { awarded: !!rows[0], row: rows[0] || null, account: state.account };
}

async function awardTaskCompletion(workspaceId, userId, body = {}) {
  const taskId = String(body.task_id || body.taskId || "").trim();
  if (!taskId) throw new Error("task_id required");
  const date = String(body.date || new Date().toISOString().slice(0, 10));
  const breakdown = calculateTaskPoints(body);
  const sourceKey = `${date}:${taskId}`;
  const result = await insertLedger({
    workspaceId,
    userId,
    delta: breakdown.points,
    sourceType: "task_complete_v2",
    sourceKey,
    description: String(body.title || "Task completed"),
    metadata: { ...body, date, task_id: taskId, breakdown },
  });
  return { awarded: result.awarded, points: result.awarded ? breakdown.points : 0, breakdown, account: result.account };
}

async function getBonusCaps(workspaceId, date) {
  const { rows } = await pool.query(
    `SELECT source_type, metadata
     FROM slot_point_ledger
     WHERE workspace_id=$1
       AND source_type IN ('task_bonus','standalone_bonus')
       AND COALESCE(metadata->>'date', to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')) = $2`,
    [workspaceId, date]
  );
  let normalUsed = 0;
  let majorUsed = 0;
  rows.forEach(row => {
    const md = row.metadata || {};
    if (md.intensity === "major" || md.type === "beat_odds") majorUsed++;
    else normalUsed++;
  });
  return { normalUsed, majorUsed, normalRemaining: Math.max(0, 3 - normalUsed), majorRemaining: Math.max(0, 1 - majorUsed) };
}

async function awardBonus(workspaceId, userId, body = {}) {
  const reflection = String(body.reflection || "").trim();
  if (!reflection) throw new Error("reflection required");
  const type = String(body.type || "").trim();
  if (!BONUS_TYPES.has(type)) throw new Error("invalid bonus type");
  const date = String(body.date || new Date().toISOString().slice(0, 10));
  const intensity = String(body.intensity || "normal").toLowerCase();
  const caps = await getBonusCaps(workspaceId, date);
  const isMajor = intensity === "major" || type === "beat_odds";
  if (isMajor && caps.majorRemaining <= 0) throw new Error("major bonus cap reached for today");
  if (!isMajor && caps.normalRemaining <= 0) throw new Error("normal bonus cap reached for today");
  const points = bonusPoints(body);
  const taskId = body.task_id || body.taskId || null;
  const sourceType = taskId ? "task_bonus" : "standalone_bonus";
  const sourceKey = `${date}:${taskId || "standalone"}:${type}:${crypto.randomUUID()}`;
  const result = await insertLedger({
    workspaceId,
    userId,
    delta: points,
    sourceType,
    sourceKey,
    description: reflection,
    metadata: { ...body, date, type, intensity, task_id: taskId, reflection, points },
  });
  return { awarded: result.awarded, points: result.awarded ? points : 0, account: result.account, caps: await getBonusCaps(workspaceId, date) };
}

async function getDay(workspaceId, date) {
  await ensureSchema();
  await slotStore.ensureAccount(workspaceId, null);
  const { rows } = await pool.query(
    `SELECT id, delta, source_type, source_key, description, metadata, created_at
     FROM slot_point_ledger
     WHERE workspace_id=$1
       AND source_type IN ('task_complete_v2','task_bonus','standalone_bonus')
       AND COALESCE(metadata->>'date', to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')) = $2
     ORDER BY created_at DESC, id DESC`,
    [workspaceId, date]
  );
  const caps = await getBonusCaps(workspaceId, date);
  return { date, rows, totalPoints: rows.reduce((sum, row) => sum + (row.delta || 0), 0), caps };
}

module.exports = {
  ensureSchema,
  calculateTaskPoints,
  awardTaskCompletion,
  awardBonus,
  getDay,
};
