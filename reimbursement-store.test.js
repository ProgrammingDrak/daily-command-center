const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { splitShares, totalsFor } = require("./reimbursement-store");

test("equal splits include the owner and preserve every cent", () => {
  const shares = splitShares({
    totalCents: 1001,
    splitMode: "equal",
    includeSelf: true,
    participants: [{ name: "A" }, { name: "B" }],
  });
  assert.deepEqual(shares.map((share) => share.shareCents), [334, 334, 333]);
  assert.equal(shares.reduce((sum, share) => sum + share.shareCents, 0), 1001);
});

test("equal splits can exclude the owner", () => {
  const shares = splitShares({
    totalCents: 999,
    splitMode: "equal",
    includeSelf: false,
    participants: [{ name: "A" }, { name: "B" }],
  });
  assert.deepEqual(shares.map((share) => share.shareCents), [500, 499]);
  assert.equal(shares.some((share) => share.isSelf), false);
});

test("percentage splits assign rounding residue without losing money", () => {
  const shares = splitShares({
    totalCents: 1000,
    splitMode: "percentage",
    includeSelf: true,
    selfValue: 33.33,
    participants: [
      { name: "A", value: 33.33 },
      { name: "B", value: 33.34 },
    ],
  });
  assert.deepEqual(shares.map((share) => share.sharePercentBp), [3333, 3333, 3334]);
  assert.deepEqual(shares.map((share) => share.shareCents), [333, 333, 334]);
});

test("exact amount splits must equal the total", () => {
  assert.throws(() => splitShares({
    totalCents: 1200,
    splitMode: "amount",
    includeSelf: false,
    participants: [{ name: "A", value: 700 }, { name: "B", value: 400 }],
  }), /add up to the expense total/);

  const shares = splitShares({
    totalCents: 1200,
    splitMode: "amount",
    includeSelf: false,
    participants: [{ name: "A", value: 700 }, { name: "B", value: 500 }],
  });
  assert.deepEqual(shares.map((share) => share.shareCents), [700, 500]);
});

test("duplicate participant emails are refused", () => {
  assert.throws(() => splitShares({
    totalCents: 1000,
    splitMode: "equal",
    includeSelf: false,
    participants: [
      { name: "A", email: "same@example.com" },
      { name: "B", email: "SAME@example.com" },
    ],
  }), /email must be unique/);
});

test("settlement totals support partial and complete repayments", () => {
  const reimbursement = { direction: "owed_to_me" };
  const participants = [
    { id: "self", name: "Me", is_self: true, share_cents: 500 },
    { id: "a", name: "A", is_self: false, share_cents: 750 },
    { id: "b", name: "B", is_self: false, share_cents: 250 },
  ];
  const partial = totalsFor(reimbursement, participants, [
    { id: "one", participant_id: "a", amount_cents: 300, method: "venmo" },
    { id: "two", participant_id: "b", amount_cents: 250, method: "cash" },
  ]);
  assert.equal(partial.dueCents, 1000);
  assert.equal(partial.paidCents, 550);
  assert.equal(partial.outstandingCents, 450);
  assert.equal(partial.status, "partial");
  assert.equal(partial.participants[1].payments[0].method, "venmo");

  const settled = totalsFor(reimbursement, participants, [
    { id: "one", participant_id: "a", amount_cents: 750, method: "zelle" },
    { id: "two", participant_id: "b", amount_cents: 250, method: "cash" },
  ]);
  assert.equal(settled.outstandingCents, 0);
  assert.equal(settled.status, "settled");
});

test("the Budget tab and public share surface are wired", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  const schema = fs.readFileSync("pg-schema.js", "utf8");
  assert.match(html, /id="budget-reimbursements-section-btn"/);
  assert.match(html, /public\/js\/reimbursements\.js/);
  assert.match(server, /app\.get\("\/reimburse\/:token"/);
  assert.match(server, /routes\/reimbursements/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reimbursements/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS reimbursement_payments/);
});
