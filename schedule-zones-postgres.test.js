const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateWorkspace } = require("./scripts/migrate-schedule-zones");

test("PostgreSQL schedule migration preserves legacy data and isolates rollback", {
  skip: !process.env.DCC_TEST_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.DCC_TEST_DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const { Client } = require("pg");
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  t.after(() => client.end());
  await client.query(`CREATE TEMP TABLE blocks (
    id text PRIMARY KEY, workspace_id text, type text, date date, properties jsonb,
    deleted_at timestamptz, updated_at timestamptz
  )`);
  await client.query(`INSERT INTO blocks VALUES
    ('breakfast', 'a', 'block', '2026-11-08', '{"start":"18:30","duration":45,"notes":"Original"}', NULL, '2026-10-10T00:00:00Z'),
    ('ambiguous', 'a', 'block', '2026-11-01', '{"start":"01:30"}', NULL, '2026-10-10T00:00:00Z'),
    ('foreign', 'b', 'block', '2026-11-08', '{"start":"18:30"}', NULL, '2026-10-10T00:00:00Z')`);
  const read = async () => (await client.query("SELECT * FROM blocks ORDER BY id")).rows;
  const original = await read();
  const options = { workspace: "a", zone: "America/New_York", approved: ["breakfast", "ambiguous", "foreign"] };
  assert.equal((await migrateWorkspace(client, { ...options, mode: "audit" })).review[0].id, "ambiguous");
  assert.deepEqual(await read(), original);
  assert.equal((await migrateWorkspace(client, { ...options, mode: "apply" })).counts.added, 1);
  assert.equal((await migrateWorkspace(client, { ...options, mode: "apply" })).counts.fixed, 1);
  const applied = await read();
  assert.equal(applied[1].properties.scheduleInstant.startAt, "2026-11-08T23:30:00.000Z");
  assert.deepEqual(applied[1].updated_at, original[1].updated_at);
  assert.deepEqual(applied[2], original[2]);
  assert.equal((await migrateWorkspace(client, { ...options, mode: "rollback" })).counts.removed, 1);
  assert.deepEqual(await read(), original);
});
