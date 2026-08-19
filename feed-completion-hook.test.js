// Contract tests for the feed's PRODUCER: the work-source / privacy lock that
// decides whether a completed task can ever be published.
//
// Why this is the part worth pinning: the lock is ONE-WAY. publishPost refuses a
// `private_task` row at the SQL level, so a task classified as publishable when
// it should have been locked is not a bug you can fix after the fact -- the post
// is already shareable, and the content is a Slack thread or a client's name in
// a meeting title. Getting this wrong leaks somebody else's words.
//
// Harness: the classifier sliced out of routes/blocks.js into a node:vm context,
// same pattern as public-share-status.test.js, so the rule under test is the
// shipped rule and not a copy that can drift from it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = fs.readFileSync(require.resolve("./routes/blocks.js"), "utf8");

function mustMatch(re, what) {
  const m = SRC.match(re);
  if (!m) throw new Error("feed-completion-hook.test.js could not slice " + what + " -- the source moved, fix the pattern");
  return m[0];
}

const LOCK_SRC = mustMatch(
  /const WORK_SOURCES = \[[\s\S]*?\n {2}function isWorkSourcedTask\(props\) \{[\s\S]*?\n {2}\}/,
  "WORK_SOURCES + WORK_KINDS + isWorkSourcedTask"
);
// Fail loudly if the slice stopped matching the real rule. It already earned its
// keep once: changing WORK_SOURCES from a Set to an array broke the pattern, and
// this threw instead of silently testing nothing.
assert.ok(/gcal_event_id/.test(LOCK_SRC), "slice lost the calendar check");
assert.ok(/WORK_KINDS/.test(LOCK_SRC), "slice lost the meeting-kind check");
assert.ok(/startsWith/.test(LOCK_SRC), "slice lost the prefix matching");

const sandbox = { module: {} };
vm.createContext(sandbox);
vm.runInContext(LOCK_SRC + "\nmodule.exports = { isWorkSourcedTask, WORK_SOURCES };", sandbox);
const { isWorkSourcedTask } = sandbox.module.exports;

test("work sources are locked out of the feed", () => {
  for (const source of ["slack", "gmail", "email", "sweep", "triage", "meeting", "gcal", "calendar"]) {
    assert.equal(isWorkSourcedTask({ source }), true, source + " should be locked");
  }
});

test("the source strings production ACTUALLY writes are locked", () => {
  // The first version of this file tested bare "slack", "sweep" and friends --
  // strings no writer in this repo ever stores. routes/slack-events.js writes
  // `source: "slack-bookmark"` with the title taken verbatim from the Slack
  // message text, and Sweep Suite writes "sweep-suite" / kind "sweep_suite_task".
  // Every one of them missed the old exact-match Set, so a colleague's words
  // shipped one button press from a social feed while all six tests stayed green.
  // These fixtures are grepped from the producers, not invented.
  for (const props of [
    { source: "slack-bookmark", kind: "task" },
    { source: "slack-delegate", kind: "task" },
    { source: "sweep-suite" },
    { source: "sweep-calendar" },
    { kind: "sweep_suite_task" },
    { source: "google_chat" },
    { source: "notion" }
  ]) {
    assert.equal(isWorkSourcedTask(props), true, "should be locked: " + JSON.stringify(props));
  }
});

test("every spelling of a meeting is locked", () => {
  // task-model.js and db.js both test `type IN ('meeting','oneone')`, so a 1:1
  // whose title is a person's name must not be publishable through the `type`
  // spelling either.
  for (const p of [{ kind: "meeting" }, { type: "meeting" }, { type: "oneone" }, { kind: "oneone" },
                   { gcal_account_key: "acct" }, { slack_thread_ts: "1.2" }, { source_message_preview: "hi" }]) {
    assert.equal(isWorkSourcedTask({ source: "manual", ...p }), true, JSON.stringify(p));
  }
});

test("source matching is case-insensitive", () => {
  // Sources arrive from several writers (the Slack poller, the sweep, quick-add)
  // and casing is not normalised anywhere upstream.
  assert.equal(isWorkSourcedTask({ source: "Slack" }), true);
  assert.equal(isWorkSourcedTask({ source: "GMAIL" }), true);
});

test("a calendar-derived task is locked even when its source says otherwise", () => {
  // A gcal task can arrive with source "manual" but still carry the event ids,
  // and a meeting title routinely names a client.
  assert.equal(isWorkSourcedTask({ source: "manual", gcal_event_id: "evt_123" }), true);
  assert.equal(isWorkSourcedTask({ source: "manual", gcal_calendar_id: "cal_9" }), true);
});

test("the kind is checked as well as the source", () => {
  assert.equal(isWorkSourcedTask({ source: "manual", kind: "meeting" }), true);
});

test("genuinely personal tasks stay publishable", () => {
  // The feature is worthless if everything is locked, so the negative case
  // matters as much as the positive ones.
  assert.equal(isWorkSourcedTask({ source: "manual" }), false);
  assert.equal(isWorkSourcedTask({ source: "public_share" }), false);
  assert.equal(isWorkSourcedTask({}), false);
  assert.equal(isWorkSourcedTask({ source: "", kind: "task" }), false);
});

test("an unknown source is NOT locked, deliberately", () => {
  // Still a decision rather than an oversight: deny-by-default would swallow
  // every personal task too, and a post stays hidden until the owner publishes
  // it. But this is NOT cover for missing a real producer -- the test above
  // pins the ones that exist today, and a new capture integration must be added
  // to WORK_SOURCES in the same commit that introduces it.
  assert.equal(isWorkSourcedTask({ source: "some_future_integration" }), false);
});

// ── recordCompletionPost: the guards, not just the classifier ────────────────
// The file is named for this function and originally tested only the classifier
// it calls. These are the branches that decide whether a post exists at all, and
// each one fails silently in a different direction.

const HOOK_SRC = mustMatch(
  / {2}async function recordCompletionPost\(result, body, userId, workspaceId\) \{[\s\S]*?\n {2}\}/,
  "recordCompletionPost"
);
assert.ok(/retractCompletionPost/.test(HOOK_SRC), "slice lost the reopen-retracts branch");

function runHook({ result, body, userId = 7, workspaceId = "ws-1" }) {
  const created = [];
  const retracted = [];
  const ctx = {
    console: { error() {} },
    socialStore: {
      async createCompletionPost(arg) { created.push(arg); return { id: 1 }; },
      async retractCompletionPost(owner, taskId) { retracted.push([owner, taskId]); return 1; }
    },
    module: {}
  };
  vm.createContext(ctx);
  vm.runInContext(LOCK_SRC + "\n" + HOOK_SRC + "\nmodule.exports = recordCompletionPost;", ctx);
  return ctx.module.exports(result, body, userId, workspaceId).then(() => ({ created, retracted }));
}

const doneResult = (props, over) => Object.assign(
  { duplicate: false, task: { id: "blk-1", type: "block", properties: props } }, over || {});

test("hook: a normal completion posts once, carrying the title and the mutation id", async () => {
  const { created } = await runHook({
    result: doneResult({ title: "Ship it", points: 30, duration: 25, kind: "task", source: "manual" }),
    body: { completed: true, mutationId: "m1" }
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].titleSnapshot, "Ship it");
  assert.equal(created[0].completionId, "m1", "the mutation id IS the idempotency key");
  assert.equal(created[0].pointsAwarded, 30);
  assert.equal(created[0].isPrivate, false);
  assert.equal(created[0].isWorkSourced, false);
});

test("hook: a replayed completion does not post a second time", async () => {
  const { created } = await runHook({
    result: doneResult({ title: "Ship it" }, { duplicate: true }),
    body: { completed: true, mutationId: "m1" }
  });
  assert.equal(created.length, 0);
});

test("hook: reopening a task RETRACTS instead of posting", async () => {
  // The client mints a fresh mutation id per toggle, so without the retract an
  // un-complete left the post in the publish queue and the next completion
  // stacked a second row for the same task.
  const { created, retracted } = await runHook({
    result: doneResult({ title: "Ship it" }),
    body: { completed: false, mutationId: "m2" }
  });
  assert.equal(created.length, 0);
  assert.deepEqual(retracted, [[7, "blk-1"]]);
});

test("hook: a private task is posted LOCKED, keyed on the exact property name", async () => {
  // A rename of publicVisibility would silently unlock every private task, so
  // the literal spelling is the thing under test.
  const { created } = await runHook({
    result: doneResult({ title: "Therapy", publicVisibility: "private" }),
    body: { completed: true, mutationId: "m3" }
  });
  assert.equal(created[0].isPrivate, true);
});

test("hook: a Slack-sourced completion is posted LOCKED", async () => {
  const { created } = await runHook({
    result: doneResult({ title: "Re: the contract", source: "slack-bookmark", kind: "task" }),
    body: { completed: true, mutationId: "m4" }
  });
  assert.equal(created[0].isWorkSourced, true, "a Slack message title must never be publishable");
});

test("hook: no title, no owner, or no task means no post", async () => {
  for (const [label, args] of [
    ["blank title", { result: doneResult({ title: "   " }), body: { completed: true, mutationId: "m5" } }],
    ["no userId", { result: doneResult({ title: "x" }), body: { completed: true, mutationId: "m6" }, userId: null }],
    ["no task", { result: { duplicate: false, task: null }, body: { completed: true, mutationId: "m7" } }]
  ]) {
    const { created } = await runHook(args);
    assert.equal(created.length, 0, label + " should not post");
  }
});

test("hook: a store failure never propagates into the completion path", async () => {
  // The whole reason for the try/catch: a feed post is decoration, and the user's
  // checkmark must not turn into a 500 because of it.
  const ctx = {
    console: { error() {} },
    socialStore: { async createCompletionPost() { throw new Error("db down"); } },
    module: {}
  };
  vm.createContext(ctx);
  vm.runInContext(LOCK_SRC + "\n" + HOOK_SRC + "\nmodule.exports = recordCompletionPost;", ctx);
  await assert.doesNotReject(() => ctx.module.exports(
    doneResult({ title: "x" }), { completed: true, mutationId: "m8" }, 7, "ws-1"));
});
