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
// The file-mirror ladder, shared by `dayStateUnavailable` (server.js) and `readDccDayState`
// (routes/dcc.js, via ctx). Sliced and run for REAL in both harnesses below: it carries the
// "the legacy file counts only if it IS about this date" gate, which is the safety property
// under test, so a fake here would test the fake.
const MIRROR_SRC = slice(SERVER_SRC, /function readDayStateMirror\(dateStr, legacyFile\) \{[\s\S]*?\n\}/, "readDayStateMirror");

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
  vm.runInContext(MIRROR_SRC + "\n" + UNAVAILABLE_SRC, ctx);
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
  vm.runInContext(MIRROR_SRC + "\n  " + READ_DCC_SRC.trimStart(), ctx);
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

// INVERTED after review round 2, and this is the finding worth remembering: round 1's fix
// consulted the mirror BEFORE testing whether the read had failed, so a clean no-row read
// returned `data/state/days/<date>.json` — a file with no workspace segment that
// `persistDccDay` writes for every workspace. Every caller feeds this into a full replace, so
// workspace B posting a Brief decision on a date where B has no row would have created B's row
// holding workspace A's day, then served and published it. The same PR hardened the guest
// writer against exactly that and asserted it ("a no-row read seeds a SKELETON, never the
// workspace-less file mirror") — same hazard, opposite policy, one change.
test("a SUCCESSFUL no-row read never uses the workspace-less mirror", async () => {
  // Compared through JSON: the vm has its own realm, so an object built in there is not
  // reference-equal to one built out here and deepEqual rejects it on the prototype alone.
  const empty = JSON.stringify({ __fallback: true });
  assert.equal(JSON.stringify(await runReadDcc({ file: dayWithTimeline("day file") })()), empty,
    "a per-date file cannot be attributed to a workspace, so it is not a base for a full replace");
  assert.equal(JSON.stringify(await runReadDcc({ dayStateFile: dayWithTimeline("day-state") })()), empty,
    "and the last-published-day file certainly is not");
  assert.equal(JSON.stringify(await runReadDcc({})()), empty, "no row means no day for THIS workspace");
});

test("the mirror IS used when the read failed — better than overwriting a day we could not read", async () => {
  assert.equal((await runReadDcc({ dbThrows: true, file: dayWithTimeline("day file") })()).schedule.timeline[0].label, "day file");
  assert.equal((await runReadDcc({ dbThrows: true, dayStateFile: dayWithTimeline("day-state") })()).schedule.timeline[0].label, "day-state");
});

test("a failed read with NO mirror throws rather than handing back a base to full-replace with", async () => {
  await assert.rejects(runReadDcc({ dbThrows: true })(), /Day state unavailable/);
});

