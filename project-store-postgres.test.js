const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const { seedTaskLibrary } = require("./test-support/task-library-fixture");

// Task Library query from deployed 890f1c64, retained as the comparison control.
const LEGACY_TASK_QUERY = `SELECT * FROM blocks WHERE workspace_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL
       ORDER BY CASE WHEN COALESCE(properties->>'projectOrder','') ~ '^-?[0-9]+(?:[.][0-9]+)?$'
                     THEN (properties->>'projectOrder')::double precision ELSE sort_order END,
                created_at ASC`;

async function measureQuery(pool, sql, params) {
  const client = await pool.connect();
  let dataRowBytes = 0;
  // pg's DataRow length includes its length word. Add the one-byte message tag.
  const record = message => { dataRowBytes += 1 + message.length; };
  client.connection.on("dataRow", record);
  try {
    const { rows } = await client.query(sql, params);
    return { sql, params, rows, dataRowBytes, rowJsonBytes: Buffer.byteLength(JSON.stringify(rows)) };
  } finally {
    client.connection.off("dataRow", record);
    client.release();
  }
}

test("Task Library PostgreSQL response parity and transfer budget", {
  skip: !process.env.DCC_TEST_DATABASE_URL || !!process.env.DCC_PGLITE_MODULE,
}, async t => {
  const { pool, blockDB, close } = await createActivityDb();
  t.after(close);
  await seedTaskLibrary(pool);

  const { rows: parityRows } = await pool.query(
    "SELECT *, dcc_is_task_row(type, properties) AS sql_is_task FROM blocks"
  );
  for (const row of parityRows) {
    assert.equal(row.sql_is_task, blockDB.isTaskRow(blockDB.parseBlock(row)), row.id);
  }

  const captures = [];
  const app = express();
  for (const version of ["legacy", "filtered"]) {
    const router = express.Router();
    router.use((req, res, next) => {
      req.workspaceId = req.get("x-fixture-workspace") || null;
      next();
    });
    require("./routes/projects")(router, {
      blockDB,
      pool: {
        async query(sql, params) {
          if (!sql.includes("properties->>'projectOrder'")) return pool.query(sql, params);
          const measured = await (version === "legacy"
            ? measureQuery(pool, LEGACY_TASK_QUERY, params.slice(0, 1))
            : measureQuery(pool, sql, params));
          captures.push(measured);
          return measured;
        },
      },
    });
    app.use("/" + version, router);
  }
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise(resolve => server.once("listening", resolve));
  const fetchLibrary = async (version, workspace) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${version}/api/task-library`, {
      headers: workspace ? { "x-fixture-workspace": workspace } : {},
    });
    assert.equal(response.status, 200);
    return response.text();
  };

  const metrics = {};
  for (const workspace of ["ws-1", "ws-2", "ws-3", "missing-workspace", null]) {
    const legacy = await fetchLibrary("legacy", workspace);
    const filtered = await fetchLibrary("filtered", workspace);
    const key = workspace || "unscoped";
    const [before, after] = captures.splice(0);
    const payload = JSON.parse(legacy);
    const ids = payload.tasks.map(row => row.id);
    assert.equal(filtered, legacy, `full response for ${key}`);
    const candidateIds = new Set(after.rows.map(row => row.id));
    assert.ok(ids.every(id => candidateIds.has(id)), "SQL includes every legacy task");
    if (workspace !== "ws-1") {
      const expectedIds = {
        "ws-2": ["library-foreign"], "ws-3": ["library-third-workspace"], unscoped: ["library-unscoped"],
      };
      assert.deepEqual(ids, expectedIds[key] || []);
      continue;
    }

    assert.deepEqual(ids.slice(0, 5), [
      "library-blocker", "library-waiting", "library-completed", "library-invalid-order", "library-fallback",
    ]);
    for (const id of [
      "legacy-added_task", "legacy-schedule_item", "legacy-pending_task", "legacy-trivial_task",
      "legacy-action_item", "legacy-subtask", "library-shell", "props-json-string",
      "title-null", "title-empty", "title-false", "title-number", "title-true",
      "alias-stringZero", "alias-stringFalse", "alias-whitespace", "alias-number", "alias-true", "alias-array", "alias-object",
    ]) assert.ok(ids.includes(id), id);
    for (const id of [
      "title-whitespace", "title-missing", "text-whitespace", "title-array-empty", "props-json-null",
      "alias-null", "alias-false", "alias-zero", "alias-empty", "alias-missing", "library-deleted",
    ]) assert.ok(!ids.includes(id), id);
    assert.deepEqual(payload.projects.map(row => row.id), ["library-project"]);
    assert.deepEqual(payload.facets[0].properties.values.map(value => value.id), ["kitchen", "outside"]);
    assert.deepEqual(payload.views.map(row => row.id), ["library-view"]);
    assert.deepEqual(payload.dependencies.map(row => row.id).sort(), ["library-dependency", "library-done-dependency"]);
    assert.deepEqual(payload.readiness["library-waiting"], {
      state: "blocked", total: 2, satisfied: 1, blockers: [{ id: "library-blocker", title: "Buy baseboards" }],
    });
    assert.ok(payload.tasks.find(row => row.id === "library-someday").properties.someday);
    assert.ok(payload.tasks.find(row => row.id === "library-completed").properties.done);
    assert.equal(payload.tasks.find(row => row.id === "library-meeting").date, "2026-11-20");
    assert.equal(before.rows.length, 4249);

    const summarize = ({ rows, rowJsonBytes, dataRowBytes }) => ({ rows: rows.length, rowJsonBytes, dataRowBytes });
    for (const [label, capture] of [["legacy", before], ["filtered", after]]) {
      const { rows } = await pool.query("EXPLAIN (ANALYZE, BUFFERS) " + capture.sql, capture.params);
      metrics[label] = {
        ...summarize(capture),
        httpBytes: Buffer.byteLength(label === "legacy" ? legacy : filtered),
        plan: rows.map(row => row["QUERY PLAN"]),
      };
    }
    t.diagnostic(JSON.stringify(metrics, null, 2));

    // Optional review artifacts, generated from both real HTTP responses.
    const output = process.env.DCC_TASK_LIBRARY_EVIDENCE_DIR;
    if (output) {
      for (const [label, body] of [["legacy", legacy], ["filtered", filtered]]) {
        fs.writeFileSync(path.join(output, `${label}-response.json`), body);
      }
      fs.writeFileSync(path.join(output, "legacy-task-ids.json"), JSON.stringify(ids, null, 2));
      fs.writeFileSync(path.join(output, "metrics.json"), JSON.stringify(metrics, null, 2));
    }

    await t.test("reduces PostgreSQL DataRow bytes by at least 50%", () => {
      assert.ok(after.dataRowBytes <= before.dataRowBytes / 2,
        `Task query transferred ${after.dataRowBytes} bytes against the legacy ${before.dataRowBytes}`);
    });
    await t.test("discards seeded non-task artifacts inside PostgreSQL", () => {
      assert.ok(before.rows.some(row => row.id.startsWith("artifact-")));
      for (const row of after.rows) {
        assert.equal(row.id.startsWith("artifact-"), false, row.id);
        assert.ok(blockDB.isTaskRow(blockDB.parseBlock(row)), row.id);
        assert.equal(row.workspace_id, workspace, row.id);
        assert.equal(row.deleted_at, null, row.id);
      }
    });
  }
});
