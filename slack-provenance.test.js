// Unit tests for lib/slack-provenance.js — the table that says what a Slack
// message IS in the DCC (🔖 task vs 👥 Waiting item) and how it moves between the
// two. Pure functions, so these are exact-value assertions rather than behaviour
// probes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("./lib/slack-provenance.js");

// ── the keys are a WIRE FORMAT, not an implementation detail ─────────────────
//
// claude-brain/scripts/slack-bookmark-to-dcc.py mints `slack-bookmark:<ch>:<ts>`
// independently and its ledger (~/.claude/dcc/slack-bookmark-processed.json) is
// keyed on it, and triage-suppressions.js builds suppression keys from `source`.
// Change either string and one side stops recognising work the other captured.
// This test exists to make that break loud.
test("the idempotency keys and sources keep their exact legacy strings", () => {
  assert.equal(P.slackKeyFor("bookmark", "C1", "1783790506.232729"), "slack-bookmark:C1:1783790506.232729");
  assert.equal(P.slackKeyFor("delegate", "C1", "1783790506.232729"), "slack-delegate:C1:1783790506.232729");
  assert.equal(P.SLACK_KINDS.bookmark.source, "slack-bookmark");
  assert.equal(P.SLACK_KINDS.delegate.source, "slack-delegate");
  assert.equal(P.SLACK_KINDS.bookmark.reaction, "bookmark");
  assert.equal(P.SLACK_KINDS.delegate.reaction, "busts_in_silhouette");
});

test("slackKeysFor returns bookmark first, delegate second", () => {
  // The two-key lookup in routes/slack-events.js passes these positionally as
  // $1, $2 and both test harnesses read them that way.
  assert.deepEqual(P.slackKeysFor("C9", "5.5"), ["slack-bookmark:C9:5.5", "slack-delegate:C9:5.5"]);
});

test("slackKindOf reads a stored row back to its kind, and null for anything else", () => {
  assert.equal(P.slackKindOf({ source: "slack-bookmark" }), "bookmark");
  assert.equal(P.slackKindOf({ source: "slack-delegate" }), "delegate");
  assert.equal(P.slackKindOf({ source: "waiting-unblock" }), null);
  assert.equal(P.slackKindOf({ source: "manual" }), null);
  assert.equal(P.slackKindOf({}), null);
  assert.equal(P.slackKindOf(null), null);
});

test("reactionFor and kindForReaction are inverses, and lifecycle reactions are not kinds", () => {
  assert.equal(P.kindForReaction(P.reactionFor("bookmark")), "bookmark");
  assert.equal(P.kindForReaction(P.reactionFor("delegate")), "delegate");
  // ⌛ and ✅ act ON a message; they never say what it is.
  assert.equal(P.kindForReaction("hourglass"), null);
  assert.equal(P.kindForReaction("white_check_mark"), null);
  assert.equal(P.kindForReaction(""), null);
});

test("otherKind flips, and an unknown kind throws rather than defaulting", () => {
  assert.equal(P.otherKind("bookmark"), "delegate");
  assert.equal(P.otherKind("delegate"), "bookmark");
  // Defaulting here would silently pick a reaction to post, which is worse than
  // a stack trace: it would react on a real message under the wrong emoji.
  assert.throws(() => P.kindMeta("bookmarks"), /Unknown Slack kind/);
  assert.throws(() => P.slackKeyFor("task", "C1", "1.1"), /Unknown Slack kind/);
});

// ── coordinates ─────────────────────────────────────────────────────────────

test("slackCoordsOf needs channel AND ts, and defaults threadTs to ts", () => {
  assert.deepEqual(P.slackCoordsOf({ slack_channel: "C1", slack_ts: "9.1", source_id: "https://x/p91" }), {
    channel: "C1", ts: "9.1", threadTs: "9.1", permalink: "https://x/p91",
  });
  assert.equal(P.slackCoordsOf({ slack_channel: "C1", slack_ts: "9.1" }).threadTs, "9.1");
  assert.equal(P.slackCoordsOf({ slack_channel: "C1", slack_ts: "9.1", slack_thread_ts: "8.0" }).threadTs, "8.0");
  // Either one missing means the row is not addressable, and projectTaskToSlack
  // must not attempt a post it cannot address.
  assert.equal(P.slackCoordsOf({ slack_channel: "C1" }), null);
  assert.equal(P.slackCoordsOf({ slack_ts: "9.1" }), null);
  assert.equal(P.slackCoordsOf({ slack_channel: "", slack_ts: "" }), null);
  assert.equal(P.slackCoordsOf(null), null);
});

// ── retirement ──────────────────────────────────────────────────────────────

test("retireSlackKey makes the key unmatchable by either literal lookup", () => {
  const retired = P.retireSlackKey({ idempotency_key: "slack-bookmark:C1:9.1" }, "2026-08-19T10:00:00.000Z");
  assert.equal(retired.idempotency_key, "slack-bookmark:C1:9.1:retired:2026-08-19T10:00:00.000Z");
  // The point of the suffix: the row can no longer be found by EITHER key the
  // two-key lookup asks for, so no future reaction resurrects it.
  assert.ok(!P.slackKeysFor("C1", "9.1").includes(retired.idempotency_key));
  assert.ok(P.isRetiredKey(retired.idempotency_key));
});

test("retireSlackKey is idempotent and leaves a keyless row alone", () => {
  const once = P.retireSlackKey({ idempotency_key: "slack-delegate:C1:9.1" }, "2026-08-19T10:00:00.000Z");
  const twice = P.retireSlackKey(once, "2026-08-20T10:00:00.000Z");
  assert.equal(twice.idempotency_key, once.idempotency_key, "a second retirement must not stack suffixes");
  assert.deepEqual(P.retireSlackKey({ title: "no key" }), { title: "no key" });
  assert.deepEqual(P.retireSlackKey({}), {});
});

