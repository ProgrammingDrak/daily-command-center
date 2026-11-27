// game-store.js — Postgres side of the XP / streak game (Phase 1).
//
// xp_events is the source of truth for XP. Every award has a unique
// (workspace_id, source_key), so a retried request, a replayed completion or a
// second run of the day-close can never award twice. Reopening a task VOIDS its
// rows (voided_at); it never writes negative points. Completing it again revives
// the same rows.
//
// The pure math lives in game/rules.js; this file only loads and saves.
"use strict";

const CONFIG = require("./game/config");
const R = require("./game/rules");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS daily_intentions (
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             INTEGER REFERENCES users(id),
  date                DATE NOT NULL,
  big3                TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(big3) <= 3),
  minimum_day         TEXT NOT NULL DEFAULT '',
  minimum_day_done_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, date)
);

CREATE TABLE IF NOT EXISTS streaks (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id),
  user_id           INTEGER REFERENCES users(id),
  current_streak    INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  best_streak       INTEGER NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
  lives_left        INTEGER NOT NULL DEFAULT 2 CHECK (lives_left >= 0),
  lives_reset_at    TIMESTAMPTZ,
  last_counted_date DATE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS streak_days (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  date         DATE NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('counted','life_used','reset')),
  streak_after INTEGER NOT NULL,
  lives_after  INTEGER NOT NULL,
  closed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, date)
);

