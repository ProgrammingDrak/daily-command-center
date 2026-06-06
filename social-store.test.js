const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("./social-store");

const { resolveReviewState, scopeMatches, isoDate, isQueueableSpinWin, TERMINAL_QUEUE_STATES } = _test;

test("allowlisted sponsor auto-approves; everyone else is pending", () => {
  assert.equal(resolveReviewState(true), "auto_approved");
  assert.equal(resolveReviewState(false), "pending");
});

test("allowlist scope: 'both' matches task and slot; specific scope matches only itself", () => {
  assert.equal(scopeMatches("both", "task"), true);
  assert.equal(scopeMatches("both", "slot"), true);
  assert.equal(scopeMatches("task", "task"), true);
  assert.equal(scopeMatches("task", "slot"), false);
  assert.equal(scopeMatches("slot", "task"), false);
});

test("terminal queue states do not include the live states", () => {
  for (const s of ["redeemed", "completed", "dismissed", "expired"]) {
    assert.ok(TERMINAL_QUEUE_STATES.has(s), `${s} should be terminal`);
  }
  for (const s of ["queued", "claimed"]) {
    assert.ok(!TERMINAL_QUEUE_STATES.has(s), `${s} should not be terminal`);
  }
});

test("isoDate returns a YYYY-MM-DD string", () => {
  assert.match(isoDate(new Date("2026-06-04T12:34:56Z")), /^2026-06-04$/);
});

test("isQueueableSpinWin: only confirmed catalog-reward wins queue", () => {
  const win = { status: "confirmed", reward_id: 42, reward_snapshot: { kind: "free", title: "Dinner" } };
  assert.equal(isQueueableSpinWin(win), true);

  // No reward_id -> common point/pet/collectible/booster outcomes never queue.
  assert.equal(isQueueableSpinWin({ status: "confirmed", reward_id: null, reward_snapshot: { kind: "points" } }), false);
  assert.equal(isQueueableSpinWin({ status: "awarded", reward_id: null, reward_snapshot: { kind: "pet" } }), false);

  // Misses and bank builders are not rewards even if a reward_id is present.
  assert.equal(isQueueableSpinWin({ status: "confirmed", reward_id: 7, reward_snapshot: { kind: "miss" } }), false);
  assert.equal(isQueueableSpinWin({ status: "confirmed", reward_id: 7, reward_snapshot: { kind: "bank_builder" } }), false);
  assert.equal(isQueueableSpinWin({ status: "confirmed", reward_id: 7, reward_snapshot: { source_type: "slot_screen_bank_builder" } }), false);

  // Unconfirmed spins (pending / awaiting jackpot choice) do not queue yet.
  assert.equal(isQueueableSpinWin({ status: "pending", reward_id: 42, reward_snapshot: { kind: "free" } }), false);
  assert.equal(isQueueableSpinWin(null), false);
  assert.equal(isQueueableSpinWin({}), false);
});
