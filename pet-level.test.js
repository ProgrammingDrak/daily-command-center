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

test("every level boundary is exactly 25 * (N-1)^2, and progress resets there", () => {
  // Replaces a sweep that stepped by 7 and therefore visited only 3 of the 20
  // thresholds, and whose `level >= previous` assertion could only fire on a
  // DECREASE -- impossible for a floor(sqrt()) curve, so it killed no mutation
  // the threshold test did not already kill. Walking the exact boundaries is
  // cheaper and actually load-bearing, and it pins the progress reset too.
  let previous = 0;
  for (let n = 2; n <= 20; n++) {
    const at = 25 * Math.pow(n - 1, 2);
    assert.equal(petLevel(at - 1).level, n - 1, `one treat short of level ${n} (${at})`);
    assert.equal(petLevel(at).level, n, `level ${n} starts at ${at}`);
    assert.equal(petLevel(at).progress, n === 20 ? 1 : 0, `progress resets entering level ${n}`);
    assert.ok(petLevel(at).level >= previous, "level dropped at " + at);
    previous = petLevel(at).level;
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

test("the cap is level 20 at exactly 9025 treats", () => {
  // The LITERAL, not the object's own maxLevel field. The first version asserted
  // `huge.level === huge.maxLevel`, which compares two fields of the same
  // returned object and therefore holds for any cap: dropping PET_MAX_LEVEL from
  // 20 to 4 (demoting every pet at level 5 and above) left the whole suite green.
  assert.equal(petLevel(0).maxLevel, 20);
  assert.equal(petLevel(9024).level, 19, "one treat short of the cap");
  assert.equal(petLevel(9024).atMax, false);
  assert.equal(petLevel(9025).level, 20, "25 * 19^2");
  assert.equal(petLevel(9025).atMax, true);
  assert.equal(petLevel(9025).needForNext, 0);
  // 1, not 0: a full bar must read as "done", not as "no progress made".
  assert.equal(petLevel(9025).progress, 1);
  // Past the cap it stays pinned rather than computing a level 633.
  assert.equal(petLevel(10_000_000).level, 20);
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