CREATE TABLE IF NOT EXISTS xp_events (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      INTEGER REFERENCES users(id),
  task_id      TEXT,
  type         TEXT NOT NULL,
  points       INTEGER NOT NULL CHECK (points >= 0),
  day          DATE NOT NULL,
  source_key   TEXT NOT NULL,
  voided_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_xp_events_day
  ON xp_events(workspace_id, day) WHERE voided_at IS NULL;
`;

const dateOut = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function createGameStore({ pool, blockDB = require("./db"), config = CONFIG, now = () => Date.now() }) {
  const tz = config.TIME_ZONE;
  const isDone = (props) => blockDB.isCompletedTaskProps(props || {});

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* keep the first error */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Intentions ──

  function rowToIntentions(row, date) {
    if (!row) return { date, big3: [], minimumDay: "", minimumDayDone: false, set: false };
    return {
      date: dateOut(row.date), big3: row.big3 || [], minimumDay: row.minimum_day || "",
      minimumDayDone: !!row.minimum_day_done_at, set: true,
    };
  }

  async function getIntentions(workspaceId, date, exec = pool) {
    const { rows } = await exec.query(
      "SELECT * FROM daily_intentions WHERE workspace_id=$1 AND date=$2", [workspaceId, date]);
    return rowToIntentions(rows[0], date);
  }

  async function setIntentions({ workspaceId, userId, date, big3, minimumDay }) {
    if (!R.isDateStr(date)) throw badRequest("date must be YYYY-MM-DD");
    const ids = Array.isArray(big3) ? big3.map((x) => String(x || "").trim()).filter(Boolean) : [];
    const unique = [...new Set(ids)];
    if (unique.length > config.BIG3_MAX) throw badRequest(`big3 takes at most ${config.BIG3_MAX} task ids`);
    if (unique.some((id) => id.length > 200)) throw badRequest("task id too long");
    const text = String(minimumDay == null ? "" : minimumDay).trim();
    if (text.length > 280) throw badRequest("minimumDay must be 280 characters or fewer");
    if (unique.length) {
      const { rows } = await pool.query(
        "SELECT id FROM blocks WHERE workspace_id=$1 AND id = ANY($2::text[]) AND deleted_at IS NULL",
        [workspaceId, unique]);
      const found = new Set(rows.map((r) => r.id));
      const missing = unique.filter((id) => !found.has(id));
      if (missing.length) throw badRequest("Unknown task id: " + missing.join(", "));
    }
    const { rows } = await pool.query(
      `INSERT INTO daily_intentions(workspace_id, user_id, date, big3, minimum_day)
       VALUES ($1,$2,$3,$4::text[],$5)
       ON CONFLICT (workspace_id, date) DO UPDATE
         SET big3=EXCLUDED.big3, minimum_day=EXCLUDED.minimum_day, updated_at=NOW()
       RETURNING *`,
      [workspaceId, userId || null, date, unique, text]);
    return rowToIntentions(rows[0], date);
  }

  async function setMinimumDayDone({ workspaceId, userId, date, done }) {
    if (!R.isDateStr(date)) throw badRequest("date must be YYYY-MM-DD");
    const { rows } = await pool.query(
      `INSERT INTO daily_intentions(workspace_id, user_id, date, minimum_day_done_at)
       VALUES ($1,$2,$3, CASE WHEN $4::boolean THEN NOW() END)
       ON CONFLICT (workspace_id, date) DO UPDATE
         SET minimum_day_done_at = CASE WHEN $4::boolean
               THEN COALESCE(daily_intentions.minimum_day_done_at, NOW()) END,
             updated_at = NOW()
       RETURNING *`,
      [workspaceId, userId || null, date, !!done]);
    return rowToIntentions(rows[0], date);
  }

  async function taskRows(workspaceId, ids, exec = pool) {
    if (!ids.length) return [];
    const { rows } = await exec.query(
      "SELECT id, date, properties FROM blocks WHERE workspace_id=$1 AND id = ANY($2::text[]) AND deleted_at IS NULL",
      [workspaceId, ids]);
    return rows;
  }

  async function doneIdsFor(workspaceId, ids, exec = pool) {
    const rows = await taskRows(workspaceId, ids, exec);
    return new Set(rows.filter((r) => isDone(r.properties)).map((r) => r.id));
  }

  // ── XP events ──

  // Insert new awards, or revive voided ones. Returns only rows that changed,
  // so the caller can show "+N" for exactly what landed this time.
  async function award({ workspaceId, userId, awards, day }, exec = pool) {
    const out = [];
    for (const a of awards) {
      const { rows } = await exec.query(
        `INSERT INTO xp_events(workspace_id, user_id, task_id, type, points, day, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (workspace_id, source_key) DO UPDATE
           SET voided_at=NULL, points=EXCLUDED.points, day=EXCLUDED.day, created_at=NOW()
           WHERE xp_events.voided_at IS NOT NULL
         RETURNING type, points, task_id, source_key`,
        [workspaceId, userId || null, a.taskId || null, a.type, Math.max(0, a.points | 0), day, a.sourceKey]);
      if (rows[0]) out.push({ type: rows[0].type, points: rows[0].points, taskId: rows[0].task_id });
    }
    return out;
  }

  async function voidKeys(workspaceId, keys, exec = pool) {
    if (!keys.length) return 0;
    const { rowCount } = await exec.query(
      "UPDATE xp_events SET voided_at=NOW() WHERE workspace_id=$1 AND source_key = ANY($2::text[]) AND voided_at IS NULL",
      [workspaceId, keys]);
    return rowCount || 0;
  }

  // Hook: a task's work session started. `swapped` (Phase 2) skips the bonus.
  async function onTaskStarted({ workspaceId, userId, task, atMs = now(), swapped = false }) {
    if (!task || !task.id) return [];
    const props = task.properties || {};
    const a = R.startAward({ taskId: task.id, taskDate: dateOut(task.date), start: props.start, atMs, swapped, tz }, config);
    if (!a) return [];
    return award({ workspaceId, userId, awards: [a], day: R.localDate(atMs, tz) });
  }

  // Hook: a task was completed (completed=true) or reopened (completed=false).
  async function onTaskCompletion({ workspaceId, userId, task, completed, atMs = now(), inFocus = false }) {
    if (!task || !task.id || task.type === "legacy_task") return [];
    const taskDate = dateOut(task.date);
    const intentions = taskDate ? await getIntentions(workspaceId, taskDate) : { big3: [] };
    if (!completed) {
      await voidKeys(workspaceId, R.reopenVoidKeys({ taskId: task.id, taskDate, big3Ids: intentions.big3 }));
      return [];
    }
    const doneIds = await doneIdsFor(workspaceId, intentions.big3);
    doneIds.add(task.id);
    const awards = R.completionAwards({
      taskId: task.id, taskDate, props: task.properties || {}, big3Ids: intentions.big3, doneIds, inFocus,
    }, config);
    return award({ workspaceId, userId, awards, day: R.localDate(atMs, tz) });
  }

  // ── Streak ──

  function rowToState(row) {
    return {
      currentStreak: row.current_streak, bestStreak: row.best_streak, livesLeft: row.lives_left,
      livesWeekStart: row.lives_reset_at ? R.localDate(new Date(row.lives_reset_at).getTime(), tz) : null,
      lastClosedDate: dateOut(row.last_counted_date),
    };
  }

  // Close every finished day that is still open, oldest first. Safe to run
  // any number of times and from parallel requests: the streak row is locked,
  // closed dates are skipped, and streak_days has one row per date.
  async function closeDays({ workspaceId, userId, today = R.localDate(now(), tz) }) {
    return tx(async (q) => {
      await q.query(
        "INSERT INTO streaks(workspace_id, user_id, lives_left) VALUES ($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING",
        [workspaceId, userId || null, config.STREAK.LIVES_PER_WEEK]);
      const { rows: [row] } = await q.query("SELECT * FROM streaks WHERE workspace_id=$1 FOR UPDATE", [workspaceId]);
      let state = rowToState(row);
      const { rows: [first] } = await q.query(
        "SELECT MIN(date) AS d FROM daily_intentions WHERE workspace_id=$1", [workspaceId]);
      const dates = R.datesToClose({ lastClosedDate: state.lastClosedDate, firstDate: dateOut(first && first.d), today });
      if (!dates.length) return { closed: [], state };

      const { rows: intentRows } = await q.query(
        "SELECT * FROM daily_intentions WHERE workspace_id=$1 AND date BETWEEN $2 AND $3",
        [workspaceId, dates[0], dates[dates.length - 1]]);
      const byDate = new Map(intentRows.map((r) => [dateOut(r.date), rowToIntentions(r)]));
      const allIds = [...new Set(intentRows.flatMap((r) => r.big3 || []))];
      const doneIds = await doneIdsFor(workspaceId, allIds, q);

      const closed = [];
      for (const date of dates) {
        const it = byDate.get(date) || { big3: [], minimumDayDone: false };
        const counted = R.dayCounts({ big3Ids: it.big3, doneIds, minimumDayDone: it.minimumDayDone });
        const r = R.closeDay(state, date, counted, config);
        if (r.outcome === "already_closed") continue;
        state = r.state;
        await q.query(
          `INSERT INTO streak_days(workspace_id, date, outcome, streak_after, lives_after)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, date) DO NOTHING`,
          [workspaceId, date, r.outcome, state.currentStreak, state.livesLeft]);
        closed.push({ date, outcome: r.outcome });
      }
      await q.query(
        `UPDATE streaks SET current_streak=$2, best_streak=$3, lives_left=$4,
           lives_reset_at=$5, last_counted_date=$6, updated_at=NOW()
         WHERE workspace_id=$1`,
        [workspaceId, state.currentStreak, state.bestStreak, state.livesLeft,
          state.livesWeekStart ? new Date(R.zonedMidnightMs(state.livesWeekStart, tz)).toISOString() : null,
          state.lastClosedDate]);
      return { closed, state };
    });
  }

  // ── Summary ──

  async function xpBetween(workspaceId, from, to) {
    const { rows: [r] } = await pool.query(
      "SELECT COALESCE(SUM(points),0)::int AS xp FROM xp_events WHERE workspace_id=$1 AND voided_at IS NULL AND day BETWEEN $2 AND $3",
      [workspaceId, from, to]);
    return r.xp;
  }

  async function summary({ workspaceId, userId }) {
    const nowMs = now();
    const today = R.localDate(nowMs, tz);
    const { state } = await closeDays({ workspaceId, userId, today });
    const week = R.weekStart(today, config);
    const weekEnd = R.addDays(week, 6);
    const [todayXp, weekXp, lifetimeXp, intentions] = await Promise.all([
      xpBetween(workspaceId, today, today),
      xpBetween(workspaceId, week, weekEnd),
      xpBetween(workspaceId, "1970-01-01", "9999-12-31"),
      getIntentions(workspaceId, today),
    ]);
    const rows = await taskRows(workspaceId, intentions.big3);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const big3 = intentions.big3.map((id) => {
      const r = byId.get(id);
      const p = (r && r.properties) || {};
      return { id, title: p.title || "(missing task)", start: p.start || null, date: r ? dateOut(r.date) : null, done: !!r && isDone(p), missing: !r };
    });
    return {
      today, timeZone: tz,
      todayXp, weekXp, weekStart: week,
      tier: R.tierFor(weekXp, config),
      lifetimeXp, petStage: R.petStageFor(lifetimeXp, config),
      streak: { current: state.currentStreak, best: state.bestStreak, lastClosedDate: state.lastClosedDate },
      lives: {
        left: R.livesToday(state, today, config), max: config.STREAK.LIVES_PER_WEEK,
        nextRefillAt: new Date(R.zonedMidnightMs(R.addDays(week, 7), tz)).toISOString(),
      },
      intentions: { ...intentions, big3 },
      dayCounts: R.dayCounts({ big3Ids: intentions.big3, doneIds: new Set(big3.filter((b) => b.done).map((b) => b.id)), minimumDayDone: intentions.minimumDayDone }),
    };
  }

  return { getIntentions, setIntentions, setMinimumDayDone, award, voidKeys, onTaskStarted, onTaskCompletion, closeDays, summary };
}

module.exports = { SCHEMA_SQL, createGameStore };
