const test = require("node:test");
const assert = require("node:assert/strict");

const {
  taskCommonProps,
  taskBlockProps,
  taskSourceUrl,
  taskSourceUrlBlocked,
  taskSourceLabel,
} = require("./public/js/task-serialize");

// This module exists to stop the field-drift the six hand-built task-property
// bags had accumulated, so these tests pin the exact defaulting/reconciliation
// contract the call sites now depend on. A future edit that reintroduces the
// drift should fail here.

test("taskCommonProps applies canonical defaults for an empty task", () => {
  const c = taskCommonProps({}, {});
  assert.equal(c.title, "");
  assert.equal(c.priority, "High");
  assert.equal(c.meta, "");
  assert.equal(c.detail, "");
  assert.equal(c.notionUrl, "");
  assert.equal(c.source, "manual");
  assert.equal(c.source_id, "");
  assert.deepEqual(c.tags, []);
  assert.equal(c.delegatedItemId, null);
  assert.equal(c.linkedBlockId, null);
  assert.equal(c.linkedTagId, null);
  assert.equal(c.commuteMinutes, null);
  assert.equal(c.commuteToMinutes, null);
  assert.equal(c.commuteBackMinutes, null);
});

test("overrides win over ev before defaulting (priority Medium beats the High default)", () => {
  const c = taskCommonProps({ priority: null, source: null }, { priority: "Medium", source: "moved" });
  assert.equal(c.priority, "Medium");
  assert.equal(c.source, "moved");
});

test("delegated/linked fields are preserved (the _scheduleTaskOnDate drift fix)", () => {
  const c = taskCommonProps({ delegatedItemId: "D1", linkedBlockId: "LB1", linkedTagId: "LT1" });
  assert.equal(c.delegatedItemId, "D1");
  assert.equal(c.linkedBlockId, "LB1");
  assert.equal(c.linkedTagId, "LT1");
});

test("commute reconciles in both directions across aliases", () => {
  // to-direction falls back to the single commuteMinutes; back-direction reads
  // the return aliases.
  const a = taskCommonProps({ commuteMinutes: 20, commuteReturnMinutes: 15 });
  assert.equal(a.commuteMinutes, 20);
  assert.equal(a.commuteToMinutes, 20);
  assert.equal(a.commuteBackMinutes, 15);

  const b = taskCommonProps({ commute_minutes: 10, commute_back_minutes: 5 });
  assert.equal(b.commuteMinutes, 10);
  assert.equal(b.commuteToMinutes, 10);
  assert.equal(b.commuteBackMinutes, 5);

  const c = taskCommonProps({ commuteToMinutes: 30, commute_return_minutes: 12 });
  assert.equal(c.commuteToMinutes, 30);
  assert.equal(c.commuteBackMinutes, 12);
});

test("tags coerces non-array input to []", () => {
  assert.deepEqual(taskCommonProps({ tags: "nope" }).tags, []);
  assert.deepEqual(taskCommonProps({ tags: ["a", "b"] }).tags, ["a", "b"]);
});

test("taskBlockProps preserves duration 0 (checklist subtask), not null", () => {
  assert.equal(taskBlockProps({ duration: 0 }).duration, 0);
  assert.equal(taskBlockProps({ durMin: 0 }).duration, 0);
  assert.equal(taskBlockProps({}).duration, null);
});

test("taskBlockProps maps local_id and duration with id/durMin fallbacks", () => {
  const b = taskBlockProps({ id: "evid", durMin: 45, start: "09:00", end: "09:45" });
  assert.equal(b.local_id, "evid");
  assert.equal(b.duration, 45);
  assert.equal(b.start, "09:00");
  assert.equal(b.end, "09:45");

  // explicit overrides win over the ev's id/durMin
  const o = taskBlockProps({ id: "evid", durMin: 45 }, { local_id: "L", duration: 30 });
  assert.equal(o.local_id, "L");
  assert.equal(o.duration, 30);
});

