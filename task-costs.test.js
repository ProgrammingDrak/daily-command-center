const test = require("node:test");
const assert = require("node:assert/strict");
const costs = require("./public/js/task-costs");
const { fromBlock } = require("./public/js/task-model");
const { taskBlockProps } = require("./public/js/task-serialize");

const meal = {
  id: "meal", merchant: "Kanazawa Market", currency: "JPY", amountMinor: 4800,
  splits: [
    { name: "Dinner", category: "Food", amountMinor: 3600 },
    { name: "Trinket", category: "Souvenirs", amountMinor: 1200 }
  ],
  receiptUrl: "https://example.com/receipt"
};
const gas = { id: "gas", merchant: "Fuel station", currency: "USD", amountMinor: 1250, category: "Gas" };

test("transactions survive task projection and serialization, and count split spending once", () => {
  const taskCosts = costs.validate([meal, gas]);
  const projected = fromBlock({ id: "task", properties: { title: "Dinner", taskCosts } });
  assert.deepEqual(taskBlockProps(projected).taskCosts, taskCosts);
  assert.match(costs.summary(taskCosts), /JPY\s+4,800.+\+.+USD\s+12.50/);
  assert.equal(taskBlockProps(fromBlock({ id: "old", properties: {} })).taskCosts, undefined);
});

test("reads previously saved costs as editable transactions", () => {
  const entries = costs.transactions({
    task: { currency: "JPY", items: [{ name: "Dinner", amountMinor: 3600 }] },
    commute: { currency: "USD", receiptUrl: "https://example.com/ticket" }
  });
  assert.equal(entries[0].amountMinor, 3600);
  assert.equal(entries[0].splits[0].name, "Dinner");
  assert.equal(entries[1].category, "Transit");
  assert.equal(entries[1].amountMinor, undefined);
  assert.deepEqual(costs.validate(entries), entries);
});

test("validates splits, duplicate identities, unsafe links and dates", () => {
  assert.throws(() => costs.validate([{ ...meal, amountMinor: 4801 }]), /add up/);
  assert.throws(() => costs.validate([gas, gas]), /unique ID/);
  assert.throws(() => costs.validate([{ ...gas, receiptUrl: "javascript:alert(1)" }]), /HTTP/);
  assert.throws(() => costs.validate([{ ...gas, date: "2026-02-30" }]), /date/);
});

test("amounts use exact currency minor units and retain zero", () => {
  assert.equal(costs.parseAmount("12,50", "USD"), 1250);
  assert.equal(costs.parseAmount("1.234", "KWD"), 1234);
  assert.equal(costs.validate([{ ...gas, amountMinor: 0 }])[0].amountMinor, 0);
  assert.throws(() => costs.parseAmount("1.25", "JPY"));
  assert.throws(() => costs.parseAmount("-2", "USD"));
});
