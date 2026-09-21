"use strict";

// The live layer appends new segments instead of redrawing a stroke from point
// zero on every pointer sample. Redrawing from zero is O(n^2) over a stroke --
// 101,700 segment draws for a 900-point stroke -- and it gets slower the longer
// you write without lifting the pen.
//
// `from` is what makes appending possible, so its contract is pinned here: a
// resumed draw must emit exactly the tail of what a full draw emits, or the
// appended ink would not line up with the ink already on the canvas.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const S = require("./public/js/ink/strokes.js");
const CANVAS = fs.readFileSync(path.join(__dirname, "public/js/ink/canvas.js"), "utf8");

// Records the drawing calls a real 2D context would receive.
function recordingCtx() {
  const ops = [];
  const round = (n) => Math.round(n * 1000) / 1000;
  return {
    ops,
    canvas: { width: 1275, height: 1650 },
    save() {}, restore() {}, beginPath() { ops.push("begin"); },
    moveTo(x, y) { ops.push(`move ${round(x)},${round(y)}`); },
    lineTo(x, y) { ops.push(`line ${round(x)},${round(y)}`); },
    quadraticCurveTo(cx, cy, x, y) { ops.push(`quad ${round(cx)},${round(cy)} ${round(x)},${round(y)}`); },
    arc(x, y, r) { ops.push(`arc ${round(x)},${round(y)} ${round(r)}`); },
    stroke() { ops.push("stroke"); }, fill() { ops.push("fill"); },
    clearRect() {}, fillRect() {},
    set lineWidth(v) { ops.push(`width ${Math.round(v * 1000) / 1000}`); },
    get lineWidth() { return 1; },
    globalAlpha: 1, globalCompositeOperation: "source-over",
    strokeStyle: "", fillStyle: "", lineCap: "", lineJoin: "",
  };
}

function strokeOf(n) {
  const st = S.newStroke("pen", "#1b1b2f", 2.6);
  for (let i = 0; i < n; i++) S.addPoint(st, 100 + i * 5, 300 + Math.sin(i / 4) * 40, 0.4 + (i % 7) / 20, 0);
  return st;
}

function draw(stroke, opts) {
  const ctx = recordingCtx();
  S.drawStroke(ctx, stroke, opts);
  return ctx.ops;
}

test("a resumed draw emits exactly the tail of a full draw", () => {
  const st = strokeOf(40);
  const full = draw(st, { scale: 1 });
  for (const from of [2, 7, 20, 38]) {
    const tail = draw(st, { scale: 1, from });
    assert.ok(tail.length > 0, `from=${from} drew nothing`);
    assert.deepStrictEqual(
      full.slice(full.length - tail.length),
      tail,
      `from=${from} is not the tail of the full draw`,
    );
  }
});

test("each resumed segment starts where the previous one ended", () => {
  // The joining segment is redrawn deliberately: when a new point arrives the
  // old last segment stops short, at the point rather than the midpoint beyond
  // it. Resuming one segment back is what closes that gap.
  const st = strokeOf(30);
  const from = 12;
  const tail = draw(st, { scale: 1, from });
  const full = draw(st, { scale: 1 });
  const firstMove = tail.find((o) => o.startsWith("move "));
  assert.ok(full.includes(firstMove), "resumed draw starts at a point the full draw also visits");
});

test("from defaults to a full draw", () => {
  const st = strokeOf(25);
  assert.deepStrictEqual(draw(st, { scale: 1, from: 1 }), draw(st, { scale: 1 }));
  assert.deepStrictEqual(draw(st, { scale: 1, from: undefined }), draw(st, { scale: 1 }));
});

test("from is clamped rather than trusted", () => {
  const st = strokeOf(20);
  const full = draw(st, { scale: 1 });
  // Below the first segment, and past the end: both must stay in bounds and
  // emit something sane rather than reading off the end of the point array.
  assert.deepStrictEqual(draw(st, { scale: 1, from: 0 }), full);
  assert.deepStrictEqual(draw(st, { scale: 1, from: -5 }), full);
  const past = draw(st, { scale: 1, from: 999 });
  assert.ok(past.length > 0 && past.every((o) => !o.includes("NaN")), "out-of-range from produced garbage");
});

test("degenerate strokes still draw", () => {
  const one = S.newStroke("pen", "#000", 3);
  S.addPoint(one, 10, 10, 0.5, 0);
  assert.ok(draw(one, { scale: 1, from: 5 }).some((o) => o.startsWith("arc")), "a single point is a dot");

  const two = S.newStroke("pen", "#000", 3);
  S.addPoint(two, 10, 10, 0.5, 0);
  S.addPoint(two, 40, 40, 0.5, 0);
  assert.ok(draw(two, { scale: 1, from: 9 }).some((o) => o.startsWith("line")), "two points are a line");

  assert.deepStrictEqual(draw(S.newStroke("pen", "#000", 3), { scale: 1, from: 3 }), []);
});

test("the live layer appends, and only for opaque tools", () => {
  // The highlighter multiplies at 0.32 alpha, so re-touching its joining
  // segment would darken that one segment. It keeps the full redraw.
  assert.match(CANVAS, /spec\.alpha >= 1/);
  assert.match(CANVAS, /from: canAppend \? liveDrawn - 1 : 1/);
  assert.match(CANVAS, /if \(added\) redrawLive\(true\)/);
});

test("clearing the live layer and forgetting its contents happen together", () => {
  // A bare clear that left liveDrawn stale would append onto a canvas that no
  // longer holds the segments being joined to.
  assert.match(CANVAS, /function clearLive\(\) \{\s*\n\s*clear\(liveCtx, live\);\s*\n\s*liveDrawn = 0;/);
  const strayClears = CANVAS.split("\n").filter(
    (l) => l.includes("clear(liveCtx, live)") && !l.includes("function"),
  );
  assert.strictEqual(strayClears.length, 1, "every live clear must go through clearLive()");
});
