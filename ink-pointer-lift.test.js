"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const S = require("./public/js/ink/strokes.js");

// Execute the actual pointer handlers with synthetic events and recording canvas
// contexts. This measures synchronous drawing work, not physical Pencil latency.
function surface() {
  const events = {};
  const captured = new Set();
  const operations = [];
  function canvas(name) {
    const ctx = { globalAlpha: 1, globalCompositeOperation: "source-over" };
    for (const method of ["save", "restore", "setTransform", "clearRect", "fillRect",
      "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "arc", "stroke", "fill", "drawImage"]) {
      ctx[method] = (...args) => operations.push({ name, method, args });
    }
    return {
      style: {}, getContext: () => ctx,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: (type, handler) => { events[type] = handler; },
      setPointerCapture: (id) => captured.add(id),
      hasPointerCapture: (id) => captured.has(id),
      releasePointerCapture: (id) => captured.delete(id),
    };
  }
  const base = canvas("base");
  const live = canvas("live");
  const scope = { InkStrokes: S, document: { createElement: () => canvas("prefix") }, window: { devicePixelRatio: 2,
    addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout };
  scope.self = scope;
  vm.runInNewContext(fs.readFileSync(process.env.INK_CANVAS_SOURCE || require.resolve("./public/js/ink/canvas.js"), "utf8"), scope);
  let changes = 0;
  const ink = scope.InkCanvas.create({ base, live,
    wrap: { getBoundingClientRect: () => ({ width: 638, height: 825 }) },
    onChange: () => { changes++; } });
  ink.layout();
  function send(type, id = 1, x = 20, extra = {}) {
    events[type]({ pointerId: id, pointerType: "pen", clientX: x, clientY: 20,
      pressure: 0.5, button: 0, buttons: 1, preventDefault() {}, ...extra });
  }
  return { ink, send, operations, live, captured, changes: () => changes };
}

test("Pencil lift copies existing ink without replaying any pressure segments", () => {
  for (const points of [1, 2, 100, 10000]) {
    const h = surface();
    h.send("pointerdown");
    for (let i = 1; i < points; i++) h.send("pointermove", 1, 20 + i);
    h.operations.length = 0;
    h.send("pointerup");
    const copies = h.operations.filter((o) => o.method === "drawImage");
    assert.equal(copies.length, 1);
    assert.equal(copies[0].args[0], h.live);
    assert.equal(h.operations.filter((o) => ["stroke", "fill", "quadraticCurveTo"].includes(o.method)).length, 0);
    assert.equal(h.ink.getPage().strokes[0].pts.length, points * 3);
    assert.equal(h.ink.isPenDown(), false);
    assert.equal(h.changes(), 1);
    const copyIndex = h.operations.indexOf(copies[0]);
    assert.ok(h.operations.findIndex((o) => o.name === "live" && o.method === "clearRect") > copyIndex);
    assert.deepEqual(h.operations.find((o) => o.name === "base" && o.method === "setTransform").args, [1, 0, 0, 1, 0, 0]);
  }
});

test("100 immediate consecutive Pencil strokes survive capture release, undo and redo", () => {
  const h = surface();
  for (let i = 0; i < 100; i++) {
    h.send("pointerdown", i);
    h.send("pointermove", i, 40);
    h.send("pointerup", i);
    h.send("lostpointercapture", i);
  }
  assert.equal(h.ink.getPage().strokes.length, 100);
  assert.equal(h.changes(), 100);
  h.ink.undo();
  assert.equal(h.ink.getPage().strokes.length, 99);
  h.ink.redo();
  assert.equal(h.ink.getPage().strokes.length, 100);
});

test("capture keeps an outside stroke alive; unexpected loss accepts the next stroke", () => {
  const h = surface();
  h.send("pointerdown");
  h.send("pointerleave");
  assert.equal(h.ink.isPenDown(), true);
  h.send("pointermove", 1, 50);
  h.captured.delete(1);
  h.send("lostpointercapture");
  h.send("pointerdown", 2);
  h.send("pointerup", 2);
  assert.equal(h.ink.getPage().strokes.length, 2);
});

test("cancellation discards only the live stroke and palm input cannot claim the pen", () => {
  const h = surface();
  h.send("pointerdown");
  h.send("pointercancel");
  h.send("lostpointercapture");
  h.send("pointerdown", 2, 20, { pointerType: "touch" });
  assert.equal(h.ink.isPenDown(), false);
  h.send("pointerdown", 3);
  h.send("pointerup", 3);
  assert.equal(h.ink.getPage().strokes.length, 1);
});

test("resize restores live ink before a bitmap commit", () => {
  const h = surface();
  h.send("pointerdown");
  h.send("pointermove", 1, 50);
  h.operations.length = 0;
  h.ink.layout();
  assert.ok(h.operations.some((o) => o.name === "live" && o.method === "stroke"));
  h.send("pointerup");
  assert.equal(h.ink.getPage().strokes.length, 1);
});

test("highlighter retains per-segment multiply rendering", () => {
  const h = surface();
  h.ink.setTool("highlighter");
  h.send("pointerdown");
  h.send("pointermove", 1, 50);
  h.operations.length = 0;
  h.send("pointerup");
  assert.ok(h.operations.some((o) => o.name === "base" && o.method === "stroke"));
  assert.equal(h.operations.filter((o) => o.method === "drawImage").length, 0);
});
