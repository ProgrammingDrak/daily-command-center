// Contract tests for petLevel (pet-home-store.js): lifetime treats -> level.
//
// Why this is derived rather than stored, and why that is the thing to pin:
// decor_currency is a SPENDABLE balance that decreases when decor is unlocked, so
// a level built on it would drop when the user bought a lamp. The level reads
// from the append-only pet_home_events ledger instead, which only grows. This
// file pins the curve so a later tweak to PET_LEVEL_STEP cannot silently demote
// every existing pet.
const test = require("node:test");
const assert = require("node:assert/strict");
const { petLevel } = require("./pet-home-store.js");

test("a brand new pet is level 1, not level 0", () => {
  const zero = petLevel(0);
  assert.equal(zero.level, 1);
  assert.equal(zero.lifetimeTreats, 0);
  assert.equal(zero.progress, 0);
});

test("the curve is monotonic: more treats never means a lower level", () => {
  // The invariant that matters most. A pet that goes DOWN a level after doing
  // more work is the bug this whole derived-not-stored design exists to prevent.
  let previous = 0;
  for (let treats = 0; treats <= 12000; treats += 7) {
    const { level } = petLevel(treats);
    assert.ok(level >= previous, "level dropped at " + treats + " treats");
    previous = level;
  }
});

test("level thresholds are where the quadratic says they are", () => {
  // Level N starts at 25 * (N-1)^2: 0, 25, 100, 225, 400 ...
  assert.equal(petLevel(24).level, 1);
  assert.equal(petLevel(25).level, 2);
  assert.equal(petLevel(99).level, 2);
  assert.equal(petLevel(100).level, 3);
  assert.equal(petLevel(224).level, 3);
  assert.equal(petLevel(225).level, 4);
});

test("progress runs 0 to 1 inside a level and never escapes it", () => {
  for (const treats of [0, 24, 25, 60, 99, 100, 226, 999, 5000]) {
    const p = petLevel(treats).progress;
    assert.ok(p >= 0 && p <= 1, "progress out of range at " + treats + ": " + p);
  }
  // Just into a level is near-empty; just before the next is near-full.
  assert.ok(petLevel(25).progress < 0.05);
  assert.ok(petLevel(99).progress > 0.9);
});

test("needForNext counts down to exactly the next threshold", () => {
  assert.equal(petLevel(0).needForNext, 25);
  assert.equal(petLevel(24).needForNext, 1);
  assert.equal(petLevel(25).needForNext, 75);   // 100 - 25
  assert.equal(petLevel(99).needForNext, 1);
});

test("the level caps, and a capped pet reads as finished rather than stuck at zero", () => {
  const huge = petLevel(10_000_000);
  assert.equal(huge.level, huge.maxLevel);
  assert.equal(huge.atMax, true);
  assert.equal(huge.needForNext, 0);
  // 1, not 0: a full bar must read as "done", not as "no progress made".
  assert.equal(huge.progress, 1);
});

test("junk input degrades to a level 1 pet instead of NaN", () => {
  // lifetimeTreats comes from a SUM over jsonb, which is null on an empty ledger.
  for (const bad of [null, undefined, NaN, "", "abc", -50, {}]) {
    const out = petLevel(bad);
    assert.equal(out.level, 1, "bad input " + String(bad));
    assert.equal(out.lifetimeTreats, 0);
    assert.ok(Number.isFinite(out.progress));
  }
});

test("fractional treats do not create half levels", () => {
  assert.equal(petLevel(99.9).level, 2);
  assert.equal(petLevel(100.1).level, 3);
});
