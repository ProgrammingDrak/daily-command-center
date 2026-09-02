"use strict";

// The stroke format is the durable artifact: it is what sits in the vault after
// the app is gone. These tests pin its shape, its tolerance for junk, and the
// geometry the eraser and the OCR coverage check depend on.

const test = require("node:test");
const assert = require("node:assert");

const S = require("./public/js/ink/strokes.js");

function stroke(points, over = {}) {
  const s = S.newStroke(over.tool, over.color, over.size);
  for (const [x, y, p] of points) S.addPoint(s, x, y, p, 0);
  return s;
}

// ── format ────────────────────────────────────────────────────────────────────

test("a page serializes to readable JSON and round trips", () => {
  const page = S.emptyPage();
  page.strokes.push(stroke([[10, 10, 0.5], [20, 20, 0.7]]));

  const text = S.serialize(page);
  assert.match(text, /"v":1/);
  const back = S.deserialize(text);
  assert.strictEqual(back.w, page.w);
  assert.strictEqual(back.strokes.length, 1);
  assert.deepStrictEqual(back.strokes[0].pts, page.strokes[0].pts);
});

test("points are stored flat, which is why the format stays small", () => {
  const s = stroke([[1, 2, 0.5], [3, 4, 0.6]]);
  assert.strictEqual(s.pts.length, 6);
  assert.deepStrictEqual(s.pts, [1, 2, 0.5, 3, 4, 0.6]);
  assert.strictEqual(S.pointCount(s), 2);
  assert.deepStrictEqual(S.pointAt(s, 1), { x: 3, y: 4, p: 0.6 });
});

test("coordinates are rounded, not stored at full float precision", () => {
  const s = stroke([[1.23456, 2.98765, 0.123456]]);
  assert.deepStrictEqual(s.pts, [1.23, 2.99, 0.12]);
});

test("a corrupt page opens blank instead of throwing", () => {
  // A bad local record must never make the notebook unopenable.
  for (const junk of ["", "{", "null", "[]", '{"strokes":"nope"}', undefined]) {
    const page = S.deserialize(junk);
    assert.strictEqual(page.strokes.length, 0, `junk: ${junk}`);
    assert.strictEqual(page.v, S.FORMAT_VERSION);
  }
});

test("malformed strokes are dropped, valid siblings survive", () => {
  const page = S.deserialize(JSON.stringify({
    v: 1, w: 100, h: 100,
    strokes: [
      { pts: [1, 2, 0.5] },                // valid
      { pts: [1, 2] },                     // not a multiple of 3
      { pts: [1, 2, NaN] },                // not finite
      null,
      { pts: [3, 4, 0.5, 5, 6, 0.5] },     // valid
    ],
  }));
  assert.strictEqual(page.strokes.length, 2);
});

// ── pressure ──────────────────────────────────────────────────────────────────

test("a mouse or finger reporting zero pressure still draws", () => {
  // Treating a real 0 as "no pressure" would make mouse and finger ink vanish.
  assert.strictEqual(S.normalizePressure(0), 0.5);
  assert.strictEqual(S.normalizePressure(undefined), 0.5);
  assert.strictEqual(S.normalizePressure(-1), 0.5);
  assert.strictEqual(S.normalizePressure(2), 1);
  assert.strictEqual(S.normalizePressure(0.4), 0.4);
});

test("pen width follows pressure, highlighter ignores it", () => {
  const pen = S.newStroke("pen", "#000", 10);
  const light = S.widthAt(pen, 0.01);
  const heavy = S.widthAt(pen, 1);
  assert.ok(light < heavy, "a pen must taper");
  assert.strictEqual(heavy, 10);
  assert.ok(light >= 3.4 && light <= 3.6, `expected ~3.5, got ${light}`);

  const hl = S.newStroke("highlighter", "#ff0", 20);
  assert.strictEqual(S.widthAt(hl, 0.1), 20);
  assert.strictEqual(S.widthAt(hl, 1), 20);
});

// ── sampling ──────────────────────────────────────────────────────────────────

test("points landing on top of each other are discarded", () => {
  // Pointer events fire far faster than a hand moves.
  const s = S.newStroke();
  assert.strictEqual(S.addPoint(s, 10, 10, 0.5), true);
  assert.strictEqual(S.addPoint(s, 10.1, 10.1, 0.5), false, "sub-threshold move is noise");
  assert.strictEqual(S.addPoint(s, 14, 14, 0.5), true);
  assert.strictEqual(S.pointCount(s), 2);
});

// ── erasing ───────────────────────────────────────────────────────────────────

