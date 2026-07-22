// Contract tests for _radialFitRadius() in public/js/radial-menu.js — the
// radius-growth that fans a tight arc onto a bigger circle so neighbouring
// icons don't overlap. Harness pattern: recalc-times.test.js (raw source in a
// node:vm context with a stubbed window; the helper is a top-level function
// decl, so it lands on the context directly, no export plumbing needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/radial-menu.js"), "utf8");

function load(vw, vh) {
  // window is only needed so the file's window.* export assignments don't throw
  // at load; innerWidth/innerHeight are read by _radialFitRadius when called.
  const context = { window: { innerWidth: vw, innerHeight: vh } };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context._radialFitRadius;
}

// center-to-center chord between adjacent items on radius R across (a1-a0) deg
function chord(R, n, a0, a1) {
  const step = (Math.abs(a1 - a0) * Math.PI) / 180 / (n - 1);
  return 2 * R * Math.sin(step / 2);
}

test("grows a tight arc so adjacent icons clear the min chord", () => {
  const fit = load(1280, 800);
  // the launcher FAB: 8 items across an 83deg arc, base 104 -> ~21px steps
  const R = fit(104, 8, 185, 268, 58);
  assert.ok(R > 104, "radius must grow past the base for a crowded tight arc");
  assert.ok(chord(R, 8, 185, 268) >= 58 - 1e-6, "adjacent chord must reach the min");
});

test("never returns below the caller's base radius", () => {
  const fit = load(1280, 800);
  // task radial: 4 items across a roomy 180deg arc, base 140 already clears 58
  const R = fit(140, 4, 90, 270, 58);
  assert.equal(R, 140, "a roomy arc keeps the caller's r as the floor");
});

test("caps the radius at maxFrac of the smaller viewport side", () => {
  const fit = load(400, 600); // phone-ish; smaller side is 400
  const R = fit(104, 8, 185, 268, 58);
  assert.equal(R, 0.42 * 400, "must clamp to maxFrac * min(vw,vh)");
});

test("n<=1 returns the base radius (no divide-by-zero)", () => {
  const fit = load(1280, 800);
  assert.equal(fit(104, 1, 185, 268, 58), 104);
  assert.equal(fit(104, 0, 185, 268, 58), 104);
});

test("a zero-width arc collapses to the finite cap, not Infinity", () => {
  const fit = load(1280, 800);
  const R = fit(104, 8, 200, 200, 58); // a0===a1 -> sin(0)=0 -> Infinity, then capped
  assert.ok(Number.isFinite(R), "must stay finite when a0===a1");
  assert.equal(R, 0.42 * Math.min(1280, 800));
});
