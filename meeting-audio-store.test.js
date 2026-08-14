"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const audioStore = require("./meeting-audio-store");

test("meeting hot-audio config uses the existing private R2 credentials", () => {
  assert.equal(audioStore.configFromEnv({}), null);
  const config = audioStore.configFromEnv({
    MYCELIUM_R2_ACCESS_KEY_ID: "ak",
    MYCELIUM_R2_SECRET_ACCESS_KEY: "sk",
    MYCELIUM_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    MYCELIUM_R2_WARM_BUCKET: "warm",
  });
  assert.equal(config.bucket, "warm");
  assert.equal(config.region, "auto");
});

test("meeting audio keys are bounded to a safe hot prefix", () => {
  assert.equal(audioStore.keyFor("2026-08-14-planning"), "meetings/hot/2026-08-14-planning/audio.m4a");
  assert.throws(() => audioStore.keyFor("../../"), /Invalid meeting audio slug/);
});

test("browser playback never exposes a meeting from another workspace", async () => {
  const originalPresign = audioStore.presignHotAudio;
  let presignCalls = 0;
  audioStore.presignHotAudio = async () => {
    presignCalls += 1;
    return "https://signed.example/audio.m4a";
  };
  const app = express();
  app.use((req, res, next) => { req.workspaceId = "ws-1"; next(); });
  require("./routes/meeting-audio")(app, {
    blockDB: { getBlock: async () => ({
      id: "meeting-2", workspace_id: "ws-2",
      properties: { recording_artifact: { status: "hot", hot_audio: { key: "meetings/hot/x/audio.m4a" } } },
    }) },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/meetings/meeting-2/audio`, { redirect: "manual" });
    assert.equal(response.status, 404);
    assert.equal(presignCalls, 0);
  } finally {
    audioStore.presignHotAudio = originalPresign;
    await new Promise((resolve) => server.close(resolve));
  }
});
