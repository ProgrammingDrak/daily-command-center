// Contract tests for C5b step 4: Postgres is the day's state, the JSON file is a mirror.
//
// This is the change C5a built, had rejected by review three times, and pulled -- so it gets
// a test per blocker rather than a happy path. The four are recorded in the comment above
// `buildDayResponse` and each maps to a test below:
//
//   1. a successful read with NO ROW may now mean "no day", because the only file-ONLY
//      state writer (appendPublicShareTriageItem) saves to Postgres as of this change;
//   2. this function must not WRITE -- it is reachable ANONYMOUSLY via
//      buildPublicTodoShare, onto a path with no workspace segment;
//   3. the six routes/dcc.js handlers that read the file as BASE and then full-replace the
//      Postgres row must read Postgres first, or the boot skeleton gets promoted over a
//      real day;
//   4. a FAILED read must not share a branch with an empty one, or an outage mints a
//      skeleton, serves it as a real day, and persists it.
//
// Harness: raw source sliced into node:vm contexts, since server.js and the route modules
// all have load-time side effects. Every fake is derived from ONE store per test so a
// fixture cannot answer "does this row exist" two different ways (C5a's mock-contradiction
// lesson).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SERVER_SRC = fs.readFileSync(require.resolve("./server.js"), "utf8");
const DCC_SRC = fs.readFileSync(require.resolve("./routes/dcc.js"), "utf8");
const SOCIAL_SRC = fs.readFileSync(require.resolve("./routes/social-todo.js"), "utf8");

