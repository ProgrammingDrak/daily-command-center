"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

function mount(block, fetchImpl, audioStore) {
  const app = express();
  app.use((req, res, next) => { req.workspaceId = "ws-1"; req.session = { userId: 1 }; next(); });
  require("./routes/meeting-dashboard")(app, {
    blockDB: { getBlock: async () => block }, fetchImpl, audioStore, vaultToken: "test-token",
  });
  return app;
}

async function get(app, path) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("dashboard wrapper refuses a foreign workspace", async () => {
  const response = await get(mount({ workspace_id: "ws-2", properties: { dashboard_ref: "private" } }), "/meetings/m2/dashboard");
  assert.equal(response.status, 404);
});

test("dashboard wrapper isolates the review in a sandboxed iframe and preserves deep links", async () => {
  const response = await get(mount({ workspace_id: "ws-1", properties: { dashboard_ref: "planning" } }), "/meetings/m1/dashboard?t=42.5");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-src 'self'/);
  assert.match(html, /sandbox="allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"/);
  assert.match(html, /dashboard-content\?t=42.5/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test("dashboard content is CSP-sandboxed even when opened directly", async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => "<script>document.body.textContent='review'</script>" });
  const response = await get(mount({ workspace_id: "ws-1", properties: { dashboard_ref: "planning" } }, fetchImpl), "/meetings/m1/dashboard-content");
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /^sandbox /);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'none'/);
});

test("sandboxed dashboard replaces authenticated audio with a short-lived private-store URL", async () => {
  const calls = [];
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '<audio id="audio" controls src="audio"></audio>',
  });
  const audioStore = {
    presignHotAudio: async (ref, options) => {
      calls.push({ ref, options });
      return "https://private.example/audio?signature=a&expires=600";
    },
  };
  const block = {
    workspace_id: "ws-1",
    properties: {
      dashboard_ref: "planning",
      recording_artifact: {
        status: "hot",
        hot_audio: { key: "meetings/hot/ws-1/planning/audio.m4a", expires_at: new Date(Date.now() + 60_000).toISOString() },
      },
    },
  };
  const response = await get(mount(block, fetchImpl, audioStore), "/meetings/m1/dashboard-content");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /src="audio"/);
  assert.match(html, /src="https:\/\/private\.example\/audio\?signature=a&amp;expires=600"/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.workspaceId, "ws-1");
  assert.ok(calls[0].options.expiresIn > 0 && calls[0].options.expiresIn <= 60);
});

test("private-store signing failure still serves the sandboxed transcript", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '<main>Transcript remains readable</main><div class="player"><audio id="audio" src="audio"></audio></div>',
  });
  const audioStore = { presignHotAudio: async () => { throw new Error("R2 unavailable"); } };
  const block = {
    workspace_id: "ws-1",
    properties: {
      dashboard_ref: "planning",
      recording_artifact: {
        status: "hot",
        hot_audio: { key: "meetings/hot/ws-1/planning/audio.m4a", expires_at: new Date(Date.now() + 60_000).toISOString() },
      },
    },
  };
  const response = await get(mount(block, fetchImpl, audioStore), "/meetings/m1/dashboard-content");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Transcript remains readable/);
  assert.match(html, /Full recording is temporarily unavailable/);
  assert.match(html, /data-hot-audio-unavailable="true"/);
  assert.doesNotMatch(html, /src="audio"/);
});
