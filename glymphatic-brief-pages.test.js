// Smoke test for the Second Brain Loop M1 spine: a deep-sweep packet's pages
// must survive ingest and surface on glymphatic_brief.current so the Brief tab
// renders them on next load. Run: node glymphatic-brief-pages.test.js
const assert = require("assert");
const { ingestDeepSweepPacket, buildBrief, normalizeDeepPacket } = require("./dcc-intelligence");

const DATE = "2026-06-10";
const PACKET = {
  date: DATE,
  source: "glymphatic-nightly",
  generated_at: "2026-06-10T23:00:00.000Z",
  summary: "Amnesty day: inbox to zero, M1 spine wired.",
  suggested_tasks: [{ id: "sbl-m2", title: "Ship DCC outcome controls", recommended_start: "09:00", priority: "High" }],
  lessons: [{ title: "Inventory-first reference swaps" }],
  pages: [
    {
      id: "front",
      label: "Today + Tomorrow",
      summary: "What got done, what is proposed for tomorrow.",
      done_today: [
        { project: "claude-brain", items: [{ title: "Inbox amnesty: 30 packets closed", detail: "archive + manifest" }] },
        { project: "daily-command-center", items: [{ title: "M1 routes wired", detail: "/api/dcc/refresh, deep-sweep ingest" }] },
      ],
      tomorrow: [
        { id: "t-1", title: "Review Brief front page", suggested_start: "08:30", duration: 30, priority: "High", project: "second-brain-loop" },
      ],
    },
    { id: "process", label: "Sweep", summary: "Nightly run results.", proof_of_work: [{ label: "Refs checked", value: 81 }] },
    { id: "personal-bible", label: "Who am I", source: "personal/personal-bible.md", sections: [{ heading: "Larger goals", body: "Increase AI autonomy." }] },
  ],
};

// 1. Normalization preserves pages.
const normalized = normalizeDeepPacket(PACKET, "glymphatic-nightly");
assert.strictEqual(normalized.pages.length, 3, "normalizeDeepPacket must carry pages");

// 2. Ingest stores pages in context AND rebuilds the brief with them attached.
const state = ingestDeepSweepPacket({ date: DATE, state: { date: DATE }, packet: PACKET, source: "glymphatic-nightly" });
assert.strictEqual(state.glymphatic_context.pages.length, 3, "context must hold pages");
assert.ok(state.glymphatic_brief && state.glymphatic_brief.current, "ingest must rebuild the brief");
assert.strictEqual(state.glymphatic_brief.current.pages.length, 3, "brief.current must carry pages without a separate refresh");
assert.strictEqual(state.glymphatic_brief.current.pages[0].id, "front", "front page must be first");
assert.strictEqual(state.glymphatic_brief.current.pages[0].done_today.length, 2, "done_today groups intact");
assert.strictEqual(state.glymphatic_brief.current.pages[0].tomorrow[0].suggested_start, "08:30", "tomorrow rows intact");
assert.ok(state.glymphatic_brief.current.suggested_tasks.some((t) => t.id === "sbl-m2"), "suggested tasks merged");

// 3. A later buildBrief (e.g. /api/dcc/refresh) keeps preferring context pages.
const rebuilt = buildBrief({ state, openItems: [], meetings: [], health: [] });
assert.strictEqual(rebuilt.current.pages.length, 3, "refresh must not wipe pages");

// 4. A pages-less follow-up packet must not erase previously ingested pages.
const followUp = ingestDeepSweepPacket({ date: DATE, state, packet: { date: DATE, source: "sweep-suite", generated_at: "2026-06-11T00:00:00.000Z", summary: "no pages here" }, source: "sweep-suite" });
assert.strictEqual(followUp.glymphatic_context.pages.length, 3, "pages persist across pages-less packets");
assert.strictEqual(followUp.glymphatic_brief.current.pages.length, 3, "brief keeps pages across pages-less packets");

console.log("glymphatic-brief-pages: all assertions passed");
