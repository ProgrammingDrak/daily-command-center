"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./public/js/ink/strokes.js");
const Archive = require("./public/js/ink/archive.js");
function context() {
  const ops = [];
  const ctx = { globalAlpha: 1 };
  for (const name of ["save", "restore", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "arc", "stroke", "fill", "fillRect", "fillText", "setLineDash"]) {
    ctx[name] = (...args) => ops.push({ name, args, alpha: ctx.globalAlpha, width: ctx.lineWidth, color: ctx.fillStyle });
  }
  return { ctx, ops };
}
function sample(tool) {
  const stroke = S.newStroke(tool, "#1b1b2f", 10, { angle: 0 });
  for (let i = 0; i < 20; i++) S.addPoint(stroke, i * 10, Math.sin(i / 2) * 30 + 100, 0.1 + i / 25, 0);
  return stroke;
}
test("implements have distinct pressure, directional nib and graphite behavior", () => {
  const ratio = tool => S.widthAt(sample(tool), 0.1) / S.widthAt(sample(tool), 1);
  assert.equal(ratio("fineliner"), 1);
  assert.equal(ratio("mechanical"), 1);
  assert.ok(ratio("ballpoint") > ratio("fountain"));
  assert.ok(ratio("fountain") > ratio("brush"));
  for (const tool of ["fountain", "calligraphy", "marker"]) {
    const s = S.newStroke(tool, "#000", 10, { angle: 0 });
    S.addPoint(s, 0, 0, 1, 0); S.addPoint(s, 10, 0, 1, 0);
    const horizontal = context(); S.drawStroke(horizontal.ctx, s, { mask: true });
    s.pts[3] = 0; s.pts[4] = 10;
    const vertical = context(); S.drawStroke(vertical.ctx, s, { mask: true });
    assert.ok(horizontal.ops.find(o => o.name === "stroke").width < vertical.ops.find(o => o.name === "stroke").width);
  }
  const graphite = context(), ink = context();
  S.drawStroke(graphite.ctx, sample("pencil"), { mask: true }); S.drawStroke(ink.ctx, sample("ballpoint"), { mask: true });
  assert.ok(graphite.ops.some(o => o.name === "arc"));
  assert.ok(!ink.ops.some(o => o.name === "arc"));
  assert.ok(new Set(graphite.ops.filter(o => o.name === "fill").map(o => o.alpha)).size > 1);
});
test("full renders composite each modern stroke once, within the stroke's box", () => {
  const made = [];
  const prior = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; const c = context(); c.ctx.setTransform = () => {}; c.ctx.clearRect = (...args) => c.ops.push({ name: "clearRect", args }); this.ops = c.ops; this.getContext = () => c.ctx; made.push(this); } };
  try {
    const outer = context();
    outer.ctx.canvas = { width: 2550, height: 3300 };
    outer.ctx.getTransform = () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    outer.ctx.setTransform = () => {};
    outer.ctx.globalCompositeOperation = "source-over";
    outer.ctx.drawImage = (...args) => outer.ops.push({ name: "drawImage", args, alpha: outer.ctx.globalAlpha, op: outer.ctx.globalCompositeOperation });
    const page = S.emptyPage();
    page.strokes.push(sample("highlighter"), sample("pencil"), sample("ballpoint"));
    S.drawPage(outer.ctx, page, { background: false });
    const copies = outer.ops.filter(o => o.name === "drawImage");
    assert.equal(copies.length, 3);
    assert.deepEqual([copies[0].alpha, copies[0].op], [S.TOOLS.highlighter.alpha, "multiply"]);
    assert.deepEqual([copies[1].alpha, copies[1].op], [0.7, "source-over"]);
    assert.deepEqual([copies[2].alpha, copies[2].op], [1, "source-over"]);
    for (const copy of copies) {
      const [, x, y, w, h] = copy.args;
      assert.equal(copy.args.length, 9);
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && w < 600 && h < 400, `bounded copy ${copy.args}`);
    }
    // Every segment lands on the scratch layer, never straight on the page.
    assert.ok(!outer.ops.some(o => o.name === "stroke"));
    S.drawPage(outer.ctx, page, { background: false });
    assert.equal(made.length, 1);
  } finally {
    globalThis.OffscreenCanvas = prior;
  }
});
test("graphite grain is deterministic after serialization", () => {
  const page = S.emptyPage(); page.strokes.push(sample("pencil"));
  const a = context(), b = context();
  S.drawStroke(a.ctx, page.strokes[0], { mask: true }); S.drawStroke(b.ctx, S.deserialize(S.serialize(page)).strokes[0], { mask: true });
  assert.deepEqual(a.ops, b.ops);
});
test("new stroke settings are snapshots; legacy strokes keep their shape", () => {
  const settings = { angle: 0 };
  const stroke = S.newStroke("calligraphy", "#000", 5, settings);
  settings.angle = 90;
  assert.equal(stroke.style.angle, 0);
  const legacy = { v: 1, w: 1275, h: 1650, strokes: [S.newStroke("pen", "#000", 2)] };
  S.addPoint(legacy.strokes[0], 20, 40, 0, 0);
  assert.deepEqual(S.deserialize(S.serialize(legacy)), legacy);
  assert.equal(S.modernHighlight(S.newStroke("highlighter")), undefined);
});
test("paper metadata survives local data and portable archive without becoming ink", () => {
  const page = S.emptyPage(); page.paper = { type: "cornell", tint: "cream", spacing: 6, margin: false };
  page.strokes.push(sample("brush"));
  const record = { notebook: { id: "nb_abcdefghijkl", title: "Fixture" }, pages: [{ index: 0, data: S.serialize(page) }] };
  const archive = Archive.parse(Archive.serialize(Archive.build([record])));
  assert.deepEqual(S.deserialize(archive.notebooks[0].pages[0].data), page);
  assert.equal(S.isBlank({ ...page, strokes: [] }), true);
  assert.equal(S.pageBounds({ ...page, strokes: [] }), null);
});
test("all paper layouts render with finite geometry, distinct guides and tone", () => {
  const signatures = new Set();
  for (const preset of S.PAPERS) {
    const { ctx, ops } = context();
    S.drawPaper(ctx, { w: S.PAGE_W, h: S.PAGE_H, paper: { type: preset.id, tint: "cream", spacing: preset.spacing } }, { scale: 0.2 });
    assert.equal(ops.find(o => o.name === "fillRect").color, S.TINTS.cream);
    assert.ok(ops.every(o => o.args.every(n => typeof n !== "number" || Number.isFinite(n))));
    signatures.add(JSON.stringify(ops));
  }
  assert.equal(signatures.size, S.PAPERS.length);
  const { ctx, ops } = context();
  S.drawPage(ctx, { ...S.emptyPage(), paper: { type: "grid" } }, { background: false });
  assert.ok(!ops.some(o => o.name === "fillRect" || o.name === "lineTo"));
});
test("invalid paper settings normalize without breaking old notes", () => {
  assert.deepEqual(S.normalizePaper({ type: "unknown", tint: "__proto__", spacing: 999 }), { type: "blank", tint: "white", spacing: 12, margin: true });
  assert.equal(S.toolSpec("__proto__"), S.TOOLS.pen);
});


test("vault upload accepts every registered implement and rejects unknown tools/settings", () => {
  const validate = require("./routes/vault.js").validateNotebookInk;
  for (const tool of Object.keys(S.TOOLS)) {
    const page = S.emptyPage(); page.paper = S.normalizePaper({ type: "weekly", tint: "cream" });
    page.strokes.push(sample(tool));
    assert.doesNotThrow(() => validate(Buffer.from(S.serialize(page))), tool);
  }
  const page = S.emptyPage(); page.strokes.push(sample("eraser"));
  assert.throws(() => validate(Buffer.from(S.serialize(page))), /invalid stroke/);
  page.strokes[0].tool = "__proto__";
  assert.throws(() => validate(Buffer.from(S.serialize(page))), /invalid stroke/);
  page.strokes[0].tool = "fountain"; page.strokes[0].style.angle = -100;
  assert.throws(() => validate(Buffer.from(S.serialize(page))), /invalid nib/);
  page.strokes[0].style.angle = 45; page.paper = { type: "unknown", tint: "white", spacing: 5, margin: true };
  assert.throws(() => validate(Buffer.from(JSON.stringify(page))), /invalid paper/);
});
