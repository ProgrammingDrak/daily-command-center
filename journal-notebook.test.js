"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PAPER_TYPES, unpack, pack } = require("./public/js/journal-notebook");
const stroke = {
  color: "#292722",
  size: 3,
  points: [
    [10, 20],
    [400, 700]
  ]
};

test("existing journal text and photo references survive a drawing round trip", () => {
  const text =
    "# Morning\n\n**Good day.**\n\n![Photo](media:sha256:" + "a".repeat(64) + ")\n\n[Day photo](#dcc-photo-123)\n";
  assert.deepEqual(unpack(text), { text, pages: [[]], templates: ["dotted"], objects: [[]] });
  const saved = pack(text, [[stroke], [], [stroke]]);
  assert.deepEqual(unpack(saved), {
    text,
    pages: [[stroke], [], [stroke]],
    templates: ["dotted", "dotted", "dotted"],
    objects: [[], [], []]
  });
  assert.equal(pack(unpack(saved).text, unpack(saved).pages), saved);
});

test("ten paper types persist independently, even on a page without ink", () => {
  assert.equal(PAPER_TYPES.length, 10);
  assert.equal(new Set(PAPER_TYPES.map((type) => type.id)).size, 10);
  const pages = PAPER_TYPES.map((_, index) => (index % 2 ? [] : [stroke]));
  const templates = PAPER_TYPES.map((type) => type.id);
  const saved = unpack(pack("Text and photos", pages, templates));
  assert.deepEqual(saved, { text: "Text and photos", pages, templates, objects: pages.map(() => []) });
  saved.templates[1] = "music";
  assert.equal(saved.templates[0], "blank");
  assert.equal(saved.templates[2], "wide-ruled");
  assert.deepEqual(unpack(pack("", [[]], ["college-ruled"])).templates, ["college-ruled"]);
});

test("legacy drawings gain dotted paper without changing their strokes or encoding", () => {
  const legacy = pack("Legacy entry", [[stroke], []]);
  const { text, pages, templates } = unpack(legacy);
  assert.deepEqual(templates, ["dotted", "dotted"]);
  assert.equal(pack(text, pages, templates), legacy);
});

test("unknown or mismatched page templates cannot overwrite an entry", () => {
  for (const templates of [["invalid"], [], ["dotted", "music"], "dotted"]) {
    assert.throws(() => pack("", [[]], templates), /templates/);
    const raw = "Text\n\n<!-- dcc-journal-ink:v1\n" + JSON.stringify({ pages: [[]], templates }) + "\n-->";
    assert.throws(() => unpack(raw), /templates/);
  }
});

test("opening a legacy entry without drawing does not rewrite it", () => {
  const text = "An entry\n<!-- an ordinary comment -->\n";
  assert.equal(pack(text, [[]]), text);
  assert.deepEqual(unpack(pack(text, [[], []])).pages, [[], []]);
});

test("malformed ink is refused, preserving source instead of silently dropping drawings", () => {
  const raw = (data) => "Text\n\n<!-- dcc-journal-ink:v1\n" + JSON.stringify(data) + "\n-->";
  for (const data of [
    { pages: [] },
    { pages: [null] },
    { pages: [[{ ...stroke, color: "url(evil)" }]] },
    { pages: [[{ ...stroke, points: [[Infinity, 3]] }]] }
  ]) {
    assert.throws(() => unpack(raw(data)));
  }
});

test("rich page objects and pressure strokes persist without escaping their comment", () => {
  const objects = [
    [
      { kind: "shape", v: 1, shapeType: "arrow", x: 10, y: 20, endX: 300, endY: 200, color: "#315fa8", size: 4 },
      { kind: "text", x: 20, y: 30, w: 300, h: 90, color: "#292722", text: "--> <script>& safe" },
      { kind: "image", x: 50, y: 50, w: 300, h: 200, media: "![Sketchbook image](media:sha256:" + "b".repeat(64) + ")" }
    ]
  ];
  const pages = [
    [
      {
        ...stroke,
        tool: "pencil",
        points: [
          [10, 20, 0.3],
          [400, 700, 0.8]
        ],
        style: { v: 2, angle: 45 }
      }
    ]
  ];
  const encoded = pack("Original text", pages, ["graph"], objects);
  assert.equal(encoded.split("-->").length, 2);
  assert.deepEqual(unpack(encoded), { text: "Original text", pages, templates: ["graph"], objects });
  for (const media of [
    "https://example.com/photo.png",
    "data:image/png;base64,abc",
    "media:sha256:" + "b".repeat(64)
  ]) {
    assert.throws(() => pack("", [[]], ["dotted"], [[{ ...objects[0][2], media }]]), /image/);
  }
});
