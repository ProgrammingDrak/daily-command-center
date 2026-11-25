"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const J = require("./public/js/journal-notebook");
test("rich papers and fractional widths round-trip without rewriting legacy ink", () => {
  const legacy = {
    color: "#292722",
    size: 3,
    points: [
      [2, 4],
      [8, 10]
    ]
  };
  const modern = {
    color: "#315fa8",
    size: 0.6,
    tool: "calligraphy",
    style: { v: 2, angle: 120 },
    points: [
      [3, 5, 0.4],
      [9, 11, 0.8]
    ]
  };
  const papers = [{ type: "engineering", tint: "cream", spacing: 5, margin: false }, null];
  const data = J.unpack(J.pack("Text", [[legacy, modern], []], ["dotted", "music"], [[], []], papers));
  assert.deepEqual(data.papers, papers);
  assert.deepEqual(data.pages[0], [legacy, modern]);
  assert.equal(data.text, "Text");
});
test("paper and nib corruption is refused before a journal drawing is imported", () => {
  const p = { type: "weekly", tint: "white", spacing: 5, margin: true };
  for (const bad of [{ ...p, type: "unknown" }, { ...p, spacing: 400 }, { ...p, tint: "url(evil)" }, null]) {
    if (bad === null) continue;
    assert.throws(() => J.pack("", [[]], undefined, undefined, [bad]), /paper settings/);
  }
  const raw = {
    pages: [[{ color: "#000000", size: 2, tool: "fountain", style: { v: 2, angle: Infinity }, points: [[1, 2, 0.5]] }]]
  };
  assert.throws(() => J.unpack("\n\n<!-- dcc-journal-ink:v1\n" + JSON.stringify(raw) + "\n-->"), /nib/);
});
test("Library and embedded notebooks preserve the existing administrator boundary", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /app\.get\(\["\/library", "\/library\.html"\], requireAdmin,/);
  assert.match(server, /app\.get\("\/library\/notebook", requireAdmin,/);
  assert.match(server, /res\.redirect\(302, "\/library"\)/);
});
test("production Library never loads the prototype entry point or sample fixture", () => {
  const html = fs.readFileSync("library.html", "utf8");
  assert.doesNotMatch(html, /review-assets|sample library|qa-card|library-review/i);
  assert.match(html, /library-workspace\.js/);
});