test("retireSlackKey does not mutate the properties it was handed", () => {
  const original = { idempotency_key: "slack-bookmark:C1:9.1", title: "keep" };
  P.retireSlackKey(original, "2026-08-19T10:00:00.000Z");
  assert.equal(original.idempotency_key, "slack-bookmark:C1:9.1");
});

// ── adoption ────────────────────────────────────────────────────────────────

const FROM = {
  source: "slack-bookmark",
  idempotency_key: "slack-bookmark:C1:9.1",
  slack_channel: "C1", slack_ts: "9.1", slack_thread_ts: "8.0",
  slack_author: "U_ALEX", slack_channel_name: "launch",
  source_id: "https://co.slack.com/archives/C1/p91",
  source_message_preview: "please review the checklist",
  contact: { channel: "slack", address: "C1", sourceRef: "https://co.slack.com/archives/C1/p91", threadTs: "8.0", messageTs: "9.1" },
  captureTitle: "Review the launch checklist",
  captureNotes: "Bookmarked from Slack\nhttps://co.slack.com/archives/C1/p91",
  aiTitle: "Review launch checklist with Alex",
  aiSummary: "Alex wants the checklist reviewed before tomorrow.",
  enrichment_status: "complete",
  enrichment_model: "claude-haiku-4-5-20251001",
  // Row state, NOT message state. None of this may cross a conversion.
  title: "Review launch checklist with Alex",
  status: "done",
  completedAt: "2026-08-18T15:00:00.000Z",
  startedAt: "2026-08-18T14:00:00.000Z",
  estimatedMinutes: 5,
  points: 12,
};

test("adoptProvenance carries the message and re-keys it for the target kind", () => {
  const adopted = P.adoptProvenance(FROM, "delegate");
  assert.equal(adopted.source, "slack-delegate");
  assert.equal(adopted.idempotency_key, "slack-delegate:C1:9.1");
  // The message itself survives, including the Haiku work — that is the whole
  // reason a swap converts rather than deleting and reminting.
  assert.equal(adopted.aiTitle, "Review launch checklist with Alex");
  assert.equal(adopted.aiSummary, "Alex wants the checklist reviewed before tomorrow.");
  assert.equal(adopted.captureNotes, FROM.captureNotes);
  assert.equal(adopted.slack_thread_ts, "8.0");
  assert.deepEqual(adopted.contact, FROM.contact);
});

test("adoptProvenance leaves row state behind", () => {
  const adopted = P.adoptProvenance(FROM, "delegate");
  for (const key of ["status", "completedAt", "startedAt", "estimatedMinutes", "points", "title"]) {
    assert.ok(!(key in adopted), `${key} is row state and must not cross a conversion`);
  }
});

// source_id is the Slack permalink AND half of every stored triage suppression
// key (triage-suppressions builds `source + "|" + source_id`). PR #327 declined
// to rotate it for exactly that reason; this pins the decision.
test("adoptProvenance carries source_id unchanged rather than rotating it", () => {
  assert.equal(P.adoptProvenance(FROM, "delegate").source_id, FROM.source_id);
  assert.ok(P.PROVENANCE_KEYS.includes("source_id"));
});

test("adoptProvenance refuses a row with no usable coordinates", () => {
  assert.equal(P.adoptProvenance({ source: "slack-bookmark" }, "delegate"), null);
  assert.equal(P.adoptProvenance({ source: "slack-bookmark", slack_channel: "C1" }, "delegate"), null);
  // Explicit coordinates win when the row itself has none — the reaction event
  // always knows them even if a half-captured row does not.
  const rescued = P.adoptProvenance({ source: "slack-bookmark" }, "delegate", "C7", "3.3");
  assert.equal(rescued.idempotency_key, "slack-delegate:C7:3.3");
});

test("adoptProvenance round-trips back to the original key", () => {
  const there = P.adoptProvenance(FROM, "delegate");
  const back = P.adoptProvenance({ ...FROM, ...there }, "bookmark");
  assert.equal(back.idempotency_key, FROM.idempotency_key);
  assert.equal(back.source, FROM.source);
});

// ── display text ────────────────────────────────────────────────────────────
//
// A Waiting item keeps `title` for the thing it is blocked ON and puts the work in
// `myTask`; a task uses `title`. Copying rather than moving renders a blank row,
// which is how this bug shows up in the UI.
test("displayTextFor moves the work text into the target kind's field", () => {
  assert.deepEqual(P.displayTextFor({ title: "Chase the contract" }, "delegate"),
    { myTask: "Chase the contract", title: "" });
  assert.deepEqual(P.displayTextFor({ myTask: "Chase the contract", title: "Legal approval" }, "bookmark"),
    { title: "Chase the contract", myTask: "" });
});

test("displayTextFor prefers myTask, then title, then the captured title", () => {
  assert.equal(P.displayTextFor({ myTask: "A", title: "B", captureTitle: "C" }, "bookmark").title, "A");
  assert.equal(P.displayTextFor({ title: "B", captureTitle: "C" }, "bookmark").title, "B");
  // A 👥 item minted by the reaction has title "" and myTask set from
  // captureTitle; a half-captured one has only captureTitle to offer.
  assert.equal(P.displayTextFor({ title: "", captureTitle: "C" }, "bookmark").title, "C");
  assert.equal(P.displayTextFor({}, "bookmark").title, "");
});
