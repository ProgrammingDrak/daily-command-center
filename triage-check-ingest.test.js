const assert = require("assert");
const dcc = require("./dcc-intelligence");

const state = {
  date: "2026-06-12",
  triage: {
    open_items: [
      { id: "existing", source: "manual", source_id: "manual|1", title: "Existing", status: "open" },
    ],
    resolved_items: [],
  },
  sweep: { source_health: [] },
  mutations: [],
};

const packet = {
  id: "triage-check-test",
  source: "connector-ai",
  generated_at: "2026-06-12T14:30:00Z",
  omitted_count: 42,
  items: [
    {
      source: "gmail",
      source_id: "thread-a",
      title: "Reply to buyer escalation",
      needs_attention_reason: "Direct question asks for Drake approval today.",
      urgency_score: 91,
      source_url: "https://mail.google.com/thread-a",
      draft_url: "https://mail.google.com/draft-a",
      draft_id: "draft-a",
    },
    {
      source: "slack",
      source_id: "C1:123",
      title: "Answer Mike in Slack",
      needs_attention: false,
      urgency_score: 80,
    },
  ],
};

const next = dcc.ingestTriageCheckPacket({ date: "2026-06-12", state, packet });
const items = next.triage.open_items;
const created = items.find((item) => item.source_id === "gmail|thread-a");

assert.strictEqual(items.length, 2);
assert(created);
assert.strictEqual(created.type, "email_needs_response");
assert.strictEqual(created.priority, "High");
assert.strictEqual(created.urgency_score, 91);
assert.strictEqual(created.draft_link, "https://mail.google.com/draft-a");
assert.strictEqual(created.link, "https://mail.google.com/thread-a");
assert.strictEqual(next.sweep.last_triage_check.attention_items, 1);
assert.strictEqual(next.mutations[0].type, "triage-check-ingest");

console.log("triage-check-ingest: all assertions passed");
