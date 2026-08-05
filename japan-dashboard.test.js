const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
const js = fs.readFileSync(require.resolve("./public/js/japan-dashboard.js"), "utf8");
const mobile = fs.readFileSync(require.resolve("./public/js/mobile-shell.js"), "utf8");

test("Japan dashboard is wired as a first-class tab", () => {
  assert.match(html, /data-tab="japan"/);
  assert.match(html, /id="tab-japan"/);
  assert.match(html, /public\/js\/japan-dashboard\.js/);
  assert.match(js, /DCC\.tabs\.register\("japan",render\)/);
  assert.match(mobile, /label:"Japan",\s+tab:"japan"/);
});

test("phrase deck covers core travel situations", () => {
  ["Where is the train station?", "What do you recommend?", "How do you say this in Japanese?", "Please help me."].forEach(text => assert.ok(js.includes(text), text));
  assert.match(js, /dcc-japan-card-order-v1/);
});
