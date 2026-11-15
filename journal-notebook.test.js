"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { unpack, pack } = require("./public/js/journal-notebook");
const stroke = { color: "#292722", size: 3, points: [[10, 20], [400, 700]] };

test("existing journal text and photo references survive a drawing round trip", () => {
  const text = "# Morning\n\n**Good day.**\n\n![Photo](media:sha256:" + "a".repeat(64) + ")\n\n[Day photo](#dcc-photo-123)\n";
  assert.deepEqual(unpack(text), { text, pages: [[]] });
  const saved = pack(text, [[stroke], [], [stroke]]);
  assert.deepEqual(unpack(saved), { text, pages: [[stroke], [], [stroke]] });
  assert.equal(pack(unpack(saved).text, unpack(saved).pages), saved);
});

test("opening a legacy entry without drawing does not rewrite it", () => {
  const text = "An entry\n<!-- an ordinary comment -->\n";
  assert.equal(pack(text, [[]]), text);
  assert.deepEqual(unpack(pack(text, [[], []])).pages, [[], []]);
});

test("malformed ink is refused, preserving source instead of silently dropping drawings", () => {
  const raw = data => "Text\n\n<!-- dcc-journal-ink:v1\n" + JSON.stringify(data) + "\n-->";
  for (const data of [{ pages: [] }, { pages: [null] }, { pages: [[{ ...stroke, color: "url(evil)" }]] }, { pages: [[{ ...stroke, points: [[Infinity, 3]] }]] }]) {
    assert.throws(() => unpack(raw(data)));
  }
});
