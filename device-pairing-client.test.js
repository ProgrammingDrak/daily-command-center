const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const express = require("express");

test("device pairing accepts existing DCC session-secret configurations", () => {
  const app = express();
  const mount = require("./routes/device-pairing");
  assert.doesNotThrow(() => mount(app, {
    pool: {}, sessionSecret: "legacy-secret", projectDir: __dirname,
    recordLoginEvent: async () => {}
  }));
});

test("pairing aborts stalled response bodies before releasing its request timeout", async () => {
  const source = fs.readFileSync(require.resolve("./public/js/device-pairing.js"), "utf8");
  const start = source.indexOf("  async function request(");
  const end = source.indexOf("\n  async function act(", start);
  let fireTimeout = null;
  let delay;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  const request = vm.runInNewContext(source.slice(start,end) + "\nrequest;", {
    AbortController,
    glasses: true,
    setTimeout: (callback, milliseconds) => { fireTimeout = callback; delay = milliseconds; return 1; },
    clearTimeout: () => { fireTimeout = null; },
    fetch: async (_url, options) => ({
      status: 200, ok: true,
      json: () => new Promise((_resolve,reject) => {
        markBodyStarted();
        if (options.signal.aborted) { reject(new Error("body aborted")); return; }
        options.signal.addEventListener("abort", () => reject(new Error("body aborted")), {once:true});
      })
    })
  });
  const operation = request("start");
  await bodyStarted;
  assert.equal(delay,15000);
  assert.equal(typeof fireTimeout,"function");
  fireTimeout();
  await assert.rejects(operation,/body aborted/);
  assert.equal(fireTimeout,null);
});