// ★ THE WIRING, not just the helper. Blocker 3 is a property of the six CALL SITES -- the
// change was pulled three times precisely because the crux lives there rather than in a
// function -- and reverting any one of them to `readJSON(getDayFilePath(...))` re-arms the
// boot-skeleton promotion with every behavioral test above still green. Same shape as
// push-is-a-move.test.js's source sweep.
test("all six routes/dcc.js mutation handlers take Postgres as their BASE state (blocker 3)", () => {
  const code = DCC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal((code.match(/await readDccDayState\(/g) || []).length, 6,
    "a handler that stopped reading Postgres first re-arms the boot-skeleton promotion");
  assert.deepEqual(code.match(/(?:existing|state|sourceState)\s*=\s*readJSON\(getDayFilePath/g) || [], [],
    "the file is the mirror, never the base");
});

// The one caller without a handler-level try. `readDccDayState` throws now, Express 4 does not
// observe a rejected promise, and this repo registers no unhandledRejection hook -- so on
// Node >= 20 an unwrapped throw here EXITS THE PROCESS rather than answering. The handler's own
// comment documents that hazard for `getDayFilePath`; the same one applies to this call.
test("/api/ingest/day-state wraps its day-state read (an unobserved throw exits the process)", () => {
  const handler = DCC_SRC.slice(DCC_SRC.indexOf('app.post("/api/ingest/day-state"'));
  const upToCall = handler.slice(0, handler.indexOf("await readDccDayState("));
  assert.match(upToCall, /try \{\s*$/m, "the read must sit inside a try");
  assert.match(handler.slice(handler.indexOf("await readDccDayState(")), /^[\s\S]{0,400}?catch \(e\) \{[\s\S]{0,300}?res\.status\(503\)/,
    "and a failure must answer 503, not reject unobserved");
});

// ── appendPublicShareTriageItem (the former file-only writer) ────────────────

function runAppend({ dbRow = null, saveThrows = false, readThrows = false, file = null } = {}) {
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
      getDccState: async () => {
        if (readThrows) throw new Error("connection terminated unexpectedly");
        return dbRow;
      },
      saveDccState: async (date, state, userId, ws) => {
        if (saveThrows) throw new Error("db down");
        saved.push({ date, state, userId, ws });
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(APPEND_SRC, ctx);
  return {
    call: () => vm.runInContext('appendPublicShareTriageItem({share:{workspace_id:"ws-1",token:"tok",owner_id:42},date:"' + DATE + '",title:"Guest task",durationMinutes:30,visitorName:"Sam",visitorEmail:"",note:"hi",req:{}})', ctx),
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
  // NO FILE MIRROR from this path (review round 2). `buildDayResponse` claims the cross-tenant
  // leak is closed "BY NOT WRITING", and this anonymous writer was still putting a workspace's
  // complete day into the workspace-less `data/state/days/<date>.json` and the global
  // `DAY_STATE_FILE` — the two files other workspaces read. Closed on the read side, open on
  // the write side, in one change.
  assert.deepEqual(writes, [], "the anonymous path must not write the workspace-less mirrors");
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

// ── The three things that make this writer safe to expose anonymously ─────────
//
// All three were added after review and NONE was caught by a mutation check until these
// tests existed: reverting each one left the whole suite green. This is an UNAUTHENTICATED
// writer whose every save is a FULL REPLACE of the day (`saveDccState` is
// `ON CONFLICT ... DO UPDATE SET state_json = EXCLUDED.state_json`), and the guest picks the
// date, so each of these is the difference between an append and a day-wipe.

test("a failed READ fails closed — it never guesses a base and full-replaces the day", async () => {
  // The read throwing and the write succeeding is the dangerous combination: the earlier cut
  // fell back to the workspace-less file mirror, or to a bare skeleton when no file existed.
  // On Railway's ephemeral filesystem "no file" IS the normal post-deploy state, so the
  // realistic outcome was replacing the workspace's real day with an empty one.
  const { call, saved, writes } = runAppend({ readThrows: true, file: { date: DATE, triage: { open_items: [], resolved_items: [] } } });
  await assert.rejects(call(), /temporarily unavailable/);
  assert.deepEqual(saved, [], "nothing is written from a base we could not read");
  assert.deepEqual(writes, [], "and no file mirror either");
});

test("a no-row read seeds a SKELETON, never the workspace-less file mirror", async () => {
  // `getDayFilePath` has no workspace segment and `persistDccDay` writes that mirror for every
  // workspace, so seeding from it would create THIS workspace's row holding ANOTHER tenant's
  // day — and because buildDayResponse is Postgres-first now, that content would then be
  // served authoritatively and published on this share.
  const { call, saved } = runAppend({
    dbRow: null,
    file: { date: DATE, triage: { open_items: [{ id: "another-tenants-item" }], resolved_items: [] }, schedule: { timeline: [{ id: "leak" }] } },
  });
  await call();
  assert.equal(saved.length, 1);
  const ids = [...saved[0].state.triage.open_items].map((i) => i.id);
  assert.equal(ids.length, 1, "only the guest's own item: " + JSON.stringify(ids));
  assert.match(ids[0], /^public_share:/);
  assert.equal(JSON.stringify(saved[0].state.schedule || null), "null", "and no other day's timeline rode along");
});

test("the owner's user_id is PRESERVED, not erased", async () => {
  // The upsert does `user_id = EXCLUDED.user_id`, and server.js's boot backfill is
  // `UPDATE dcc_state SET user_id = $1, workspace_id = $2 WHERE user_id IS NULL`, run
  // unconditionally on EVERY restart. So passing null let one guest submission re-home the
  // workspace's day row to the default workspace on the next deploy — or collide with that
  // workspace's own row for the date (PRIMARY KEY (date, workspace_id)) and abort the UPDATE
  // into a catch that skips ensureWorkspacesForAllUsers for that boot.
  const withUser = runAppend({ dbRow: { user_id: 7, state_json: { date: DATE, triage: { open_items: [], resolved_items: [] } } } });
  await withUser.call();
  assert.equal(withUser.saved[0].userId, 7, "the row's own owner wins");
  // No row yet: fall back to the share's workspace owner rather than nulling the column.
  const noRow = runAppend({ dbRow: null });
  await noRow.call();
  assert.equal(noRow.saved[0].userId, 42, "the share's owner_id");
});

// The cap is per (date, workspace) and the guest chose the date, so without a clamp it bounded
// nothing: a script walks dates, 50 items each, minting a `dcc_state` row per date across every
// date Postgres accepts. `isValidDate` is only a shape check with no range. The real client
// never sends `date` at all, so clamping breaks nothing.
test("a guest-chosen date is clamped to today or tomorrow, so the cap actually bounds", () => {
  const handler = SOCIAL_SRC.slice(SOCIAL_SRC.indexOf('app.post("/api/public/todo-share/:token/tasks"'));
  const region = handler.slice(0, handler.indexOf("appendPublicShareTriageItem"));
  assert.match(region, /requestedDate === todayStr \|\| requestedDate === tomorrowStr/,
    "an arbitrary guest date must not reach the writer");
  assert.match(region, /: todayStr;/, "and anything else falls back to today");
});

test("guest submissions are CAPPED, because this is a durable unauthenticated append", async () => {
  // No rate limiting exists anywhere in this app, and each POST rewrites the whole day
  // document. Unbounded, a share token is enough to grow one row until reads of it get
  // expensive, which degrades the owner's own /api/state/day.
  const existing = Array.from({ length: 50 }, (_, i) => ({ id: "public_share:old-" + i, source: "public_share" }));
  const { call, saved } = runAppend({ dbRow: { state_json: { date: DATE, triage: { open_items: existing, resolved_items: [] } } } });
  await assert.rejects(call(), /limit of guest-submitted tasks/);
  assert.deepEqual(saved, [], "nothing written once the cap is reached");
  // 49 is still fine, so the cap is a boundary rather than a blanket refusal.
  const under = runAppend({ dbRow: { state_json: { date: DATE, triage: { open_items: existing.slice(0, 49), resolved_items: [] } } } });
  await under.call();
  assert.equal(under.saved.length, 1);
  // The owner's OWN items do not count toward a guest cap.
  const ownersOwn = Array.from({ length: 80 }, (_, i) => ({ id: "t-" + i, source: "sweep" }));
  const mine = runAppend({ dbRow: { state_json: { date: DATE, triage: { open_items: ownersOwn, resolved_items: [] } } } });
  await mine.call();
  assert.equal(mine.saved.length, 1, "only public_share items are counted");
});
