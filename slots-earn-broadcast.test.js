// Tests the shell-bonus SSE tagging on POST /api/slot/earn-task (Phase 11).
// The client Budget Tank celebration arms ONLY on a credit-earned event tagged
// bonus_kind:"shell" (public/js/budget.js), so this guards that exact contract:
// a shell source_key produces {bonus_kind:"shell", title}, anything else stays a
// bare credit-earned, and nothing broadcasts when the credit wasn't awarded.
//
// routes/slots.js is a pure (app, ctx) factory with no top-level requires, so it
// mounts on a bare express app with fake stores; req.workspaceId/req.session come
// from app middleware in the real server, so the test injects them.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function mountApp(earnResult) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = "ws-1"; req.session = { userId: 1 }; next(); });
  const events = [];
  const ctx = {
    broadcast: (name, evt, ws) => events.push({ name, evt, ws }),
    requireAdmin: (_req, _res, next) => next(),
    slotStore: { earnTaskCredit: async () => earnResult },
    socialStore: {},
  };
  require("./routes/slots.js")(app, ctx);
  return { app, events };
}

async function post(app, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/slot/earn-task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: resp.status, json: await resp.json() };
  } finally { server.close(); }
}

test("shell source_key tags the credit-earned broadcast with bonus_kind + title", async () => {
  const { app, events } = mountApp({ awarded: true, delta: 25 });
  const { status } = await post(app, { source_key: "shell:abc", title: "Dishes", points_override: 25 });
  assert.equal(status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "slot-changed");
  assert.equal(events[0].evt.action, "credit-earned");
  assert.equal(events[0].evt.bonus_kind, "shell");
  assert.equal(events[0].evt.title, "Dishes");
  assert.equal(events[0].ws, "ws-1");
});

test("shell bonus with no title tags bonus_kind and an empty title (not undefined)", async () => {
  const { app, events } = mountApp({ awarded: true, delta: 10 });
  await post(app, { source_key: "shell:xyz", points_override: 10 });
  assert.equal(events[0].evt.bonus_kind, "shell");
  assert.equal(events[0].evt.title, "");
});

test("a non-shell credit broadcasts a bare credit-earned (no bonus_kind, no title)", async () => {
  const { app, events } = mountApp({ awarded: true, delta: 20 });
  await post(app, { source_key: "task:1", title: "Normal task" });
  assert.equal(events.length, 1);
  assert.equal(events[0].evt.action, "credit-earned");
  assert.equal(events[0].evt.bonus_kind, undefined);
  assert.equal("title" in events[0].evt, false);
});

test("no broadcast when the credit was not awarded (idempotent duplicate)", async () => {
  const { app, events } = mountApp({ awarded: false, credits: 0, delta: 0 });
  const { status } = await post(app, { source_key: "shell:abc", title: "Dishes" });
  assert.equal(status, 200);
  assert.equal(events.length, 0);
});
