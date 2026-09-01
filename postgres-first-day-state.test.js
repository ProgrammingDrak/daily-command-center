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
// Loose parameter list so the slice survives the next argument; the `slice` guard still fails
// loudly if the function moves or is renamed. It gained an `owner` param so a caller that
// resolved the owner STRICTLY can hand it in rather than having it re-derived leniently.
const READ_DCC_SRC = slice(DCC_SRC, /async function readDccDayState\([^)]*\) \{[\s\S]*?\n {2}\}/, "readDccDayState");
const APPEND_SRC = slice(SOCIAL_SRC, /async function appendPublicShareTriageItem\(\{ share[\s\S]*?\n\}/, "appendPublicShareTriageItem");
// The file-mirror ladder, shared by `dayStateUnavailable` (server.js) and `readDccDayState`
// (routes/dcc.js, via ctx). Sliced and run for REAL in both harnesses below: it carries the
// "the legacy file counts only if it IS about this date" gate, which is the safety property
// under test, so a fake here would test the fake.
const MIRROR_SRC = slice(SERVER_SRC, /function readDayStateMirror\(dateStr, legacyFile\) \{[\s\S]*?\n\}/, "readDayStateMirror");
// buildDayResponse now overlays the durable triage suppressions (triage-suppressions.js).
// Sliced and run for REAL rather than stubbed, for the same reason the mirror ladder is:
// its degrade-to-empty-on-DB-failure behaviour is a safety property, and a fake would test
// the fake.
const SUPPRESSIONS_SRC = slice(SERVER_SRC, /async function readTriageSuppressionsForWorkspace\(workspaceId\) \{[\s\S]*?\n\}/, "readTriageSuppressionsForWorkspace");

const DATE = "2026-08-04";
const dayWithTimeline = (label) => ({ date: DATE, schedule: { timeline: [{ id: "tl-1", label, type: "task" }] } });

// ── buildDayResponse ─────────────────────────────────────────────────────────

function runBuildDay({ dbRow = null, dbThrows = false, file = null, suppressionBlocks = [], suppressionsThrow = false, reviewRows = [], reviewRowsThrow = false, userId = 1, today = DATE } = {}) {
  const writes = [];
  const reviewAsked = [];
  const readersUsed = [];
  // Which of the two readers buildDayResponse picks is a pure date comparison against
  // today, so `today` is the dial. It defaults to DATE, which puts every test on the
  // COMPACT reader -- the one that now serves every today/future dashboard read.
  const readRow = async (reader) => {
    readersUsed.push(reader);
    if (dbThrows) throw new Error("connection terminated unexpectedly");
    return dbRow;
  };
  const ctx = {
    console: { error: () => {}, warn: () => {} },
    getDayFilePath: (d) => "days/" + d + ".json",
    readJSON: (p, fallback) => (p === "days/" + DATE + ".json" && file ? file : fallback),
    // Any write at all is the failure this asserts against (blocker 2), so it is recorded
    // rather than stubbed away.
    writeJSON: (p, data) => writes.push({ p, data }),
    buildSkeletonState: (d) => ({ date: d, last_updated_by: "skeleton", schedule: { timeline: [] } }),
    getScheduleBlocks: async () => [],
    triageSuppressions: require("./triage-suppressions"),
    dayReviewRepeats: require("./day-review-repeats"),
    // The start-of-day floor buildDayResponse stamps onto schedule.day_start. Stubbed
    // rather than wired to the real store so this suite keeps testing the day-response
    // contract, not the settings storage.
    scheduleSettingsStore: { getScheduleSettings: async () => ({ dayStart: "07:00", _source: "defaults" }) },
    // Pinned, not the host clock: buildDayResponse compares the requested date against
    // today to choose its reader, so a real clock would silently swap which branch this
    // suite covers the moment DATE fell into the past.
    getTodayStr: () => today,
    addDays: (date, days) => {
      const value = new Date(date + "T12:00:00Z");
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    },
    // buildDayResponse scopes suppressed_items to the app's LOCAL day, so the zone is
    // part of what it reads. Pinned here rather than left to the host's TZ so the
    // evening-boundary behaviour stays deterministic in CI.
    APP_TIME_ZONE: "America/New_York",
    blockDB: {
      // Both readers answer from the ONE store above. A compact stub that could disagree
      // with the full one about whether the row exists would be the mock contradiction
      // this harness was written to avoid.
      getDccState: () => readRow("full"),
      getDccStateCompact: () => readRow("compact"),
      getBlocksByKind: async () => {
        if (suppressionsThrow) throw new Error("connection terminated unexpectedly");
        return suppressionBlocks;
      },
      getDccStateRange: async (start, end, ws) => {
        reviewAsked.push([start, end, ws]);
        if (reviewRowsThrow) throw new Error("connection terminated unexpectedly");
        return reviewRows;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SUPPRESSIONS_SRC, ctx);
  vm.runInContext(BUILD_DAY_SRC, ctx);
  const uid = userId === null ? "null" : String(userId);
  return { call: () => vm.runInContext(`buildDayResponse("${DATE}", ${uid}, "ws-1")`, ctx), writes, reviewAsked, readersUsed };
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

test("today and future dates take the COMPACT reader, past dates the full one", async () => {
  // The reader split is a pure date comparison, and it is the only thing standing between
  // a routine dashboard read and every historical Sweep ledger in the row. An inverted
  // comparison would still return a correct-looking day, so nothing else in this suite
  // would notice.
  const todayRun = runBuildDay({ dbRow: { state_json: dayWithTimeline("db") }, today: DATE });
  await todayRun.call();
  assert.deepEqual(todayRun.readersUsed, ["compact"]);

  const futureRun = runBuildDay({ dbRow: { state_json: dayWithTimeline("db") }, today: "2026-08-03" });
  await futureRun.call();
  assert.deepEqual(futureRun.readersUsed, ["compact"], "a future date is the hot path too");

  const pastRun = runBuildDay({ dbRow: { state_json: dayWithTimeline("db") }, today: "2026-08-05" });
  await pastRun.call();
  assert.deepEqual(pastRun.readersUsed, ["full"], "history still needs the whole row");
});

test("blocker 4 holds on BOTH readers, not just the one today happens to pick", async () => {
  // The outage branch is the one that mints a skeleton and serves it as a real day if it
  // regresses, so it is asserted against each reader rather than against whichever the
  // clock selects.
  for (const today of [DATE, "2026-08-05"]) {
    const { call, writes } = runBuildDay({ dbThrows: true, file: null, today });
    await assert.rejects(call(), /Day state unavailable/, "reader for today=" + today);
    assert.deepEqual(writes, [], "and it must not persist one either way");
  }
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
  // The suppression overlay is a SECOND per-workspace lookup on this path, so it is
  // recorded against the same resolved workspace. An unscoped one would hide ws-7's
  // triage items behind ws-1's decisions.
  const askedSuppressions = [];
  const ctx = {
    console: { error: () => {} },
    getDayFilePath: (d) => "days/" + d + ".json",
    readJSON: (p, fallback) => fallback,
    writeJSON: () => { throw new Error("must not write"); },
    buildSkeletonState: (d) => ({ date: d, schedule: { timeline: [] } }),
    getScheduleBlocks: async () => [],
    triageSuppressions: require("./triage-suppressions"),
    dayReviewRepeats: require("./day-review-repeats"),
    // The start-of-day floor buildDayResponse stamps onto schedule.day_start. Stubbed
    // rather than wired to the real store so this suite keeps testing the day-response
    // contract, not the settings storage.
    scheduleSettingsStore: { getScheduleSettings: async () => ({ dayStart: "07:00", _source: "defaults" }) },
    getTodayStr: () => DATE,
    addDays: (date, days) => {
      const value = new Date(date + "T12:00:00Z");
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    },
    // buildDayResponse scopes suppressed_items to the app's LOCAL day, so the zone is
    // part of what it reads. Pinned here rather than left to the host's TZ so the
    // evening-boundary behaviour stays deterministic in CI.
    APP_TIME_ZONE: "America/New_York",
    blockDB: {
      // Both readers record into the SAME array: the workspace argument has to survive
      // whichever branch the date comparison picks, so asserting on only one of them
      // would leave the other free to drop it.
      getDccState: async (d, ws) => { asked.push([d, ws]); return null; },
      getDccStateCompact: async (d, ws) => { asked.push([d, ws]); return null; },
      getBlocksByKind: async (kind, ws) => { askedSuppressions.push([kind, ws]); return []; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SUPPRESSIONS_SRC, ctx);
  vm.runInContext(BUILD_DAY_SRC, ctx);
  await vm.runInContext(`buildDayResponse("${DATE}", null, "ws-7")`, ctx);
  await vm.runInContext(`buildDayResponse("${DATE}", 42, null)`, ctx);
  await vm.runInContext(`buildDayResponse("${DATE}", null, null)`, ctx);
  assert.deepEqual(asked, [[DATE, "ws-7"], [DATE, "ws-42"], [DATE, "ws-1"]]);
  assert.deepEqual(askedSuppressions, [
    ["triage_suppression", "ws-7"],
    ["triage_suppression", "ws-42"],
    ["triage_suppression", "ws-1"],
  ]);
});

test("a suppressed triage item is stripped from the day, and rides along as suppressed_items", async () => {
  // The whole point, at the read boundary: "I handled this" must hold on a device that
  // has never seen this day before, which is how it surfaced (a phone showing 23 items
  // the desktop had cleared). The suppression row is dateless, so the date being read
  // is irrelevant to whether it applies.
  const { call } = runBuildDay({
    dbRow: { state_json: { date: DATE, schedule: { timeline: [] }, triage: { open_items: [
      { id: "gmail:abc", type: "email", title: "handled last week" },
      { id: "slack:dm:D1:123", type: "slack", title: "still open" },
    ] } } },
    suppressionBlocks: [
      { id: "sup-1", properties: { kind: "triage_suppression", triage_id: "gmail:abc", key: "email|gmail:abc", itemTitle: "handled today", reason: "done", at: DATE + "T14:02:00.000Z" } },
    ],
  });
  const out = await call();
  assert.deepEqual(out.triage.open_items.map((i) => i.id), ["slack:dm:D1:123"]);
  assert.equal(out.triage.suppressed_items.length, 1, "the client renders Completed + Undo from this");
  assert.equal(out.triage.suppressed_items[0].triage_id, "gmail:abc");
});

test("an item handled on an EARLIER day stays suppressed, but does not clutter today's Completed", async () => {
  // The scoping asymmetry, at the boundary that applies it. open_items must be filtered
  // against every suppression ever (or the item is back tomorrow, which is the whole
  // bug); suppressed_items must be filtered to the day being read (or Completed
  // accumulates every item ever handled, on every date, one DOM row and one click
  // listener each).
  const { call } = runBuildDay({
    dbRow: { state_json: { date: DATE, schedule: { timeline: [] }, triage: { open_items: [
      { id: "gmail:old", type: "email", title: "handled weeks ago" },
      { id: "slack:dm:D1:123", type: "slack", title: "still open" },
    ] } } },
    suppressionBlocks: [
      { id: "sup-old", properties: { kind: "triage_suppression", triage_id: "gmail:old", reason: "done", at: "2026-06-01T09:00:00.000Z" } },
    ],
  });
  const out = await call();
  assert.deepEqual(out.triage.open_items.map((i) => i.id), ["slack:dm:D1:123"], "still suppressed, forever");
  assert.deepEqual(out.triage.suppressed_items, [], "but it is not today's Completed row");
});

test("an unreadable suppression overlay degrades to the RAW triage list, not to a failed day", async () => {
  // Fail-open is deliberate and is the safer direction of the two: showing an item you
  // already handled is a papercut, losing the whole day response is an outage.
  const { call } = runBuildDay({
    dbRow: { state_json: { date: DATE, schedule: { timeline: [] }, triage: { open_items: [{ id: "gmail:abc", type: "email" }] } } },
    suppressionsThrow: true,
  });
  const out = await call();
  assert.deepEqual(out.triage.open_items.map((i) => i.id), ["gmail:abc"]);
  assert.deepEqual(out.triage.suppressed_items, []);
});

test("the Day Review lookback asks for seven days back, ending YESTERDAY, in the caller's OWN workspace", async () => {
  // getDccStateRange DROPS its workspace predicate entirely when the third argument is
  // falsy (db.js), so an unscoped call would let another tenant's dismissals suppress
  // this workspace's cards. Nothing else in the suite would notice.
  const { call, reviewAsked } = runBuildDay({ dbRow: { state_json: { date: DATE, schedule: { timeline: [] } } } });
  await call();
  assert.deepEqual(reviewAsked, [["2026-07-28", "2026-08-03", "ws-1"]]);
});

test("the anonymous share build never runs the Day Review lookback", async () => {
  // buildPublicTodoShare calls this builder as buildDayResponse(date, null, ws) and its
  // client polls every 15 seconds, while never reading glymphatic_brief.
  const { call, reviewAsked } = runBuildDay({
    userId: null,
    dbRow: { state_json: { date: DATE, schedule: { timeline: [] } } },
  });
  await call();
  assert.deepEqual(reviewAsked, []);
});

test("an unreadable Day Review history serves the RAW packet, not a 500", async () => {
  const raw = {
    date: DATE,
    schedule: { timeline: [] },
    glymphatic_brief: { decisions: {}, current: { pages: [{ id: "day-review", items: [{ id: "new-id", title: "reply with exactly READY" }] }] } },
  };
  const { call } = runBuildDay({ dbRow: { state_json: raw }, reviewRowsThrow: true });
  const out = await call();
  assert.deepEqual(out.glymphatic_brief.current.pages[0].items.map((i) => i.id), ["new-id"]);
});

test("a differently keyed Day Review item stays hidden after the same signature was dismissed", async () => {
  const review = (id, decisions = {}) => ({
    date: DATE,
    schedule: { timeline: [] },
    glymphatic_brief: {
      decisions,
      current: { pages: [{ id: "day-review", items: [{ id, title: "reply with exactly READY", tags: ["claude"] }] }] },
    },
  });
  const { call } = runBuildDay({
    dbRow: { state_json: review("new-id") },
    reviewRows: [{ state_json: review("old-id", { "old-id": { action: "dismiss" } }) }],
  });
  const out = await call();
  const page = out.glymphatic_brief.current.pages[0];
  assert.deepEqual(page.items, []);
  assert.equal(page.repeat_suppressed_items[0].id, "new-id");
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

// ★ THE WIRING, not just the helper. Blocker 3 is a property of the mutation CALL SITES -- the
// change was pulled three times precisely because the crux lives there rather than in a
// function -- and reverting any one of them to `readJSON(getDayFilePath(...))` re-arms the
// boot-skeleton promotion with every behavioral test above still green. Same shape as
// push-is-a-move.test.js's source sweep.
test("every routes/dcc.js mutation handler takes Postgres as its BASE state (blocker 3)", () => {
  const code = DCC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal((code.match(/await readDccDayState\(/g) || []).length, 5,
    "a handler that stopped reading Postgres first re-arms the boot-skeleton promotion");
  assert.match(code, /await blockDB\.saveDccBriefDecision\(/,
    "brief decisions use the atomic Postgres read-lock-write primitive instead of a file base");
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

// `/api/dcc/brief/materialize` resolves its owner STRICTLY and creates itinerary rows under that
// workspace, so it must read the brief under the same one. The two resolvers disagree: for a
// DCC_ENDPOINTS token call (no session, no dccServiceAuth, no x-workspace-id) lenient returns the
// hardcoded "ws-1" while strict falls through to a `workspace_members` lookup — so re-deriving
// leniently would read ws-1's brief and materialize real rows into someone else's workspace.
test("brief/materialize reads the day under the SAME owner it writes rows with", () => {
  const code = DCC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const h = code.slice(code.indexOf('app.post("/api/dcc/brief/materialize"'));
  const body = h.slice(0, h.indexOf("app.post(", 10) === -1 ? h.length : h.indexOf("app.post(", 10));
  assert.match(body, /resolveOwnerStrict\(req\)/, "it still resolves strictly");
  // Not `[^)]*`: the call contains `buildSkeletonState(sourceDate)`, so the character class
  // cannot cross that inner `)` and the assertion never matched its own passing code.
  assert.match(body, /readDccDayState\([\s\S]{0,120}?\{ userId, workspaceId \}\)/,
    "and hands that owner to the read instead of letting it re-derive leniently");
});

// EVERY anonymous handler that can observe the new throws, not just the two that were hardened
// first. Round 2 made `buildPublicTodoShare` fail closed and `buildDayResponse` throw, and four
// anonymous routes call into them — `/reactions` and `/comments` were still ending in
// `res.status(400).json({error: e.message})`, so a pool timeout or schema error was echoed
// verbatim. It is user-visible, not just on the wire: `public-todo-share.js submitComment` does
// `alert(e.message)`, so a link holder got a browser alert full of table and constraint names.
test("no anonymous share handler echoes a raw error message", () => {
  const code = SOCIAL_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // Scoped to the ANONYMOUS routes only: each handler's body is sliced from its own
  // declaration to the next one. The owner's `/api/todo-share/*` routes echo `e.message` too and
  // that is fine -- Drake is the only reader. A file-wide sweep flagged six of those and said
  // nothing about the four that matter.
  const decls = [...code.matchAll(/app\.(?:get|post|patch|delete)\("([^"]+)"/g)];
  const anon = [];
  for (let i = 0; i < decls.length; i++) {
    const route = decls[i][1];
    if (!route.startsWith("/api/public/todo-share")) continue;
    const start = decls[i].index;
    const end = i + 1 < decls.length ? decls[i + 1].index : code.length;
    anon.push({ route, body: code.slice(start, end) });
  }
  assert.ok(anon.length >= 4, "expected the anonymous share routes to still exist: " + anon.length);
  for (const { route, body } of anon) {
    assert.doesNotMatch(body, /res\.status\([^)]*\)\.json\(\{ error: e\.message \}\)/,
      route + " returns a raw error message to an anonymous caller");
    assert.doesNotMatch(body, /e\.statusCode \|\| 400/,
      route + " reports a server outage as a bad request, so nothing retries");
    if (/catch \(e\)/.test(body)) {
      assert.match(body, /e\.statusCode \? e\.message :/,
        route + " must only pass through a message for a status it set deliberately");
    }
  }
});

// An outage is a 500, not a 400. Probing with Postgres stopped showed the guest POST
// answering 400 -- `findTodoShareByToken` throws before the writer is reached, so an outage
// arrived as "bad request" and told the guest to re-edit a perfectly good task. Every genuine
// validation failure in that handler is an early `return res.status(400)`, so the catch only
// ever sees a deliberate status (503/429) or something unexpected.
test("the anonymous POST answers 500 for an unexpected failure, and keeps its deliberate statuses", () => {
  const handler = SOCIAL_SRC.slice(SOCIAL_SRC.indexOf('app.post("/api/public/todo-share/:token/tasks"'));
  // 1400, not 600: the catch carries a long rationale comment and a 600-char window stopped
  // before the res.status line, so the assertion failed on a slice that never reached the code.
  const c = handler.slice(handler.indexOf("} catch (e) {"), handler.indexOf("} catch (e) {") + 1400);
  assert.match(c, /res\.status\(/, "the slice must actually reach the response line");
  assert.match(c, /e\.statusCode \|\| 500/, "an unexpected error is a server error");
  assert.match(c, /e\.statusCode \? e\.message :/, "and only a status this code set deliberately keeps its own text");
  assert.doesNotMatch(c, /e\.statusCode \|\| 400/);
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
