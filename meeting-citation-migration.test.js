const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Client } = require("pg");

const migration = fs.readFileSync(
  require.resolve("./migrations/005_meeting_citation_namespace.sql"),
  "utf8",
);

test("migration 005 rewrites legacy citations idempotently without touching task time", async (t) => {
  const databaseUrl = process.env.DCC_TEST_DATABASE_URL;
  if (!databaseUrl) {
    t.skip("DCC_TEST_DATABASE_URL not set");
    return;
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = pg_temp");
    await client.query(`
      CREATE TEMP TABLE blocks (
        id text PRIMARY KEY,
        properties jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      ) ON COMMIT DROP
    `);
    const fixtures = [
      ["legacy-proposal", {
        kind: "proposed_action_item", start: 91.5, quote: "  I'll send it.  ", status: "proposed",
      }],
      ["legacy-task", {
        kind: "task", start: "14:00", title: "Send it",
        meetingSource: { meetingBlockId: "meeting-1", start: 45, quote: "Task quote" },
      }],
      ["nested-wins", {
        kind: "proposed_action_item", start: 999, quote: "Stale legacy quote",
        citation: { startOffset: 22, quote: "Canonical quote" },
      }],
      ["nested-task-wins", {
        kind: "task", start: "15:00",
        meetingSource: {
          meetingBlockId: "meeting-2", start: 999, quote: "Stale task quote",
          citation: { startOffset: 33, quote: "Canonical task quote" },
        },
      }],
      ["unrelated", { kind: "task", start: "09:00", quote: "ordinary field" }],
    ];
    for (const [id, properties] of fixtures) {
      await client.query("INSERT INTO blocks (id, properties) VALUES ($1, $2::jsonb)", [id, JSON.stringify(properties)]);
    }

    await client.query(migration);
    const first = await client.query("SELECT id, properties FROM blocks ORDER BY id");
    const byId = new Map(first.rows.map((row) => [row.id, row.properties]));

    assert.deepEqual(byId.get("legacy-proposal").citation, {
      startOffset: 91.5, quote: "I'll send it.",
    });
    assert.equal(byId.get("legacy-proposal").start, undefined);
    assert.equal(byId.get("legacy-proposal").quote, undefined);

    assert.equal(byId.get("legacy-task").start, "14:00");
    assert.deepEqual(byId.get("legacy-task").meetingSource, {
      meetingBlockId: "meeting-1",
      citation: { startOffset: 45, quote: "Task quote" },
    });

    assert.deepEqual(byId.get("nested-wins").citation, {
      startOffset: 22, quote: "Canonical quote",
    });
    assert.equal(byId.get("nested-task-wins").start, "15:00");
    assert.deepEqual(byId.get("nested-task-wins").meetingSource, {
      meetingBlockId: "meeting-2",
      citation: { startOffset: 33, quote: "Canonical task quote" },
    });
    assert.deepEqual(byId.get("unrelated"), {
      kind: "task", start: "09:00", quote: "ordinary field",
    });

    const rerunNotices = [];
    const captureNotice = (notice) => rerunNotices.push(String(notice.message || ""));
    client.on("notice", captureNotice);
    await client.query(migration);
    client.removeListener("notice", captureNotice);
    assert.ok(rerunNotices.includes("citation.proposals_migrated=0"));
    assert.ok(rerunNotices.includes("citation.approved_tasks_migrated=0"));
    const second = await client.query("SELECT id, properties FROM blocks ORDER BY id");
    assert.deepEqual(second.rows, first.rows, "a rerun must not rewrite canonical rows");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