test("taskBlockProps carries the shared value fields through", () => {
  const b = taskBlockProps({ title: "T", priority: "Low", delegatedItemId: "D", tags: ["x"] }, { local_id: "id", duration: 15, start: "10:00", end: "10:15" });
  assert.equal(b.title, "T");
  assert.equal(b.priority, "Low");
  assert.equal(b.delegatedItemId, "D");
  assert.deepEqual(b.tags, ["x"]);
});

// The triage -> task link. Without triageId here, every picker-based create path wrote
// null and the strip's `ev.triageId === triageId` dedupe could never match, so the same
// item could be scheduled twice. Nothing pinned it: the catch-up tests stub the
// scheduler, and fromBlock's tests feed it a hand-built block rather than this output.
test("triageId survives serialization (the scheduled-triage dedupe link)", () => {
  assert.equal(taskCommonProps({}).triageId, null, "absent by default, never undefined");
  assert.equal(taskCommonProps({ triageId: "gmail:abc" }).triageId, "gmail:abc");
  assert.equal(taskBlockProps({ triageId: "gmail:abc" }, { local_id: "x" }).triageId, "gmail:abc",
    "and through the block form, which is what scheduleTaskOnDate writes");
});

test("triage provenance survives every task creation path", () => {
  const provenance = {
    triageId: "slack:dm:D1:1",
    triageKey: "slack|D1:1",
    triageTitle: "Reply to Alex",
    triageType: "slack",
    triageSourceRef: "C1:123",
    triageReceivedAt: "2026-09-03T12:00:00Z",
    triageConversationId: "D1",
  };
  assert.deepEqual(taskCommonProps(provenance), {
    ...taskCommonProps({}),
    ...provenance,
  });
  assert.deepEqual(taskBlockProps(provenance, { local_id: "x" }), {
    ...taskCommonProps({}),
    ...provenance,
    local_id: "x",
    duration: null,
    start: undefined,
    end: undefined,
  });
});

test("source_id survives every shared task serialization path", () => {
  const url = "https://cleverrealestate.slack.com/archives/C1/p123";
  assert.equal(taskCommonProps({ source_id: url }).source_id, url);
  assert.equal(taskBlockProps({ source_id: url }, { local_id: "x" }).source_id, url);
  assert.equal(taskCommonProps({ source_id: "calendar-event-1" }).source_id, "calendar-event-1",
    "non-URL source identities must not be erased by URL rendering rules");
});

test("taskSourceUrl normalizes triage provenance and rejects unsafe schemes", () => {
  const slack = "https://cleverrealestate.slack.com/archives/C1/p123";
  const gmail = "https://mail.google.com/mail/u/0/#all/abc";
  assert.equal(taskSourceUrl({ source_ref: slack }), slack);
  assert.equal(taskSourceUrl({ source_url: gmail }), gmail);
  assert.equal(taskSourceUrl({ link: "  " + slack + "  " }), slack);
  assert.equal(taskSourceUrl({ source_id: "javascript:alert(1)", source_ref: slack }), "",
    "an explicitly unsafe source_id must not fall through to a different field");
  assert.equal(taskSourceUrl({ source_ref: "mailto:person@example.com" }), "");
  assert.equal(taskSourceUrl({ source_ref: "javascript:alert(1)" }), "");
});

