const test = require("node:test");
const assert = require("node:assert/strict");
const { slackTarget } = require("./lib/slack-status");
test("Slack permalink parsing uses source message rather than thread root and checks workspace and shape", () => {
  const url = "https://cleverrealestate.slack.com/archives/C097MM612UD/p1791471296535379?thread_ts=1791470000.000001&cid=C097MM612UD";
  assert.deepEqual(slackTarget({ contact: { sourceRef: url } }), { channel: "C097MM612UD", ts: "1791471296.535379" });
  assert.deepEqual(slackTarget({ source_id: url }), { channel: "C097MM612UD", ts: "1791471296.535379" });
  for (const value of [url.replace("https:", "http:"), url.replace("cleverrealestate", "other"), url.replace("slack.com", "slack.com.attacker.example"), "javascript:alert(1)", url.replace("p1791471296535379", "pbad"), ""]) {
    assert.equal(slackTarget({ source_id: value }), null);
  }
  assert.equal(slackTarget({ notes: url }), null, "arbitrary task text is not reaction authority");
});
