"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Shapes = require("./public/js/ink/shapes");

test("arrows retain a full straight shaft and two backward-facing head legs in every drag direction", () => {
  for (const [x, y] of [[100, 0], [-100, 0], [0, 100], [0, -100], [100, 100], [-100, 100], [100, -100], [-100, -100], [1, 1]]) {
    const shape = Shapes.create("arrow", { x: 300, y: 300 }, { x: 300 + x, y: 300 + y });
    const { paths } = Shapes.geometry(shape);
    assert.equal(paths.length, 3);
    assert.deepEqual(paths[0], [[300, 300], [300 + x, 300 + y]]);
    const cross = [];
    for (const [wing, tip] of paths.slice(1)) {
      assert.deepEqual(tip, [300 + x, 300 + y]);
      const dx = wing[0] - tip[0], dy = wing[1] - tip[1];
      assert.ok(dx * x + dy * y < 0, "arrowhead points toward the tip");
      assert.ok(Math.hypot(dx, dy) <= Math.hypot(x, y) * 0.4 + 1e-8);
      cross.push(x * dy - y * dx);
    }
    assert.ok(cross[0] * cross[1] < 0, "head legs sit on opposite sides of the shaft");
  }
});

test("rectangles close at exact corners and ellipses use native geometry in all drag directions", () => {
  for (const end of [{ x: 20, y: 40 }, { x: 380, y: 40 }, { x: 20, y: 550 }, { x: 380, y: 550 }]) {
    const rect = Shapes.create("rectangle", { x: 200, y: 300 }, end);
    const [path] = Shapes.geometry(rect).paths;
    assert.equal(path.length, 5);
    assert.deepEqual(path[0], path[4]);
    for (let n = 1; n < path.length; n++) assert.ok(path[n][0] === path[n - 1][0] || path[n][1] === path[n - 1][1]);
    const ellipse = Shapes.geometry(Shapes.create("ellipse", { x: 200, y: 300 }, end)).ellipse;
    assert.equal(ellipse.rx, Math.abs(end.x - 200) / 2);
    assert.equal(ellipse.ry, Math.abs(end.y - 300) / 2);
  }
});

test("geometric rendering never invokes handwriting curve smoothing", () => {
  for (const type of Shapes.TYPES) {
    const calls = [];
    const context = Object.fromEntries(["save", "restore", "beginPath", "moveTo", "lineTo", "ellipse", "closePath", "stroke"].map(method => [method, (...args) => calls.push([method, ...args])]));
    assert.equal(Shapes.draw(context, Shapes.create(type, { x: 20, y: 30 }, { x: 180, y: 240 })), true);
    if (type === "ellipse") assert.equal(calls.filter(call => call[0] === "ellipse").length, 1);
    if (type === "arrow") { assert.equal(calls.filter(call => call[0] === "moveTo").length, 3); assert.equal(calls.filter(call => call[0] === "lineTo").length, 3); }
    if (type === "rectangle") assert.ok(calls.some(call => call[0] === "closePath"));
  }
});

test("saved, moved, and selected shapes retain their semantic geometry", () => {
  const arrow = Shapes.create("arrow", { x: 50, y: 60 }, { x: 250, y: 160 });
  const moved = Shapes.translate(JSON.parse(JSON.stringify(arrow)), 30, -10);
  assert.deepEqual(Shapes.geometry(moved).paths[0], [[80, 50], [280, 150]]);
  assert.equal(Shapes.hit(moved, 180, 100, 2), true);
  assert.equal(Shapes.hit(moved, 180, 300, 2), false);
  const box = Shapes.bounds(moved);
  assert.ok(box.x <= 80 && box.x + box.w >= 280);
});
