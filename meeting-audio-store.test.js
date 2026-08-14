"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const audioStore = require("./meeting-audio-store");
const { belongsToWorkspace, remainingAccessSeconds } = require("./meeting-access");

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
  assert.equal(audioStore.keyFor("2026-08-14-planning", "ws-1"), "meetings/hot/ws-1/2026-08-14-planning/audio.m4a");
  assert.throws(() => audioStore.keyFor("../../", "ws-1"), /Invalid meeting audio slug/);
  assert.throws(() => audioStore.keyFor("planning", "../../"), /Invalid meeting audio slug/);
});

test("meeting dashboard and audio access require the owning workspace", () => {
  assert.equal(belongsToWorkspace({ workspace_id: "ws-1" }, "ws-1"), true);
  assert.equal(belongsToWorkspace({ workspace_id: "ws-2" }, "ws-1"), false);
  assert.equal(belongsToWorkspace(null, "ws-1"), false);
});

test("signed playback never extends beyond the remaining holding period", () => {
  const now = Date.parse("2026-08-14T12:00:00Z");
  assert.equal(remainingAccessSeconds("2026-08-14T12:05:00Z", now), 300);
  assert.equal(remainingAccessSeconds("2026-08-14T13:00:00Z", now), 600);
  assert.equal(remainingAccessSeconds("invalid", now), 0);
  assert.equal(remainingAccessSeconds("2026-08-14T11:59:59Z", now), 0);
});

test("stored hot-audio references cannot escape their workspace or bucket", async () => {
  const env = {
    MYCELIUM_R2_ACCESS_KEY_ID: "ak",
    MYCELIUM_R2_SECRET_ACCESS_KEY: "sk",
    MYCELIUM_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    MYCELIUM_R2_WARM_BUCKET: "warm",
  };
  await assert.rejects(
    audioStore.presignHotAudio({ key: "meetings/hot/ws-2/x/audio.m4a" }, { env, workspaceId: "ws-1" }),
    /outside this workspace/,
  );
  await assert.rejects(
    audioStore.presignHotAudio({ bucket: "other", key: "meetings/hot/ws-1/x/audio.m4a" }, { env, workspaceId: "ws-1" }),
    /outside this workspace/,
  );
  await assert.rejects(
    audioStore.deleteHotAudio({ bucket: "other", key: "meetings/hot/ws-1/x/audio.m4a" }, { env, workspaceId: "ws-1" }),
    /outside this workspace/,
  );
  await assert.rejects(
    audioStore.deleteHotAudio({ key: "meetings/hot/ws-2/x/audio.m4a" }, { env, workspaceId: "ws-1" }),
    /outside this workspace/,
  );
});

test("meeting audio expiry is required and cannot extend beyond the holding window", () => {
  const now = Date.parse("2026-08-14T12:00:00Z");
  assert.equal(audioStore.normalizeExpiry("2026-08-28T12:00:00Z", now), "2026-08-28T12:00:00.000Z");
  assert.throws(() => audioStore.normalizeExpiry("not-a-date", now), /expiry within 14 days/);
  assert.throws(() => audioStore.normalizeExpiry("2026-08-29T12:00:00Z", now), /expiry within 14 days/);
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
      properties: { recording_artifact: { status: "hot", hot_audio: { key: "meetings/hot/ws-2/x/audio.m4a" } } },
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
