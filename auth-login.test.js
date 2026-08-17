const test = require("node:test");
const assert = require("node:assert/strict");

const poolPath = require.resolve("./pg-pool");
const authPath = require.resolve("./auth");
const originalPool = require.cache[poolPath];
const queries = [];

require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ id: 7, username: "drake", email: "drake@example.com" }] };
    },
  },
};
delete require.cache[authPath];
const auth = require("./auth");

test.after(() => {
  delete require.cache[authPath];
  if (originalPool) require.cache[poolPath] = originalPool;
  else delete require.cache[poolPath];
});

test("credential login lookup accepts a username or case-insensitive email", async () => {
  const user = await auth.findUserByLogin("  Drake@Example.com  ");

  assert.equal(user.id, 7);
  assert.deepEqual(queries[0].params, ["Drake@Example.com"]);
  assert.match(queries[0].sql, /username = \$1 OR lower\(email\) = lower\(\$1\)/);
  assert.match(queries[0].sql, /LIMIT 1/);
});
