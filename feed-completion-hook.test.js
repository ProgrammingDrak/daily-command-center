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
  /const WORK_SOURCES = new Set\(\[[\s\S]*?\n {2}function isWorkSourcedTask\(props\) \{[\s\S]*?\n {2}\}/,
  "WORK_SOURCES + isWorkSourcedTask"
);
// Fail loudly if the slice stopped matching the real rule.
assert.ok(/gcal_event_id/.test(LOCK_SRC), "slice lost the calendar check");

const sandbox = { module: {} };
vm.createContext(sandbox);
vm.runInContext(LOCK_SRC + "\nmodule.exports = { isWorkSourcedTask, WORK_SOURCES };", sandbox);
const { isWorkSourcedTask } = sandbox.module.exports;

test("work sources are locked out of the feed", () => {
  for (const source of ["slack", "gmail", "email", "sweep", "triage", "meeting", "gcal", "calendar"]) {
    assert.equal(isWorkSourcedTask({ source }), true, source + " should be locked");
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
  // Recorded as a decision rather than an oversight: defaulting unknown sources
  // to locked would silently swallow every future integration, and the post is
  // hidden until the owner explicitly publishes it anyway. The privacy flag and
  // the named work sources are the guard, not a deny-by-default.
  assert.equal(isWorkSourcedTask({ source: "some_future_integration" }), false);
});
