"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { createActivityDb } = require("./activity-db");
const candidateMount = require("../routes/slack-events");
const metrics = require("../lib/slack-sweep-metrics");

const baseCommit = "890f1c64c594cfb2b34aeeca9c5ae1ff09690b0c";
const fixtureDate = "2026-11-14";
const testEnv = {
  SLACK_SIGNING_SECRET: "synthetic", SLACK_USER_TOKEN: "xoxp-fixture", SLACK_BOT_TOKEN: "xoxb-fixture",
  SLACK_TOKEN_ENC_KEY: "", SLACK_TEAM_ALLOWLIST: "", DRAKE_SLACK_USER_ID: "U_FIXTURE",
  DCC_SERVICE_USER_ID: "1", DCC_SERVICE_WORKSPACE_ID: "ws-1",
  SLACK_DELEGATE_IMPORT_AFTER: "2026-01-01", SLACK_RECONCILE_ENABLED: "0", SLACK_RECONCILE_METRICS: "1",
};

function diagnosticMount() {
  const filename = path.join(__dirname, "../routes/slack-events.js");
  let source = execFileSync("git", ["show", `${baseCommit}:routes/slack-events.js`], {
    cwd: __dirname, encoding: "utf8",
  });
  // Run the diagnostic route with the same measurement scopes as the candidate.
  source = source.replace(
    'const createTaskTiming =', 'const metrics = require("../lib/slack-sweep-metrics");\nconst createTaskTiming ='
  ).replace(
    'const SIGNING_SECRET', 'metrics.instrumentPool(pool);\n  const SIGNING_SECRET'
  ).replace(
    'async function runReconciliation() {',
    'async function runReconciliation() { return metrics.withSweepMetrics(reconcile); }\n  async function reconcile() {'
  ).replace(
    'for (const match of bookmarks) await bound.reconcileMatch("bookmark", match);',
    'metrics.count("keys", bookmarks.length);\n            for (const match of bookmarks) await metrics.phase("lookup", () => bound.reconcileMatch("bookmark", match));'
  ).replace(
    'for (const match of delegates) await bound.reconcileMatch("delegate", match);',
    'metrics.count("keys", delegates.length);\n            for (const match of delegates) await metrics.phase("lookup", () => bound.reconcileMatch("delegate", match));'
  ).replace(
    'stats.mirrored += await bound.mirrorDccCompletions()',
    'stats.mirrored += await metrics.phase("mirror", bound.mirrorDccCompletions)'
  ).replace(
    'async function linkedWaitingForMessage(channel, ts, includeDeleted = false) {',
    'async function linkedWaitingForMessage(channel, ts, includeDeleted = false) { return metrics.phase("waiting", () => readLinkedWaiting(channel, ts, includeDeleted)); }\n    async function readLinkedWaiting(channel, ts, includeDeleted) {'
  ).replace(
    'async function projectTaskToSlack(block) {',
    'async function projectTaskToSlack(block) {\n      metrics.count("projections");'
  ).replace(
    'const response = await fetch(url, {',
    'if (method.startsWith("reactions.") && options.post) metrics.count("slackWrites");\n      const response = await fetch(url, {'
  );
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(source, filename);
  return mod.exports;
}

function stamp(index) {
  return `${1770000000 + index}.000001`;
}

function match(index, channel = "C1") {
  return { channel: { id: channel }, ts: stamp(index), text: "Synthetic Slack message" };
}

async function fixture(t, { baseline = false } = {}) {
  const previousEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, testEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // These modules bind the fixture pool when loaded.
  const boundModules = ["../db", "../pg-schema", "../slot-store"].map(name => require.resolve(name));
  const previousModules = boundModules.map(filename => require.cache[filename]);
  for (const filename of boundModules) delete require.cache[filename];
  t.after(() => {
    for (const [index, filename] of boundModules.entries()) {
      if (previousModules[index]) require.cache[filename] = previousModules[index];
      else delete require.cache[filename];
    }
  });
  const db = await createActivityDb();
  t.after(() => db.close());
  if (!baseline) await db.pool.query(fs.readFileSync(
    path.join(__dirname, "../migrations/011_slack_projection_receipts.sql"), "utf8"
  ));
  const writes = [];
  const searches = [];
  const mock = { results: () => [], write: () => null };
  const previousFetch = global.fetch;
  t.after(() => { global.fetch = previousFetch; });
  global.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://slack.com", "no non-mock HTTP");
    const method = url.pathname.split("/").pop();
    const auth = init.headers.Authorization;
    if (method === "search.messages") {
      const query = url.searchParams.get("query");
      const page = Number(url.searchParams.get("page"));
      searches.push({ query, page, auth });
      const result = await mock.results(query, page, auth);
      const matches = Array.isArray(result) ? result : result.matches;
      return response({ ok: true, messages: { matches, paging: { pages: result.pages || 1 } } });
    }
    if (method === "reactions.add" || method === "reactions.remove") {
      const fields = Object.fromEntries(new URLSearchParams(init.body));
      const call = { method, auth, ...fields };
      writes.push(call);
      return await mock.write(call) || response({ ok: true });
    }
    throw new Error(`Unexpected mock method ${method}`);
  };

  const mount = baseline ? diagnosticMount() : candidateMount;
  const app = { post() {} };
  const ctx = {
    ...db, broadcast() {}, APP_TIME_ZONE: "UTC", getTodayStr: () => fixtureDate,
    slotStore: require("../slot-store"),
  };
  const restart = () => mount(app, { ...ctx });
  const api = restart();
  await api.actors.ensureTable();
  await db.pool.query(`
    INSERT INTO slack_identities (slack_user_id, slack_team_id, user_id, workspace_id, linked_via)
    VALUES ('U_SECOND', 'T_SECOND', 2, 'ws-2', 'email')
  `);
  return { ...db, api, restart, mock, writes, searches };
}

function response(data, status = 200, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function properties(index, extra = {}) {
  const ts = stamp(index);
  return {
    kind: "task", source: "slack-bookmark", idempotency_key: `slack-bookmark:C1:${ts}`,
    slack_channel: "C1", slack_ts: ts, capture_status: "captured",
    source_message_preview: "Synthetic preview", enrichment_status: "complete", status: "open",
    ...extra,
  };
}

async function seed(f, entries) {
  const rows = entries.map(({ id, props, workspace = "ws-1", at = "2026-01-01T00:00:00.123456Z", deleted = null }) => ({
    id, properties: props, workspace, user_id: workspace === "ws-1" ? 1 : 2, at, deleted,
  }));
  await f.pool.query(`
    INSERT INTO blocks (id, type, date, properties, workspace_id, user_id, created_at, updated_at, deleted_at)
    SELECT id, 'block', '2026-11-14', properties, workspace, user_id, at, at, deleted
    FROM jsonb_to_recordset($1::jsonb) AS r(
      id text, properties jsonb, workspace text, user_id int, at timestamptz, deleted timestamptz)
  `, [JSON.stringify(rows)]);
}

async function catchUp(f, bound = 40) {
  for (let index = 0; index < bound; index += 1) {
    const stats = await f.api.runReconciliation();
    assert.ok(stats.metrics.mirror.queries > 0);
    if (!stats.metrics.projections) return;
  }
  assert.fail("mirror did not drain");
}

module.exports = { fixture, response, match, properties, seed, catchUp, stamp };
