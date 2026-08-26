"use strict";

// Mycelium Ink writes handwritten pages into a notebook node. The rule that
// makes that safe is: a page is keyed by its NUMBER, not by its content. An
// edited page necessarily has a new ink hash, so content-keyed dedup alone
// would append a second copy of the same page. These tests pin that rule.

const test = require("node:test");
const assert = require("node:assert");

const mountVault = require("./routes/vault");
const { notebookPageRecord, upsertPageSection, upsertPageEntry, splitSections } = mountVault;

const INK = "a".repeat(64);
const IMG = "b".repeat(64);
const INK2 = "c".repeat(64);
const IMG2 = "d".repeat(64);

const rec = (over = {}) => notebookPageRecord(Object.assign({
  pageNumber: 1,
  transcript: "first page",
  confidence: 0.9,
  ink: { hash: INK },
  image: { hash: IMG },
  ocrSource: "vision",
}, over));

// ── the projection ────────────────────────────────────────────────────────────

test("record embeds the image, cites the ink, and carries the transcript", () => {
  const r = rec({ pageNumber: 3, transcript: "morning pages" });
  assert.match(r.sectionText, /^## Page 3$/m);
  assert.match(r.sectionText, /!\[Page 3\]\(media:sha256:b{64}\)/);
  assert.match(r.sectionText, /ink: media:sha256:a{64}/);
  assert.match(r.sectionText, /morning pages/);
  assert.deepStrictEqual(
    { page: r.entry.page, ink: r.entry.ink, image: r.entry.image, confidence: r.entry.confidence },
    { page: 3, ink: "a".repeat(12), image: "b".repeat(12), confidence: 0.9 },
  );
});

test("a page with only a diagram is valid, not a failed upload", () => {
  const r = rec({ transcript: "" });
  assert.match(r.sectionText, /_No recognized text on this page\._/);
  assert.strictEqual(r.transcript, "");
});

test("a high ink gap marks the page partially unread instead of passing it as complete", () => {
  const clean = rec({ inkGap: 0.05 });
  assert.strictEqual(clean.partial, false);
  assert.ok(!/not recognized/.test(clean.sectionText));

  const partial = rec({ inkGap: 0.44 });
  assert.strictEqual(partial.partial, true);
  assert.match(partial.sectionText, /not recognized/);
  assert.strictEqual(partial.entry.ocr_partial, true);
});

test("bad input is refused rather than written", () => {
  assert.throws(() => rec({ pageNumber: 0 }), /pageNumber/);
  assert.throws(() => rec({ pageNumber: 1.5 }), /pageNumber/);
  assert.throws(() => rec({ ink: { hash: "nope" } }), /ink blob/);
  assert.throws(() => rec({ image: null }), /page image/);
  assert.throws(() => rec({ confidence: 1.4 }), /confidence/);
  assert.throws(() => rec({ transcript: "x".repeat(200001) }), /too large/);
});

// ── the upsert rule: the whole reason this filing model works ─────────────────

test("re-syncing an edited page REPLACES its section, never appends a second", () => {
  let body = upsertPageSection("", 1, rec({ pageNumber: 1, transcript: "draft" }).sectionText);
  body = upsertPageSection(body, 2, rec({ pageNumber: 2, transcript: "page two" }).sectionText);

  // Edit page 1. New ink, new image, same page number.
  const edited = notebookPageRecord({
    pageNumber: 1, transcript: "revised", ink: { hash: INK2 }, image: { hash: IMG2 },
  });
  body = upsertPageSection(body, 1, edited.sectionText);

  assert.strictEqual(body.match(/^## Page 1$/gm).length, 1, "page 1 must appear exactly once");
  assert.strictEqual(body.match(/^## Page 2$/gm).length, 1);
  assert.match(body, /revised/);
  assert.ok(!/draft/.test(body), "the superseded transcript must be gone");
  assert.match(body, /media:sha256:d{64}/, "the new image must be referenced");
});

test("pages stay in numeric order regardless of the order they sync in", () => {
  let body = "";
  for (const n of [3, 1, 10, 2]) {
    body = upsertPageSection(body, n, rec({ pageNumber: n, transcript: `p${n}` }).sectionText);
  }
  const order = [...body.matchAll(/^## Page (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepStrictEqual(order, [1, 2, 3, 10], "10 must sort after 2, not lexically");
});

test("a hand-written preamble and trailing sections survive a page sync", () => {
  const body = [
    "# Morning Pages",
    "",
    "My own note about this notebook.",
    "",
    "## Page 1",
    "",
    "one",
    "",
    "## Links",
    "- [[clever]]",
  ].join("\n");

  const out = upsertPageSection(body, 2, rec({ pageNumber: 2, transcript: "two" }).sectionText);

  assert.match(out, /# Morning Pages/);
  assert.match(out, /My own note about this notebook\./);
  assert.match(out, /## Links/);
  assert.match(out, /- \[\[clever\]\]/);
  // Links is not a page, so it stays after every page section.
  assert.ok(out.indexOf("## Page 2") < out.indexOf("## Links"), "non-page sections stay at the end");
});

test("splitSections keeps section text verbatim", () => {
  const { preamble, sections } = splitSections("intro\n\n## A\nbody a\n\n## B\nbody b");
  assert.match(preamble, /intro/);
  assert.deepStrictEqual(sections.map((s) => s.heading), ["A", "B"]);
  assert.match(sections[0].lines.join("\n"), /body a/);
});

test("a heading that merely mentions a page is not treated as one", () => {
  const body = "## Page notes\n\nnot a page section\n";
  const out = upsertPageSection(body, 1, rec({ transcript: "real" }).sectionText);
  assert.match(out, /## Page notes/);
  assert.strictEqual(out.match(/^## Page 1$/gm).length, 1);
});

// ── the frontmatter index follows the same rule ───────────────────────────────

test("the page index upserts and sorts rather than accumulating duplicates", () => {
  let pages = upsertPageEntry([], { page: 2, ink: "x", image: "y" });
  pages = upsertPageEntry(pages, { page: 1, ink: "a", image: "b" });
  pages = upsertPageEntry(pages, { page: 2, ink: "z", image: "w" });   // page 2 re-synced

  assert.deepStrictEqual(pages.map((p) => p.page), [1, 2]);
  assert.strictEqual(pages.filter((p) => p.page === 2).length, 1);
  assert.strictEqual(pages.find((p) => p.page === 2).ink, "z", "latest ink wins");
});

test("the page index tolerates a missing or malformed list", () => {
  assert.deepStrictEqual(upsertPageEntry(undefined, { page: 1 }).map((p) => p.page), [1]);
  assert.deepStrictEqual(upsertPageEntry(null, { page: 1 }).map((p) => p.page), [1]);
  assert.deepStrictEqual(upsertPageEntry([null, { page: 1, ink: "old" }], { page: 1, ink: "new" }).length, 1);
});

test("round trip: body and index agree on which pages exist", () => {
  let body = "";
  let pages = [];
  for (const n of [1, 2, 3]) {
    const r = rec({ pageNumber: n, transcript: `p${n}` });
    body = upsertPageSection(body, n, r.sectionText);
    pages = upsertPageEntry(pages, r.entry);
  }
  const inBody = [...body.matchAll(/^## Page (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepStrictEqual(inBody, pages.map((p) => p.page));
});
