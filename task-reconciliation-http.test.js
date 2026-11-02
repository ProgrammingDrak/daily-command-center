const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const { FOREGROUND_INDEX_SQL } = require("./conversation-store");
test(
  "MCP completion/reconciliation scope boundary and verified receipts",
  { skip: !process.env.DCC_TEST_DATABASE_URL },
  async (t) => {
    const ctx = await createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(FOREGROUND_INDEX_SQL);
    const app = express();
    app.use(express.json());
    const { oauth, store } = require("./routes/conversation")(app, ctx, {
      enabled: true,
      baseUrl: "https://dcc.example",
      clients: { fixture: { name: "Fixture", redirect_uris: ["https://client.example/callback"] } }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const owner = { userId: 1, workspaceId: "ws-1" };
    const grant = async (scopes) => {
      const verifier = crypto.randomBytes(32).toString("base64url");
      const request = oauth.validateRequest({
        client_id: "fixture",
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
        resource: "https://dcc.example/mcp/dcc",
        state: "test",
        scope: scopes
      });
      const url = new URL(await oauth.consent(request, owner));
      return (
        await oauth.token({
          client_id: "fixture",
          redirect_uri: "https://client.example/callback",
          code: url.searchParams.get("code"),
          code_verifier: verifier,
          grant_type: "authorization_code",
          resource: "https://dcc.example/mcp/dcc"
        })
      ).access_token;
    };
    const rpc = async (token, name, args = {}) => {
      const r = await fetch("http://127.0.0.1:" + server.address().port + "/mcp/dcc", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      });
      return { status: r.status, body: await r.json() };
    };
    const old = await grant("dcc.read dcc.complete"),
      both = await grant("dcc.read dcc.reconcile"),
      writeOnly = await grant("dcc.reconcile");
    assert.equal((await rpc(old, "dcc_reconcile_task")).status, 403);
    await ctx.blockDB.createBlock({
      id: "rpc-task",
      type: "block",
      date: null,
      user_id: 1,
      workspace_id: "ws-1",
      properties: { title: "RPC task", type: "task" }
    });
    const view = (await rpc(old, "dcc_task", { taskId: "rpc-task" })).body.result.structuredContent;
    const complete = {
      taskId: "rpc-task",
      sourceEventId: "rpc:done",
      expectedRevision: view.revision,
      expectedTaskVersion: view.reconciliationVersion,
      outcome: "Finished requested scope",
      at: "2026-11-02T12:00:00Z"
    };
    let reply = await rpc(old, "dcc_complete_task", complete);
    assert.equal(reply.body.result.structuredContent.saveStatus, "verified_saved");
    let receipt = (await rpc(old, "dcc_reconciliation_receipt", { sourceEventId: "rpc:done" })).body.result
      .structuredContent;
    assert.equal(receipt.saveStatus, "verified_saved");
    const undo = {
      taskId: "rpc-task",
      sourceEventId: "rpc:undo",
      expectedRevision: (await store.state(owner)).revision,
      at: "2026-11-02T12:01:00Z",
      reconciliation: {
        choice: "undo",
        undoEventId: "rpc:done",
        expectedTaskVersion: receipt.reconciliation.versions["rpc-task"]
      }
    };
    reply = await rpc(writeOnly, "dcc_reconcile_task", undo);
    assert.equal(reply.body.result.structuredContent.saveStatus, "verified_saved");
    assert.equal(reply.body.result.structuredContent.reconciliation, undefined);
    assert.equal(reply.body.result.structuredContent.state, undefined);
    const current = await store.get("rpc-task", owner);
    const drop = {
      taskId: "rpc-task",
      sourceEventId: "rpc:drop",
      expectedRevision: current.revision,
      at: "2026-11-02T12:02:00Z",
      reconciliation: { choice: "drop", expectedTaskVersion: current.reconciliationVersion }
    };
    assert.equal(
      (await rpc(both, "dcc_reconcile_task", drop)).body.result.structuredContent.saveStatus,
      "verified_saved"
    );
    receipt = (await rpc(both, "dcc_reconciliation_receipt", { sourceEventId: "rpc:drop" })).body.result
      .structuredContent;
    assert.ok(receipt.verifiedTasks[0].deleted_at);
    assert.equal((await rpc(writeOnly, "dcc_reconciliation_receipt", { sourceEventId: "rpc:drop" })).status, 403);
    const foreign = { userId: 2, workspaceId: "ws-2" };
    assert.equal((await store.reconciliationReceipt("rpc:drop", foreign)).saveStatus, "not_found");
  }
);
