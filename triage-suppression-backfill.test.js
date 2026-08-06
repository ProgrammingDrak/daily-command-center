const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const src = fs.readFileSync(require.resolve("./db.js"), "utf8");
const match = src.match(/async function backfillLegacyTriageSuppressions\(\) \{[\s\S]*?\n\}/);
assert.ok(match, "backfillLegacyTriageSuppressions moved; update the test slice");

test("legacy triage backfill covers Done and Delete overlays and is idempotent by construction", async () => {
  const queries = [];
  const context = {
    pool: {
      query: async (sql) => {
        queries.push(sql);
        return { rows: queries.length === 1 ? [{ id: "one" }, { id: "two" }] : [] };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(match[0], context);
  assert.equal(await context.backfillLegacyTriageSuppressions(), 2);
  assert.equal(await context.backfillLegacyTriageSuppressions(), 0);
  const sql = queries[0];
  assert.match(sql, /properties->'_dismissed'/);
  assert.match(sql, /properties->'_triageDeleted'/);
  assert.match(sql, /triage,deleted_items/);
  assert.match(sql, /triage,resolved_items/);
  assert.match(sql, /resolved_reason/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
});
