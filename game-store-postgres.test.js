const test = require("node:test");
const assert = require("node:assert/strict");
const { createActivityDb } = require("./test-support/activity-db");
const { createGameStore } = require("./game-store");

const skip = !(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL);
const WS = "ws-1";

async function addTask(pool, id, date, props = {}) {
  await pool.query(
    `INSERT INTO blocks(id, type, date, properties, created_at, updated_at, user_id, workspace_id)
     VALUES ($1,'block',$2,$3,NOW(),NOW(),1,$4)`,
    [id, date, JSON.stringify({ kind: "task", title: id, status: "open", ...props }), WS]);
}
async function setDone(pool, id, done = true) {
  await pool.query(
    "UPDATE blocks SET properties = properties || $2::jsonb WHERE id=$1",
    [id, JSON.stringify(done ? { status: "done", done: true, completedAt: new Date().toISOString() } : { status: "open", done: false, completedAt: null })]);
}
async function getTask(pool, id) {
  const { rows } = await pool.query("SELECT id, type, date, properties FROM blocks WHERE id=$1", [id]);
  return rows[0];
}

test("game store: XP, Big 3, idempotency, streak close and Monday refill", { skip }, async (t) => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  const { pool } = ctx;
  let clock = Date.parse("2026-11-23T14:00:00Z"); // Mon 09:00 ET
  const game = createGameStore({ pool, blockDB: ctx.blockDB, now: () => clock });
  const who = { workspaceId: WS, userId: 1 };

  await t.test("intentions validate ids and size", async () => {
    await assert.rejects(game.setIntentions({ ...who, date: "2026-11-23", big3: ["nope"] }), /Unknown task id/);
    await addTask(pool, "a", "2026-11-23", { start: "09:00", taskPriority: "High" });
    await addTask(pool, "b", "2026-11-23");
    await addTask(pool, "c", "2026-11-23");
    await addTask(pool, "d", "2026-11-23");
    await assert.rejects(game.setIntentions({ ...who, date: "2026-11-23", big3: ["a", "b", "c", "d"] }), /at most 3/);
    const it = await game.setIntentions({ ...who, date: "2026-11-23", big3: ["a", "b", "c", "a"], minimumDay: "10 min walk" });
    assert.deepEqual(it.big3, ["a", "b", "c"]);
  });

  await t.test("on-time start awards once", async () => {
    const a = await getTask(pool, "a");
    assert.deepEqual((await game.onTaskStarted({ ...who, task: a, atMs: clock })).map((x) => x.points), [10]);
    assert.deepEqual(await game.onTaskStarted({ ...who, task: a, atMs: clock + 60000 }), [], "second start is a no-op");
    assert.deepEqual(await game.onTaskStarted({ ...who, task: await getTask(pool, "b"), atMs: clock }), [], "no start time → no bonus");
  });

  await t.test("completion is idempotent; reopen voids; re-complete revives", async () => {
    await setDone(pool, "a");
    const a = await getTask(pool, "a");
    const first = await game.onTaskCompletion({ ...who, task: a, completed: true });
    assert.deepEqual(first.map((x) => [x.type, x.points]), [["complete", 15], ["big3_complete", 10]]);
    assert.deepEqual(await game.onTaskCompletion({ ...who, task: a, completed: true }), [], "replay awards nothing");
    assert.equal((await game.summary(who)).todayXp, 35);

    await setDone(pool, "a", false);
    await game.onTaskCompletion({ ...who, task: await getTask(pool, "a"), completed: false });
    assert.equal((await game.summary(who)).todayXp, 10, "only the start bonus stays");
    const { rows } = await pool.query("SELECT MIN(points) AS m FROM xp_events");
    assert.ok(rows[0].m >= 0, "no negative points");

    await setDone(pool, "a");
    const again = await game.onTaskCompletion({ ...who, task: await getTask(pool, "a"), completed: true });
    assert.equal(again.length, 2);
    assert.equal((await game.summary(who)).todayXp, 35);
  });

  await t.test("finishing all Big 3 awards Perfect Day once", async () => {
    await setDone(pool, "b");
    await game.onTaskCompletion({ ...who, task: await getTask(pool, "b"), completed: true });
    await setDone(pool, "c");
    const last = await game.onTaskCompletion({ ...who, task: await getTask(pool, "c"), completed: true });
    assert.ok(last.some((x) => x.type === "perfect_day" && x.points === 25));
    const s = await game.summary(who);
    assert.equal(s.todayXp, 35 + 20 + 20 + 25);
    assert.equal(s.dayCounts, true);
    assert.equal(s.intentions.big3.every((b) => b.done), true);
  });

  await t.test("day close: counted, lives, reset, idempotent, parallel-safe", async () => {
    // Mon counted. Tue + Wed: no intentions → missed → 2 lives used. Thu: minimum day. Fri: missed → reset.
    await game.setMinimumDayDone({ ...who, date: "2026-11-26", done: true });
    clock = Date.parse("2026-11-28T15:00:00Z"); // Sat
    const runs = await Promise.all([game.closeDays(who), game.closeDays(who), game.closeDays(who)]);
    const closedCount = runs.reduce((n, r) => n + r.closed.length, 0);
    assert.equal(closedCount, 5, "five days closed exactly once across parallel runs");
    const { rows } = await pool.query("SELECT date::text, outcome FROM streak_days ORDER BY date");
    assert.deepEqual(rows.map((r) => r.outcome), ["counted", "life_used", "life_used", "counted", "reset"]);
    const s = await game.summary(who);
    assert.equal(s.streak.current, 0);
    assert.equal(s.streak.best, 2);
    assert.equal(s.lives.left, 0);
    assert.equal((await game.closeDays(who)).closed.length, 0, "second run is a no-op");
  });

  await t.test("Monday refill: lives show full on Monday and a missed Sunday was charged to the old week", async () => {
    clock = Date.parse("2026-11-30T05:30:00Z"); // Mon 00:30 ET
    const s = await game.summary(who);
    assert.equal(s.lives.left, 2, "refilled");
    const { rows } = await pool.query("SELECT outcome FROM streak_days WHERE date IN ('2026-11-28','2026-11-29') ORDER BY date");
    assert.deepEqual(rows.map((r) => r.outcome), ["reset", "reset"]);
    assert.equal(s.weekXp, 0, "week XP resets on Monday");
    assert.equal(s.tier.id, "backyard");
    assert.equal(s.lifetimeXp, 100, "growth keeps last week's sparks");
    assert.equal(s.petStage.id, "seed");
  });
});
