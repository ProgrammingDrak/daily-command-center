// Journal task type: registry, projection and privacy boundaries that do not need
// a database. PostgreSQL behavior lives in journal-postgres.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const TaskTypes = require("./public/js/task-types");
const TaskModel = require("./public/js/task-model");
const TaskSerialize = require("./public/js/task-serialize");
const accountBinding = require("./lib/account-binding");

test("registry: Journal is a normal earning, movable, private-record task type", () => {
  const j = TaskTypes.get("journal");
  assert.equal(j.label, "Journal"); assert.equal(j.tagCls, "tag-journal");
  assert.equal(j.privateRecord, true); assert.equal(j.earnsOwnPoints, true);
  assert.equal(TaskTypes.isFixed("journal"), false); assert.equal(j.recordType, undefined, "not an activity record");
  assert.deepEqual(TaskTypes.privateRecordTypes().sort(), ["guided", "journal", "meal", "workout"]);
  assert.equal(TaskTypes.isPrivateRecord({ type: "Journal" }), true);
  assert.equal(TaskTypes.isPrivateRecord("task"), false);
  assert.ok(!TaskTypes.nonEarningTypes().includes("journal"));
});

test("projection: fromBlock carries only the journal identity, never page content", () => {
  const ev = TaskModel.fromBlock({ id: "b1", type: "block", date: "2026-10-31", properties: {
    local_id: "b1", title: "Pages", type: "journal", journalId: "jr_abc12345", publicVisibility: "private", ink: { strokes: [1] }, body: "secret" } });
  assert.equal(ev.journalId, "jr_abc12345"); assert.equal(ev.type, "journal");
  assert.equal(ev.ink, undefined); assert.equal(ev.body, undefined);
});

test("serializer: a Journal's id rides with it and forces private; other types never gain one", () => {
  const props = TaskSerialize.taskCommonProps({ title: "Pages", type: "journal", journalId: "jr_abc12345", publicVisibility: "public" });
  assert.equal(props.journalId, "jr_abc12345"); assert.equal(props.type, "journal"); assert.equal(props.publicVisibility, "private");
  const plain = TaskSerialize.taskCommonProps({ title: "Plain", type: "task", journalId: "jr_abc12345" });
  assert.equal(plain.journalId, undefined);
  const src = fs.readFileSync("./public/js/schedule.js", "utf8");
  assert.match(src, /item\.type==="journal"&&item\.journalId\?\{journalId:item\.journalId\}/, "persistAddedTask carries the id");
});

test("public share link: Journal tasks are hidden even when a stale row claims public visibility", async () => {
  const src = fs.readFileSync(require.resolve("./routes/social-todo"), "utf8");
  const names = ["localTimeFromAny","taskMinutes","publicTaskIdentityIds","normalizeReactionIdentityIds","addReactionToMap","addCommentToMap","publicTaskStatus","publicFeedType","publicFeedTypeLabel","getPublicCalendarMap","getPublicTagMap","calendarMeta","publicTaskPoints","normalizePublicTask","buildPublicTodoShare"];
  const functions = names.map(n => { const m = src.match(new RegExp("(?:async )?function " + n + "\\([^]*?\\n\\}")); assert.ok(m, n); return m[0]; }).join("\n");
  const blocks = [
    { id: "journal-stale", type: "block", properties: { title: "Synthetic journal title", type: "journal", journalId: "jr_leakcheck-1", publicVisibility: "public" } },
    { id: "journal-untyped", type: "block", properties: { title: "Synthetic untyped journal", journalId: "jr_leakcheck-2" } },
    { id: "public", type: "block", properties: { title: "Synthetic shared commitment" } },
  ];
  const ctx = { console, crypto, TaskTypes, isValidDate: () => true, getTodayStr: () => "2026-10-31", coerceDateString: x => x,
    filterLegacyGcalBlocks: x => x, scoreTaskPoints: () => ({ eligible: false }), capabilities: require("./capabilities"),
    buildDayResponse: async () => ({ schedule: { timeline: [{ id: "journal-stale", label: "Synthetic journal title" }], timeBlocks: [] }, triage: { open_items: [] } }),
    blockDB: { getBlocksByDateIncludingDeleted: async () => blocks },
    pool: { query: async () => ({ rows: [] }) } };
  vm.createContext(ctx); vm.runInContext(functions, ctx);
  const out = await ctx.buildPublicTodoShare({ id: 1, workspace_id: "ws-1" }, "2026-10-31", null);
  assert.deepEqual(JSON.parse(JSON.stringify(out.tasks.map(t => t.id))), ["public"]);
  assert.doesNotMatch(JSON.stringify(out), /Synthetic journal|untyped journal|jr_leakcheck/);
});

test("feed completion posts treat every private-record type as private", () => {
  const src = fs.readFileSync("./routes/blocks.js", "utf8");
  assert.match(src, /isPrivate: props\.publicVisibility === "private" \|\| TaskTypes\.isPrivateRecord\(props\.type\)/);
});

test("account binding: a stale tab cannot send a queued journal save to a newly signed-in account", () => {
  function check(path, headers) {
    let accepted = false, result;
    const req = { path, workspaceId: "ws-2", session: { userId: 2 }, get: k => headers[k] };
    const res = { status(n) { this.n = n; return this; }, json(body) { result = { status: this.n, body }; } };
    accountBinding(req, res, () => { accepted = true; });
    return { accepted, result };
  }
  const stale = check("/api/journal/tasks/jt-1", { "X-DCC-User": "1", "X-DCC-Workspace": "ws-1" });
  assert.equal(stale.accepted, false); assert.equal(stale.result.status, 409); assert.equal(stale.result.body.code, "ACCOUNT_CHANGED");
  assert.equal(check("/api/journal/tasks/jt-1", {}).accepted, false, "headers are required on journal routes");
  assert.equal(check("/api/journal/tasks/jt-1", { "X-DCC-User": "2", "X-DCC-Workspace": "ws-2" }).accepted, true);
});

test("server ink validation is one shared definition for vault notebooks and journal pages", () => {
  const vault = require("./routes/vault.js");
  const shared = require("./lib/ink-page-validation");
  assert.equal(vault.validateNotebookInk, shared.validateInkBuffer);
  const store = fs.readFileSync("./journal-store.js", "utf8");
  assert.match(store, /require\("\.\/lib\/ink-page-validation"\)/);
});

test("existing journals are untouched: mood journal keys and Ink notebook storage are not referenced", () => {
  for (const file of ["public/js/journal-task/editor.js", "public/js/journal-task/page-store.js", "public/js/journal-task/page-sync.js"]) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /dcc-glymphatic-brief|dcc-daylio|mycelium-ink-|notebook-page-ingest|journal-image-ingest/, file);
  }
});