function slice(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error("postgres-first-day-state.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

const BUILD_DAY_SRC = slice(SERVER_SRC, /async function buildDayResponse\(dateStr, userId, workspaceId\) \{[\s\S]*?\n\}/, "buildDayResponse");
const READ_DCC_SRC = slice(DCC_SRC, /async function readDccDayState\(date, req, emptyFallback\) \{[\s\S]*?\n {2}\}/, "readDccDayState");
const APPEND_SRC = slice(SOCIAL_SRC, /async function appendPublicShareTriageItem\(\{ share[\s\S]*?\n\}/, "appendPublicShareTriageItem");

const DATE = "2026-08-04";
const dayWithTimeline = (label) => ({ date: DATE, schedule: { timeline: [{ id: "tl-1", label, type: "task" }] } });

// ── buildDayResponse ─────────────────────────────────────────────────────────

function runBuildDay({ dbRow = null, dbThrows = false, file = null } = {}) {
  const writes = [];
  const ctx = {
    console: { error: () => {}, warn: () => {} },
    getDayFilePath: (d) => "days/" + d + ".json",
    readJSON: (p, fallback) => (p === "days/" + DATE + ".json" && file ? file : fallback),
    // Any write at all is the failure this asserts against (blocker 2), so it is recorded
    // rather than stubbed away.
    writeJSON: (p, data) => writes.push({ p, data }),
    buildSkeletonState: (d) => ({ date: d, last_updated_by: "skeleton", schedule: { timeline: [] } }),
    getScheduleBlocks: async () => [],
    blockDB: {
      getDccState: async () => {
        if (dbThrows) throw new Error("connection terminated unexpectedly");
        return dbRow;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(BUILD_DAY_SRC, ctx);
  return { call: () => vm.runInContext(`buildDayResponse("${DATE}", null, "ws-1")`, ctx), writes };
}

test("the Postgres row WINS over a file carrying a non-empty timeline", async () => {
  // The bug, exactly: the old precedence handed the file the day whenever it had any
  // timeline items, and `getDayFilePath` has no workspace segment -- so on Railway's
  // ephemeral filesystem a file from an earlier boot, or another tenant, shadowed the row.
  const { call } = runBuildDay({
    dbRow: { state_json: dayWithTimeline("from Postgres") },
    file: dayWithTimeline("from a stale file"),
  });
  const out = await call();
  assert.equal(out.schedule.timeline[0].label, "from Postgres");
});

test("no row, but a file: the file is served (it is the mirror, not a liar)", async () => {
  const { call } = runBuildDay({ dbRow: null, file: dayWithTimeline("mirror") });
  const out = await call();
  assert.equal(out.schedule.timeline[0].label, "mirror");
});

test("no row and no file is an EMPTY DAY, and it is never written", async () => {
  const { call, writes } = runBuildDay({ dbRow: null, file: null });
  const out = await call();
  assert.equal(out.last_updated_by, "skeleton");
  assert.deepEqual(out.schedule.timeline, []);
  assert.deepEqual(writes, [], "blocker 2: a read must not write");
});

test("a FAILED read with no file THROWS rather than serving a skeleton (blocker 4)", async () => {
  // The distinction the old code collapsed. A skeleton served here is indistinguishable
  // from a real empty Tuesday to every caller, and one of those callers persists what it
  // reads. Both /api/state/day and /api/state/tomorrow catch this and serve the mirror.
  const { call, writes } = runBuildDay({ dbThrows: true, file: null });
  await assert.rejects(call(), /Day state unavailable/);
  assert.deepEqual(writes, [], "and it certainly must not persist one");
});

test("a FAILED read WITH a file serves the file — degraded, not broken", async () => {
  const { call } = runBuildDay({ dbThrows: true, file: dayWithTimeline("mirror") });
  const out = await call();
  assert.equal(out.schedule.timeline[0].label, "mirror");
});

test("NO branch writes anything (blocker 2, checked across all four)", async () => {
  for (const fixture of [
    { dbRow: { state_json: dayWithTimeline("db") }, file: dayWithTimeline("file") },
    { dbRow: null, file: dayWithTimeline("file") },
    { dbRow: null, file: null },
    { dbThrows: true, file: dayWithTimeline("file") },
  ]) {
    const { call, writes } = runBuildDay(fixture);
    await call();
    assert.deepEqual(writes, [], "wrote on " + JSON.stringify(Object.keys(fixture)));
  }
});

test("the row is read for the caller's OWN workspace, not a default", async () => {
  // buildPublicTodoShare calls this as buildDayResponse(date, null, share.workspace_id), so
  // a workspace argument that got dropped would serve ws-1's day on someone else's share.
  const asked = [];
  const ctx = {
    console: { error: () => {} },
    getDayFilePath: (d) => "days/" + d + ".json",
    readJSON: (p, fallback) => fallback,
    writeJSON: () => { throw new Error("must not write"); },
    buildSkeletonState: (d) => ({ date: d, schedule: { timeline: [] } }),
    getScheduleBlocks: async () => [],
    blockDB: { getDccState: async (d, ws) => { asked.push([d, ws]); return null; } },
  };
  vm.createContext(ctx);
  vm.runInContext(BUILD_DAY_SRC, ctx);
  await vm.runInContext(`buildDayResponse("${DATE}", null, "ws-7")`, ctx);
  await vm.runInContext(`buildDayResponse("${DATE}", 42, null)`, ctx);
  await vm.runInContext(`buildDayResponse("${DATE}", null, null)`, ctx);
  assert.deepEqual(asked, [[DATE, "ws-7"], [DATE, "ws-42"], [DATE, "ws-1"]]);
});

// ── dayStateUnavailable (the degraded answer) ────────────────────────────────
//
// This function exists because of a bug CURL found and the suite could not have. Making
// `buildDayResponse` throw on an outage (blocker 4) meant the two route catches ran in a
// case they never used to, and they fell through to `DAY_STATE_FILE` / `TOMORROW_STATE_FILE`
// -- which hold whatever day was last PUBLISHED, not the day being asked for. Asking for
// 2027-03-09 while Postgres was down answered with 2026-06-03's state, ten timeline items
// and all, stamped with 2026-06-03. And a client cannot defend against it: transformState
// reads `state.date`, sees a past date, treats the timeline as archive (C5b step 5) and
// renders that unrelated day's items under the heading you were looking at.
const UNAVAILABLE_SRC = slice(SERVER_SRC, /function dayStateUnavailable\(dateStr, legacyFile, err\) \{[\s\S]*?\n\}/, "dayStateUnavailable");

function runUnavailable({ own = null, legacy = null } = {}) {
  const ctx = {
    console: { error: () => {} },
    getDayFilePath: (d) => "days/" + d + ".json",
    readJSON: (p, fallback) => (p === "days/" + DATE + ".json" ? (own || fallback) : (p === "legacy.json" ? (legacy || fallback) : fallback)),
    buildSkeletonState: (d) => ({ date: d, last_updated_by: "skeleton", schedule: { timeline: [] } }),
  };
  vm.createContext(ctx);
  vm.runInContext(UNAVAILABLE_SRC, ctx);
  return vm.runInContext(`dayStateUnavailable("${DATE}", "legacy.json", new Error("db down"))`, ctx);
}

test("the degraded answer NEVER carries another day's state", () => {
  // The regression, pinned. The legacy file holds a real, richly populated day -- and the
  // wrong one.
  const out = runUnavailable({ legacy: { date: "2026-06-03", schedule: { timeline: [{ id: "old-1" }] } } });
  assert.equal(out.date, DATE, "answers for the date that was ASKED FOR");
  assert.deepEqual(out.schedule.timeline, [], "and does not smuggle in that day's items");
  assert.equal(out._unavailable, true);
});

test("the legacy file IS used when it happens to be about this date", () => {
  const out = runUnavailable({ legacy: { date: DATE, schedule: { timeline: [{ id: "same-day" }] } } });
  assert.equal(out.schedule.timeline[0].id, "same-day");
  assert.ok(!out._unavailable, "real state for the right day is not a degraded answer");
});

test("the per-date mirror wins over both, and is stamped with the requested date", () => {
  const out = runUnavailable({ own: { schedule: { timeline: [{ id: "mine" }] } }, legacy: { date: DATE } });
  assert.equal(out.schedule.timeline[0].id, "mine");
  assert.equal(out.date, DATE);
});

test("with nothing to serve it is an EMPTY day for the right date, flagged", () => {
  const out = runUnavailable({});
  assert.equal(out.date, DATE);
  assert.equal(out._unavailable, true, "so a surface can say 'couldn't load', not 'nothing planned'");
});

// ── readDccDayState (the six handlers' base state) ───────────────────────────

function runReadDcc({ dbRow = null, dbThrows = false, file = null, dayStateFile = null } = {}) {
  const ctx = {
    console: { error: () => {} },
    getDayFilePath: (d) => "days/" + d + ".json",
    DAY_STATE_FILE: "day-state.json",
    readJSON: (p, fallback) => (p === "days/" + DATE + ".json" ? (file || fallback) : (p === "day-state.json" ? (dayStateFile || fallback) : fallback)),
    resolveOwnerLenient: () => ({ userId: 1, workspaceId: "ws-1" }),
    blockDB: {
      getDccState: async () => {
        if (dbThrows) throw new Error("connection terminated unexpectedly");
        return dbRow;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext("  " + READ_DCC_SRC.trimStart(), ctx);
  return () => vm.runInContext(`readDccDayState("${DATE}", {}, {__fallback:true})`, ctx);
}

test("BASE state for a mutation is the Postgres row, not the file (blocker 3)", async () => {
  // This is the crux the whole step turns on. `saveDccState` is
  // `DO UPDATE SET state_json = EXCLUDED.state_json`, so whatever these handlers read as
  // base is what gets written back over the row -- and the file they used to read is a
  // boot-time skeleton on any freshly deployed Railway container.
  const out = await runReadDcc({
    dbRow: { state_json: dayWithTimeline("from Postgres") },
    file: dayWithTimeline("boot skeleton would have won here"),
  })();
  assert.equal(out.schedule.timeline[0].label, "from Postgres");
});

test("no row falls back to the day file, then to DAY_STATE_FILE, then to the caller's empty", async () => {
  assert.equal((await runReadDcc({ file: dayWithTimeline("day file") })()).schedule.timeline[0].label, "day file");
  assert.equal((await runReadDcc({ dayStateFile: dayWithTimeline("day-state") })()).schedule.timeline[0].label, "day-state");
  // Compared through JSON: the vm has its own realm, so an object built in there is not
  // reference-equal to one built out here and deepEqual rejects it on the prototype alone.
  assert.equal(JSON.stringify(await runReadDcc({})()), JSON.stringify({ __fallback: true }));
});

test("a failed read falls through to the file instead of losing the ingest", async () => {
  // These are ingest paths. Refusing an ingest because a READ hiccuped drops the incoming
  // packet; the Postgres WRITE still throws (persistDccDay's contract), so a save cannot
  // silently half-land.
  const out = await runReadDcc({ dbThrows: true, file: dayWithTimeline("mirror") })();
  assert.equal(out.schedule.timeline[0].label, "mirror");
});

// ── appendPublicShareTriageItem (the former file-only writer) ────────────────

function runAppend({ dbRow = null, saveThrows = false, file = null } = {}) {
  const saved = [];
  const writes = [];
  const ctx = {
    console: { error: () => {} },
    crypto: { randomUUID: () => "uuid-1", randomBytes: () => ({ toString: () => "tok" }) },
    todoShareUrl: () => "https://example.test/todo/tok",
    getDayFilePath: (d) => "days/" + d + ".json",
    DAY_STATE_FILE: "day-state.json",
    getTodayStr: () => DATE,
    readJSON: (p, fallback) => (p === "days/" + DATE + ".json" && file ? file : fallback),
    writeJSON: (p, data) => writes.push({ p, data }),
    updateManifest: () => {},
    buildSkeletonState: (d) => ({ date: d, triage: { open_items: [], resolved_items: [], cycle_count: 0 }, sweep: { open_item_count: 0 } }),
    blockDB: {
      getDccState: async () => dbRow,
      saveDccState: async (date, state, userId, ws) => {
        if (saveThrows) throw new Error("db down");
        saved.push({ date, state, ws });
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(APPEND_SRC, ctx);
  return {
    call: () => vm.runInContext('appendPublicShareTriageItem({share:{workspace_id:"ws-1",token:"tok"},date:"' + DATE + '",title:"Guest task",durationMinutes:30,visitorName:"Sam",visitorEmail:"",note:"hi",req:{}})', ctx),
    saved, writes,
  };
}

test("a guest task is PERSISTED TO POSTGRES, not just to an ephemeral file (blocker 1)", async () => {
  // The live data-loss bug this closes: the only copy lived on Railway's filesystem and did
  // not survive a redeploy. 0 items with source:"public_share" have ever reached the DB on
  // prod, which is the evidence that none ever did.
  const { call, saved, writes } = runAppend({ dbRow: { state_json: { date: DATE, triage: { open_items: [], resolved_items: [] }, schedule: { timeline: [] } } } });
  const item = await call();
  assert.equal(saved.length, 1, "one durable save");
  assert.equal(saved[0].ws, "ws-1", "scoped to the share's workspace");
  const items = saved[0].state.triage.open_items;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Guest task");
  assert.equal(items[0].source, "public_share");
  assert.equal(item.id, items[0].id);
  assert.ok(writes.length >= 1, "and the file mirror is still written");
});

test("the append is based on the Postgres row, so it cannot full-replace a real day", async () => {
  // Same trap as the six readers: `saveDccState` full-replaces, so a file-based read would
  // write a stale day over the live one -- here it would drop an existing triage item.
  const { call, saved } = runAppend({
    dbRow: { state_json: { date: DATE, triage: { open_items: [{ id: "existing" }], resolved_items: [] } } },
    file: { date: DATE, triage: { open_items: [], resolved_items: [] } },
  });
  await call();
  // `local_id` is "public-" + randomUUID and the item id is "public_share:" + that, so the
  // expected id is public_share:public-uuid-1 -- derived from the fake, not guessed at.
  assert.deepEqual([...saved[0].state.triage.open_items].map((i) => i.id), ["existing", "public_share:public-uuid-1"]);
});

test("a failed DB save REJECTS instead of reporting success on a lost task", async () => {
  const { call, writes } = runAppend({ saveThrows: true });
  await assert.rejects(call(), /db down/);
  assert.deepEqual(writes, [], "and no file mirror claims it landed");
});