// Hostile and merely-opaque both fail the http(s) test, and they need OPPOSITE
// handling. A first-truthy read gave them the same one, which is how the Slack
// permalink on a Waiting check-in went missing: waiting-items.js puts the cycle key
// in source_id and the real deeplink one field over in link/source_ref, so the walk
// stopped on an identity string it was never going to render.
test("taskSourceUrl skips an opaque identity but still aborts on a hostile scheme", () => {
  const slack = "https://cleverrealestate.slack.com/archives/C1/p123";
  const cycleKey = "waiting:blk-1:2026-08-18";
  assert.equal(taskSourceUrl({ source_id: cycleKey, link: slack }), slack,
    "a non-URL identity in source_id must not hide a real deeplink in a later field");
  assert.equal(taskSourceUrl({ source_id: cycleKey, source_ref: slack }), slack);
  assert.equal(taskSourceUrl({ source_id: cycleKey }), "",
    "an opaque identity with nothing to fall back to still resolves to no link");
  assert.equal(taskSourceUrl({ source_id: "javascript:alert(1)", link: slack }), "",
    "skipping opaque values must not weaken the hostile-scheme abort");
  assert.equal(taskSourceUrl({ source_id: "data:text/html,<script>", source_ref: slack }), "");
  assert.equal(taskSourceUrl({ source_id: "  JavaScript:alert(1)", source_ref: slack }), "",
    "the abort is case- and whitespace-insensitive");
  assert.equal(taskSourceUrl({ source_id: cycleKey, link: "javascript:alert(1)", source_ref: slack }), "",
    "the abort applies wherever the walk finds a hostile value, not only in the first field");
});

// A denylist has to test the value the way a BROWSER reads it. Browsers drop leading C0
// controls and whitespace sitting inside a scheme, so these all execute in an href even
// though a naive /^\s*javascript\s*:/ misses them. The http(s) allowlist still gates the
// return value, but the exported predicate is consumed as a safety gate, and a missed
// abort silently fell through to a sibling field.
test("taskSourceUrl normalizes scheme noise the way a browser does", () => {
  const slack = "https://cleverrealestate.slack.com/archives/C1/p123";
  const TAB = String.fromCharCode(9), NL = String.fromCharCode(10), C0 = String.fromCharCode(1);
  for (const [name, hostile] of [
    ["tab inside the scheme", "jav" + TAB + "ascript:alert(1)"],
    ["newline inside the scheme", "jav" + NL + "ascript:alert(1)"],
    ["leading C0 control", C0 + "javascript:alert(1)"],
    ["space before the colon", "javascript :alert(1)"],
  ]) {
    assert.equal(taskSourceUrl(hostile), "", name + " must not resolve");
    assert.equal(taskSourceUrl({ source_id: hostile, link: slack }), "",
      name + " must abort the walk, not launder into the sibling field");
    assert.equal(taskSourceUrlBlocked(hostile), true, name + " must read as hostile");
  }
});

test("taskSourceUrlBlocked separates hostile from merely-opaque, and takes a bare value only", () => {
  assert.equal(taskSourceUrlBlocked("javascript:alert(1)"), true);
  assert.equal(taskSourceUrlBlocked("  DATA:text/html,x"), true);
  assert.equal(taskSourceUrlBlocked("vbscript:msgbox"), true);
  assert.equal(taskSourceUrlBlocked("waiting:blk-1:2026-08-18"), false,
    "opaque is not hostile -- that split is the whole point");
  assert.equal(taskSourceUrlBlocked("https://example.com"), false);
  assert.equal(taskSourceUrlBlocked(null), false);
  assert.equal(taskSourceUrlBlocked({ source_id: "javascript:alert(1)" }), false,
    "unlike taskSourceUrl this takes a bare value; callers must unwrap the record first");
});

test("taskSourceUrl accepts a bare string and rejects a bare unsafe one", () => {
  const slack = "https://cleverrealestate.slack.com/archives/C1/p123";
  assert.equal(taskSourceUrl(slack), slack, "sourceJumpLink passes ev.source_id as a bare string");
  assert.equal(taskSourceUrl("waiting:blk-1:2026-08-18"), "");
  assert.equal(taskSourceUrl("javascript:alert(1)"), "");
  assert.equal(taskSourceUrl(null), "");
  assert.equal(taskSourceUrl(undefined), "");
});

test("taskSourceLabel distinguishes Slack, Gmail and generic sources", () => {
  assert.equal(taskSourceLabel("https://cleverrealestate.slack.com/archives/C1/p123"), "Slack");
  assert.equal(taskSourceLabel("https://mail.google.com/mail/u/0/#all/abc"), "Email");
  assert.equal(taskSourceLabel("https://example.com/item/1"), "Source");
  assert.equal(taskSourceLabel("not-a-url"), "");
});
