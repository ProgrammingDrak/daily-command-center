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

// 5. Brain Health page (glymphatic_packet with id "brain-health") survives
// ingest untouched — trend/machines/stale/toolbox/glossary reach the Brief.
const BH_DATE = "2026-07-07";
const BH_PACKET = {
  date: BH_DATE,
  source: "glymphatic-nightly",
  generated_at: "2026-07-07T23:00:00.000Z",
  summary: "Nightly with brain health.",
  pages: [
    { id: "front", label: "Today + Tomorrow", done_today: [], tomorrow: [] },
    {
      id: "brain-health",
      label: "Brain Health",
      summary: "The eye into the brain.",
      trend: [{ date: "2026-07-06", link_integrity: "98%", drift: "2", staleness: "1", duplication: "0" }],
      machines: [{ machine: "macbook-air-4", last_sync: "2026-07-07", last_evidence: "2026-07-07", status: "ok" }],
      stale: [{ kind: "routing packet open", detail: "daily-review-2026-07-06-routing.md" }],
      toolbox: [{ plugin: "brain-core", description: "Core skills", skills: [{ name: "brain-prune", what: "Prunes memory.", when: "Use as glymphatic Phase 3.5." }] }],
      glossary: [{ term: "Glymphatic", def: "Nightly consolidate-and-clean loop." }],
    },
  ],
};
const bhState = ingestDeepSweepPacket({ date: BH_DATE, state: { date: BH_DATE }, packet: BH_PACKET, source: "glymphatic-nightly" });
const bhPages = bhState.glymphatic_brief.current.pages;
assert.strictEqual(bhPages.length, 2, "brain-health packet pages must survive ingest");
const bhPage = bhPages.find((p) => p.id === "brain-health");
assert.ok(bhPage, "brain-health page present on the brief");
assert.strictEqual(bhPage.machines[0].status, "ok", "machine rows intact");
assert.strictEqual(bhPage.toolbox[0].skills[0].name, "brain-prune", "toolbox rows intact");
assert.strictEqual(bhPage.glossary[0].term, "Glymphatic", "glossary intact");

console.log("glymphatic-brief-pages: brain-health assertions passed");
