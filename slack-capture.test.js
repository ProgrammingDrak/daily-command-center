const test = require("node:test");
const assert = require("node:assert/strict");
const capture = require("./lib/slack-capture");

test("fallback title keeps short messages and cuts longer messages at 5-10 words", () => {
  assert.equal(capture.fallbackTitle("Fix the invoice"), "Fix the invoice");
  assert.equal(
    capture.fallbackTitle("Please ask Jamie for approval. Then send the final launch packet today"),
    "Please ask Jamie for approval."
  );
  assert.equal(
    capture.fallbackTitle("One two three four five six seven eight nine ten eleven twelve"),
    "One two three four five six seven eight nine ten..."
  );
});

test("thread selection preserves root, reacted message, and newest replies under truncation", () => {
  const messages = Array.from({ length: 30 }, (_v, i) => ({ ts: String(i), user: `U${i}`, text: `message ${i} ${"x".repeat(80)}` }));
  const selected = capture.selectThreadForPrompt(messages, "5", 1600);
  assert.equal(selected[0].ts, "0");
  assert.ok(selected.some((m) => m.ts === "5"));
  assert.ok(selected.some((m) => m.ts === "29"));
  assert.ok(selected.length < messages.length);
});

test("Haiku JSON validation rejects oversized or malformed output", () => {
  assert.deepEqual(capture.parseEnrichmentText('{"title":"Send the packet","summary":"Jamie needs the final copy."}'), {
    title: "Send the packet",
    summary: "Jamie needs the final copy.",
  });
  assert.throws(() => capture.parseEnrichmentText("not json"));
  assert.throws(() => capture.parseEnrichmentText(JSON.stringify({ title: "x".repeat(81), summary: "ok" })));
});

test("calendar and retry helpers are deterministic", () => {
  assert.equal(capture.addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(capture.nextRetryIso(1, 0), "1970-01-01T00:05:00.000Z");
  assert.equal(capture.nextRetryIso(20, 0), "1970-01-02T00:00:00.000Z");
});

test("fallback permalinks preserve thread reply context", () => {
  assert.equal(
    capture.slackPermalink("example.slack.com", "C123", "1700000001.000200", "1700000000.000100"),
    "https://example.slack.com/archives/C123/p1700000001000200?thread_ts=1700000000.000100&cid=C123"
  );
  assert.equal(
    capture.slackPermalink("example.slack.com", "C123", "1700000000.000100", "1700000000.000100"),
    "https://example.slack.com/archives/C123/p1700000000000100"
  );
});

test("file-only Slack messages use file titles as capture text", () => {
  assert.equal(
    capture.normalizeSlackMessage({ ts: "1.2", text: "", files: [{ title: "Signed renewal packet.pdf" }] }).text,
    "Signed renewal packet.pdf"
  );
  assert.equal(
    capture.normalizeSlackMessage({ ts: "1.3", files: [{ name: "launch-checklist.xlsx" }, { title: "Approval notes" }] }).text,
    "launch-checklist.xlsx; Approval notes"
  );
});
