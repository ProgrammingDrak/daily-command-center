const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("./social-store");

const { resolveReviewState, scopeMatches, isoDate, TERMINAL_QUEUE_STATES } = _test;

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
