const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const Waiting = require("./waiting-items");
const CLIENT_SRC = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const CSS_SRC = fs.readFileSync(require.resolve("./public/css/dashboard.css"), "utf8");

function mustSlice(src, re, name) {
  const match = src.match(re);
  assert.ok(match, name + " not found");
  return match[0];
}

function quickDelegateProperties() {
  const dateSource = mustSlice(
    CLIENT_SRC,
    /^ {2}function toDateInputValue\(d\) \{[\s\S]*?^ {2}\}/m,
    "toDateInputValue"
  );
  const quickSource = mustSlice(
    CLIENT_SRC,
    /^ {2}function quickDelegateProperties\(who, work, now\) \{[\s\S]*?^ {2}\}/m,
    "quickDelegateProperties"
  );
  return vm.runInNewContext(
    "(function(){" + dateSource + quickSource + ";return quickDelegateProperties;})()",
    { Date }
  );
}

test("Delegate opens a focused two-field creation path", () => {
  assert.match(CLIENT_SRC, /data-delegated-action="new">Delegate<\/button>/);
  assert.match(CLIENT_SRC, /openDelegatedModal\(null, \{ fastCreate: true \}\)/);
  assert.match(CLIENT_SRC, /Who should I check in on\?/);
  assert.match(CLIENT_SRC, /What are they doing that will unblock me\?/);
  assert.match(CSS_SRC, /\.fast-create \.dm-create-detail\{display:none!important\}/);
  assert.match(CLIENT_SRC, /save\.textContent = fastCreate \? "Delegate" : "Save"/);
  assert.match(CLIENT_SRC, /properties = quickDelegateProperties\(blockerName, blockerTitle\)/);
});

test("fast creation maps two answers into the standard Waiting fields", () => {
  const project = quickDelegateProperties();
  const inputDate = new Date(2026, 8, 28, 12, 0, 0);
  const projected = JSON.parse(JSON.stringify(
    project("  Morgan  ", "  Get legal approval  ", inputDate)
  ));

  assert.deepEqual(projected, {
    title: "Get legal approval",
    myTask: "",
    waitingReason: "delegated",
    delegatee: { name: "Morgan", kind: "person" },
    contact: { channel: "other", address: "", sourceRef: "" },
    checkInMode: "repeat",
    checkInDays: 7,
    checkInDate: "2026-10-05",
    notes: "",
    linkedTagId: null,
    linkedBlockId: null,
    status: "open",
  });

  const normalized = Waiting.normalizeProperties(projected);
  assert.equal(normalized.kind, "delegated_item");
  assert.equal(Waiting.blockerText({ properties: normalized }), "Blocked by Morgan: Get legal approval");
});

test("quick-created delegations use the shared renderer and later check-ins", () => {
  const renderSource = mustSlice(
    CLIENT_SRC,
    /^ {2}function renderCard\(item\) \{[\s\S]*?^ {2}\}/m,
    "renderCard"
  );
  assert.match(renderSource, /const headline = myTask \|\| waiting \|\| "\(untitled\)"/);
  assert.match(renderSource, />Checked in<\/button>/);
  assert.match(renderSource, />Schedule check-in<\/button>/);
  assert.match(renderSource, />Edit<\/button>/);
  assert.match(CLIENT_SRC, /setDelegatedModalMode\(fastCreate \? "fast" : "full"\)/);

  const row = {
    id: "quick-1",
    created_at: "2026-09-28T16:00:00.000Z",
    properties: Waiting.normalizeProperties({
      title: "Get legal approval",
      myTask: "",
      waitingReason: "delegated",
      delegatee: { name: "Morgan", kind: "person" },
      checkInDays: 7,
      checkInDate: "2026-10-05",
      status: "open",
    }),
  };
  const merged = Waiting.mergeTriage({ open_items: [] }, [row], "2026-10-05", {
    nowIso: "2026-10-05T13:00:00.000Z",
  });
  const draft = merged.open_items[0];
  assert.equal(draft.title, "Check in: Get legal approval");
  assert.match(draft.draft_preview, /Quick check-in on Get legal approval\./);
  assert.doesNotMatch(draft.draft_preview, /Get legal approval for Get legal approval/);
});
