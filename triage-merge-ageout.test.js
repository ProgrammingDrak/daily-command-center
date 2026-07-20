const assert = require("assert");
const { mergeOpenItems, normalizeTriageItem } = require("./dcc-intelligence");

// Fixed "now" so the age math is deterministic.
const now = Date.parse("2026-06-01T00:00:00Z");
const iso = (s) => new Date(s).toISOString();

// --- age-out over first_seen_at (the field normalization actually carries) ---
const existing = [
  // Fresh non-drafted (1 day) -> keep.
  { source: "gmail", source_id: "fresh", title: "Fresh ask", status: "open", first_seen_at: iso("2026-05-31T00:00:00Z") },
  // Stale non-drafted (31 days) -> drop.
  { source: "gmail", source_id: "old-noise", title: "Old newsletter", status: "open", first_seen_at: iso("2026-05-01T00:00:00Z") },
  // Drafted, 12 days old -> keep (30d grace).
  { source: "gmail", source_id: "old-draft", title: "Drafted reply pending", status: "open", first_seen_at: iso("2026-05-20T00:00:00Z"), draft_url: "https://mail.google.com/draft/x" },
  // Drafted but 61 days old -> drop (past 30d grace).
  { source: "gmail", source_id: "ancient-draft", title: "Abandoned draft", status: "open", first_seen_at: iso("2026-04-01T00:00:00Z"), draft_url: "https://mail.google.com/draft/y" },
  // Slack unix-seconds ts, fresh, no first_seen_at -> keep (ts fallback + numeric parsing).
  { source: "slack", source_id: "C1:1", title: "Fresh slack", status: "open", ts: Date.parse("2026-05-31T12:00:00Z") / 1000 },
  // received_at fallback, 31 days, no first_seen_at -> drop.
  { source: "gmail", source_id: "recv-only", title: "received_at fallback", status: "open", received_at: iso("2026-05-01T00:00:00Z") },
  // Already resolved -> drop.
  { source: "gmail", source_id: "done", title: "Resolved", status: "resolved", first_seen_at: iso("2026-05-31T00:00:00Z") },
  // No parseable timestamp -> fail safe, keep.
  { source: "manual", source_id: "no-ts", title: "No timestamp", status: "open" },
];

// A brand-new fresh item arriving this merge -> keep.
const incoming = [
  { source: "gmail", source_id: "incoming-fresh", title: "New ask", first_seen_at: iso("2026-06-01T00:00:00Z") },
];

const merged = mergeOpenItems(existing, incoming, now);
const ids = new Set(merged.map((i) => i.source_id));

assert(ids.has("fresh"), "fresh non-drafted item should survive");
assert(!ids.has("old-noise"), ">7d non-drafted item should age out (first_seen_at)");
assert(ids.has("old-draft"), "drafted reply within 30d grace should survive");
assert(!ids.has("ancient-draft"), "drafted reply past 30d grace should age out");
assert(ids.has("C1:1"), "fresh slack ts item should survive (ts fallback)");
assert(!ids.has("recv-only"), ">7d item should age out via received_at fallback");
assert(!ids.has("done"), "resolved item should be dropped");
assert(ids.has("no-ts"), "item with no timestamp should be kept (fail safe)");
assert(ids.has("incoming-fresh"), "incoming fresh item should be added");

// --- re-emission must NOT reset an old item's age ---
// The reader re-emits an item every sweep with a freshly stamped first_seen_at.
// mergeOpenItems must keep the persisted (older) value, or nothing ever ages out.
const persisted = [{ source: "gmail", source_id: "stale-1", title: "Stale", status: "open", first_seen_at: iso("2026-05-01T00:00:00Z") }];
const reEmit = [{ source: "gmail", source_id: "stale-1", title: "Stale", status: "open", first_seen_at: iso("2026-06-01T00:00:00Z") }];
const afterReEmit = mergeOpenItems(persisted, reEmit, now);
assert(!afterReEmit.some((i) => i.source_id === "stale-1"), "a re-emitted stale item keeps its old first_seen_at and still ages out");

// --- normalization must carry the source timestamp into first_seen_at ---
// This is the production path the earlier version bypassed: readers run raw
// items through normalizeTriageItem before mergeOpenItems sees them.
const norm = normalizeTriageItem("gmail", { id: "n1", title: "Norm", received_at: iso("2026-05-01T00:00:00Z") });
assert.strictEqual(norm.first_seen_at, iso("2026-05-01T00:00:00Z"), "normalizeTriageItem should carry received_at into first_seen_at");
const normMerged = mergeOpenItems([norm], [], now);
assert(!normMerged.some((i) => i.id === "n1"), "a normalized 31d-old item should age out end to end");

console.log("triage-merge-ageout: all assertions passed");
