const test = require("node:test");
const assert = require("node:assert/strict");

function loadStore() {
  const poolPath = require.resolve("./pg-pool");
  const budgetPath = require.resolve("./budget-store");
  const vaultPath = require.resolve("./reward-vault-store");
  delete require.cache[poolPath];
  delete require.cache[budgetPath];
  delete require.cache[vaultPath];
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) },
  };
  return require("./reward-vault-store");
}

test("normalizeVaultInput reserves the maximum and preserves the range", () => {
  const store = loadStore();
  const item = store.normalizeVaultInput({
    title: "Dinner with Fae",
    minCents: 7500,
    maxCents: 10000,
    reuseMode: "reusable",
    quickAdd: true,
    randomDraw: true,
  });
  assert.equal(item.vault_min_cents, 7500);
  assert.equal(item.value_cents, 10000);
  assert.equal(item.vault_reuse_mode, "reusable");
  assert.equal(item.vault_quick_add, true);
});

test("normalizeVaultInput supports private free self-care rewards", () => {
  const store = loadStore();
  const item = store.normalizeVaultInput({
    title: "Phone-free bath",
    minCents: 0,
    maxCents: 0,
    private: true,
    milestoneEligible: true,
  });
  assert.equal(item.payment_source, "free");
  assert.equal(item.sponsor_visible, false);
  assert.equal(item.vault_milestone, true);
});

test("normalizeVaultInput rejects an inverted price range", () => {
  const store = loadStore();
  assert.throws(
    () => store.normalizeVaultInput({ title: "Impossible range", minCents: 10000, maxCents: 7500 }),
    /Minimum price cannot exceed maximum price/
  );
});

test("weightedChoice honors chance shares and returns null for an empty pool", () => {
  const store = loadStore();
  const rows = [{ id: 1, chance_shares: 1 }, { id: 2, chance_shares: 3 }];
  assert.equal(store.weightedChoice(rows, () => 0).id, 1);
  assert.equal(store.weightedChoice(rows, () => 0.26).id, 2);
  assert.equal(store.weightedChoice([], () => 0), null);
});
