"use strict";

// The client half of 🔖 → 👥: the create POST has to tell the server that this
// Waiting item IS a converted task, and it has to say so OUTSIDE `properties`.
//
// Both halves matter. Inside `properties` it would be indistinguishable from
// `linkedBlockId`, which means the opposite thing ("I am blocked on something FOR
// that task") and leaves the task alive under its own 🔖. And the server has to be
// free to ignore everything provenance-shaped in the body, because the reaction
// lookup is `idempotency_key` within a workspace — a client that could choose one
// could point its own row at a teammate's Slack message.
//
// Sliced and EXECUTED rather than grepped: a regex over the source would keep
// passing if the payload were assembled correctly and then never sent.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");

function mustSlice(src, re, what) {
  const m = src.match(re);
  assert.ok(m, what + " not found — the source moved or was renamed, fix the pattern");
  assert.equal(src.match(new RegExp(re.source, re.flags + "g")).length, 1,
    what + " matched more than once, so the slice is ambiguous");
  return m[0];
}

const CREATE_POST = mustSlice(
  SRC,
  /resp = await fetch\("\/api\/waiting-items", \{[\s\S]*?\n {8}\}\);/,
  "the create POST in saveDelegatedItem"
);

// Run the sliced statement with a recording fetch. Nothing else from the module is
// pulled in, so this is exactly the payload the browser would send.
function send({ properties, pendingSourceTaskId }) {
  const sent = [];
  const ctx = {
    properties,
    _pendingSourceTaskId: pendingSourceTaskId,
    resp: null,
    fetch: async (url, init) => { sent.push({ url, init }); return { ok: true }; },
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(`(async () => { ${CREATE_POST} })()`, ctx);
  return { sent, ctx };
}

test("a converted task sends its id as convertedFromBlockId, outside properties", async () => {
  const { sent } = send({ properties: { myTask: "Chase the contract" }, pendingSourceTaskId: "task-slack" });
  await new Promise(r => setTimeout(r, 0));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/waiting-items");
  assert.equal(sent[0].init.method, "POST");
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.convertedFromBlockId, "task-slack");
  assert.ok(!("convertedFromBlockId" in body.properties),
    "inside properties it would be mistaken for user-owned data the server must not trust");
  assert.equal(body.properties.myTask, "Chase the contract");
});

test("an ordinary Waiting item sends null, not a stale id", async () => {
  // _pendingSourceTaskId is module state that outlives one modal. Sending whatever
  // it happens to hold would hand a later, unrelated item somebody else's message.
  const { sent } = send({ properties: { myTask: "Legal sign-off" }, pendingSourceTaskId: null });
  await new Promise(r => setTimeout(r, 0));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.convertedFromBlockId, null);
});

test("an empty-string pending id is normalised to null", async () => {
  const { sent } = send({ properties: { myTask: "Legal sign-off" }, pendingSourceTaskId: "" });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(JSON.parse(sent[0].init.body).convertedFromBlockId, null);
});

// The chain the payload depends on: the 🤝 Delegate spoke calls
// openDelegatedFromTask, which puts sourceTaskId in the prefill, which
// openDelegatedModal parks in _pendingSourceTaskId. If that assignment moves, the
// payload above sends null forever and the conversion silently stops carrying the
// Slack message.
test("the modal still parks prefill.sourceTaskId where the payload reads it", () => {
  assert.match(SRC, /_pendingSourceTaskId = prefill\.sourceTaskId \|\| null;/);
  const opener = mustSlice(SRC, / {2}function openDelegatedFromTask\(task\) \{[\s\S]*?\n {2}\}/, "openDelegatedFromTask");
  assert.match(opener, /sourceTaskId,/, "the prefill still carries the source task id");
});