test("the eraser removes whole strokes it touches and leaves the rest", () => {
  const a = stroke([[0, 0, 0.5], [100, 0, 0.5]]);
  const b = stroke([[0, 500, 0.5], [100, 500, 0.5]]);
  const out = S.eraseAt([a, b], 50, 2, 6);
  assert.strictEqual(out.strokes.length, 1);
  assert.strictEqual(out.strokes[0], b, "the far stroke survives");
  assert.strictEqual(out.removed.length, 1);
  assert.strictEqual(out.removed[0].index, 0, "removed carries its index so undo can restore it");
});

test("erasing near but not on a stroke does nothing", () => {
  const a = stroke([[0, 0, 0.5], [100, 0, 0.5]], { size: 2 });
  assert.strictEqual(S.eraseAt([a], 50, 60, 5).strokes.length, 1);
});

test("a fat stroke is easier to hit, matching how it looks", () => {
  const thin = stroke([[0, 0, 0.5], [100, 0, 0.5]], { size: 2 });
  const fat = stroke([[0, 0, 0.5], [100, 0, 0.5]], { size: 40 });
  assert.strictEqual(S.strokeHit(thin, 50, 15, 2), false);
  assert.strictEqual(S.strokeHit(fat, 50, 15, 2), true);
});

test("a single-point dot can be erased", () => {
  const dot = stroke([[50, 50, 0.5]]);
  assert.strictEqual(S.strokeHit(dot, 51, 51, 4), true);
  assert.strictEqual(S.strokeHit(dot, 300, 300, 4), false);
});

test("point-to-segment distance clamps to the endpoints", () => {
  // Past the end of a segment the nearest point is the endpoint, not the
  // infinite line, or erasing would trigger far off the end of a stroke.
  assert.strictEqual(S.distanceToSegment(50, 10, 0, 0, 100, 0), 10);
  assert.strictEqual(S.distanceToSegment(-30, 0, 0, 0, 100, 0), 30);
  assert.strictEqual(S.distanceToSegment(130, 0, 0, 0, 100, 0), 30);
});

// ── bounds ────────────────────────────────────────────────────────────────────

test("bounds include stroke width, and a blank page has none", () => {
  const page = S.emptyPage();
  assert.strictEqual(S.pageBounds(page), null);
  assert.strictEqual(S.isBlank(page), true);

  page.strokes.push(stroke([[100, 100, 0.5], [200, 150, 0.5]], { size: 10 }));
  const b = S.pageBounds(page);
  assert.strictEqual(S.isBlank(page), false);
  assert.strictEqual(b.x, 95);
  assert.strictEqual(b.y, 95);
  assert.strictEqual(b.w, 110);
});

// ── drawing, against a recording stub ─────────────────────────────────────────

function recorder() {
  const calls = [];
  const ctx = { lineWidth: 0, globalAlpha: 1, globalCompositeOperation: "", strokeStyle: "", fillStyle: "", lineCap: "", lineJoin: "" };
  for (const m of ["save", "restore", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "stroke", "fill", "arc", "fillRect"]) {
    ctx[m] = (...args) => calls.push({ m, args, lineWidth: ctx.lineWidth });
  }
  return { ctx, calls };
}

test("a single tap draws a dot, so the dot on an i survives", () => {
  const { ctx, calls } = recorder();
  S.drawStroke(ctx, stroke([[10, 10, 0.5]]));
  assert.ok(calls.some((c) => c.m === "arc"), "expected a filled dot");
  assert.ok(calls.some((c) => c.m === "fill"));
});

test("a long stroke is drawn as separate segments so width can vary", () => {
  const { ctx, calls } = recorder();
  S.drawStroke(ctx, stroke([[0, 0, 0.1], [10, 10, 0.5], [20, 0, 1], [30, 10, 1]], { size: 10 }));
  const curves = calls.filter((c) => c.m === "quadraticCurveTo");
  const strokes = calls.filter((c) => c.m === "stroke");
  assert.ok(curves.length >= 2, "smoothed with quadratic curves");
  assert.ok(strokes.length >= 2, "stroked per segment, not once");
  const widths = new Set(strokes.map((c) => c.lineWidth));
  assert.ok(widths.size > 1, "line width must vary with pressure, or the ink looks dead");
});

test("scale multiplies geometry, so one page renders the same at any size", () => {
  const { ctx, calls } = recorder();
  S.drawStroke(ctx, stroke([[10, 20, 1], [30, 40, 1]], { size: 4 }), { scale: 2 });
  const move = calls.find((c) => c.m === "moveTo");
  assert.deepStrictEqual(move.args, [20, 40]);
  assert.strictEqual(calls.find((c) => c.m === "stroke").lineWidth, 8);
});

test("drawPage paints a white background by default and can skip it", () => {
  const withBg = recorder();
  S.drawPage(withBg.ctx, S.emptyPage());
  assert.ok(withBg.calls.some((c) => c.m === "fillRect"));

  const noBg = recorder();
  S.drawPage(noBg.ctx, S.emptyPage(), { background: false });
  assert.ok(!noBg.calls.some((c) => c.m === "fillRect"));
});
