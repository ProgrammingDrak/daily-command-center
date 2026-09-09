const test = require("node:test");
const assert = require("node:assert/strict");
const titles = require("./public/js/slack-titles");
const cases = require("./test-support/slack-title-cases.json");
const model = require("./public/js/task-model");
const { taskCommonProps } = require("./public/js/task-serialize");
const { compactState } = require("./state-projection");
const fs = require("node:fs");
const vm = require("node:vm");
const triageCode = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");

for (const [raw, expected] of cases) {
  test("readable Slack title: " + (raw || "empty"), () => {
    assert.equal(titles.titleFromText(raw), expected);
  });
}

test("long messages stay bounded without truncating mention syntax", () => {
  for (let count = 1; count < 50; count++) {
    const raw = "<@U123|Drake Shadwell (EST)>, please review " + "lengthy-word ".repeat(count);
    const title = titles.titleFromText(raw);
    assert.ok(title.length <= 80);
    assert.ok(title.startsWith("Review "));
    assert.ok(!title.includes("U123"));
  }
});

test("Triage normalization preserves source identity and original text", () => {
  const raw = { id: "slack:mention:C123:1.2", type: "slack", title: "#leadership-plus: <@U123|Drake>, please review the report", source_ref: "https://example.slack.com/archives/C123/p12" };
  const state = compactState({ triage: { open_items: [raw] } });
  const item = state.triage.open_items[0];
  assert.equal(item.title, "Review the report");
  assert.equal(item.sourceContext, "#leadership-plus");
  assert.equal(item.originalTitle, raw.title);
  assert.equal(item.id, raw.id);
  assert.equal(item.source_ref, raw.source_ref);
  assert.notEqual(raw.title, item.title, "input remains immutable");
  assert.deepEqual(titles.normalizeTriageItem(item), item);
  const edited = { ...item, title: "My edited task title" };
  assert.deepEqual(titles.normalizeTriageItem(edited), edited);
});

test("existing imported tasks display readable names and retain them through serialization", () => {
  const props = { source: "triage", triageType: "slack", title: "DM: <@U123|Drake>, can you review the report?", triageId: "slack:dm:C123:1.2" };
  props.triageTitle = props.title;
  const task = model.fromBlock({ id: "original-id", properties: props });
  assert.equal(task.title, "Review the report");
  assert.equal(task.sourceContext, "DM");
  assert.equal(task.id, "original-id");
  const saved = taskCommonProps(task);
  assert.equal(saved.title, "Review the report");
  assert.equal(saved.triageId, props.triageId);
  assert.equal(model.fromBlock({ id: "original-id", properties: { ...props, title: "My title" } }).title, "My title");
});

test("non-Slack and manually renamed captured tasks retain their titles", () => {
  const gmail = { id: "gmail:123", type: "email", title: "Re: Please check the report" };
  assert.equal(titles.normalizeTriageItem(gmail), gmail);
  assert.equal(titles.displayTitle({ source: "manual", title: "Please check this" }), "Please check this");
  assert.equal(titles.displayTitle({ source: "slack-bookmark", captureTitle: "Old title", title: "My deliberate title" }), "My deliberate title");
});

test("triage-check ingestion classifies Slack even with its own source label", () => {
  const { ingestTriageCheckPacket } = require("./dcc-intelligence");
  const state = ingestTriageCheckPacket({ date: "2026-09-09", state: {}, packet: {
    items: [{ source: "slack", source_id: "C123:1.2", title: "#finance: <@U123|Drake>, please review the report", urgency_score: 90, needs_attention_reason: "Direct request" }],
  } });
  assert.equal(compactState(state).triage.open_items[0].title, "Review the report");
});

test("distinct Slack messages with identical cleaned titles remain distinct tasks", () => {
  const fn = triageCode.slice(triageCode.indexOf("function existingTriageTask("), triageCode.indexOf("\nasync function scheduleTriageOnDate("));
  const a = titles.normalizeTriageItem({ id: "slack:dm:C1:1", type: "slack", title: "#finance: Please review the report" });
  const b = titles.normalizeTriageItem({ id: "slack:dm:C2:2", type: "slack", title: "#sales: Please review the report" });
  assert.equal(a.title, b.title);
  const task = { id: "task-a", source: "triage", triageId: a.id, title: a.title };
  const ctx = vm.createContext({ scheduled: [task], DCC: { TaskModel: { selectActive: rows => rows } }, viewDate: "2026-09-09" });
  vm.runInContext(fn, ctx);
  assert.equal(ctx.existingTriageTask(a.id, a), task);
  assert.equal(ctx.existingTriageTask(b.id, b), null);
});

test("both Scheduled board sections render decoded Slack markup as text", () => {
  const raw = "&lt;img src=x onerror=alert(1)&gt;";
  const title = titles.titleFromText(raw);
  const task = model.fromBlock({ id: "proof-task", properties: { source: "slack-bookmark", title, captureTitle: title, start: "09:00", end: "09:05" } });
  const fn = triageCode.slice(triageCode.indexOf("function buildScheduled()"), triageCode.indexOf("// The Priority section", triageCode.indexOf("function buildScheduled()")));
  for (const minutes of [0, 600]) {
    const board = { innerHTML: "", querySelectorAll: () => [] };
    const ctx = vm.createContext({ document: { getElementById: id => id === "scheduled-board" ? board : null }, __state: { date: "2026-09-09" }, now: () => minutes,
      DCC: { esc: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), TaskModel: { selectNotDeleted: rows => rows } },
      scheduled: [task], pt: () => 540, isDone: () => false, cfg: () => ({ color: "red", cls: "task", tag: "Task" }), isMeeting: () => false, f12: x => x, ms: String, dur: () => 5 });
    vm.runInContext(fn + "\nbuildScheduled();", ctx);
    assert.ok(!board.innerHTML.includes("<img"));
    assert.ok(board.innerHTML.includes("&lt;img"));
  }
});
