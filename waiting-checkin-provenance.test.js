// A "Check in: X" reminder used to be a dead end: it named a thing to chase and
// carried no way to reach it. The permalink was never missing -- 👥 stamps it on the
// Waiting item (routes/slack-events.js captureProperties) and the reminder's spawner
// simply did not copy it, so task-serialize defaulted source_id to "" and the row's
// jump chip short-circuited. These tests pin both halves of the link: the deeplink
// back to Slack, and the jump back to the origin DCC task when there is one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const WAITING_SRC = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const SCHEDULE_SRC = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const FEATURES_SRC = fs.readFileSync(require.resolve("./public/js/features.js"), "utf8");
const { taskBlockProps, taskSourceUrl, taskSourceUrlBlocked } = require("./public/js/task-serialize");

const PERMALINK = "https://cleverrealestate.slack.com/archives/C1/p1723999999000100";

function mustSlice(src, re, name) {
  const match = src.match(re);
  assert.ok(match, name + " not found");
  return match[0];
}

// The check-in resolvers, lifted out of the IIFE and given the same collaborators the
// browser hands them. resolveLinkedBlock and getDelegatedItemById are stubbed because
// they are block-cache lookups, not part of what is under test here.
function loadResolvers({ items = {}, blocks = {} } = {}) {
  const names = ["waitingSourceRef", "checkInItemId", "isCheckInTask", "checkInItem", "checkInSourceUrl", "checkInOriginBlock"];
  const source = names
    .map(name => mustSlice(WAITING_SRC, new RegExp("^ {2}function " + name + "\\([\\s\\S]*?^ {2}\\}", "m"), name))
    .join("\n");
  const context = {
    window: { DCC: { taskSourceUrl, taskSourceUrlBlocked }, blockStore: { get: id => blocks[id] || null } },
    getDelegatedItemById: id => items[id] || null,
    isOpenDelegated: item => (item.properties || {}).status !== "done",
    resolveLinkedBlock: id => blocks[id] || null,
  };
  return vm.runInNewContext(source + "\n({" + names.join(",") + "})", context);
}

const slackItem = {
  id: "wait-1",
  properties: {
    kind: "delegated_item",
    myTask: "Slack task",
    source: "slack-delegate",
    source_id: PERMALINK,
    contact: { channel: "slack", address: "C1", sourceRef: PERMALINK, threadTs: "1723999999.000100", messageTs: "1723999999.000100" },
  },
};

test("a Waiting item's deeplink has one spelling, structured or flat", () => {
  const { waitingSourceRef } = loadResolvers();
  assert.equal(waitingSourceRef(slackItem.properties), PERMALINK);
  assert.equal(waitingSourceRef({ source_id: PERMALINK }), PERMALINK, "the flat twin is honoured when contact is absent");
  assert.equal(waitingSourceRef({ contact: { sourceRef: "  " + PERMALINK + "  " } }), PERMALINK);
  assert.equal(waitingSourceRef({}), "");
  assert.equal(waitingSourceRef(null), "");
});

test("the spawned check-in carries its item's permalink into the persisted block", () => {
  // The literal line under test, so a future edit that drops the forward fails here
  // rather than silently shipping dead-end reminders again.
  assert.match(WAITING_SRC, /title: "Check in: " \+ what,[\s\S]*?source_id: waitingSourceRef\(p\),/,
    "scheduleDelegatedItem must forward the item's deeplink onto the check-in ev");

  const ev = {
    id: "waiting-checkin-task:wait-1",
    title: "Check in: Slack task",
    source: "waiting-checkin",
    source_id: PERMALINK,
    delegatedItemId: "wait-1",
    linkedBlockId: null,
  };
  const props = taskBlockProps(ev, { local_id: ev.id, duration: 15, start: "14:30", end: "14:45" });
  assert.equal(props.source_id, PERMALINK, "taskCommonProps must not strip the forwarded deeplink");
  assert.equal(props.delegatedItemId, "wait-1");
});

test("checkInSourceUrl recovers the permalink for a reminder that stored none", () => {
  const { checkInSourceUrl } = loadResolvers({ items: { "wait-1": slackItem } });
  // Every reminder scheduled before the forward existed looks like this. Resolving
  // through the live item is what heals them, so no backfill script is needed.
  const legacy = { id: "waiting-checkin-task:wait-1", source: "waiting-checkin", source_id: "", delegatedItemId: "wait-1" };
  assert.equal(checkInSourceUrl(legacy), PERMALINK);

  const fresh = { ...legacy, source_id: PERMALINK };
  assert.equal(checkInSourceUrl(fresh), PERMALINK, "its own source_id is preferred, and outlives the item");

  const orphan = { id: "waiting-checkin-task:gone", source: "waiting-checkin", source_id: "", delegatedItemId: "gone" };
  assert.equal(checkInSourceUrl(orphan), "", "a reminder whose item is gone resolves to no link, not a throw");
});

test("checkInSourceUrl is scoped to reminders and refuses an unsafe stored value", () => {
  const { checkInSourceUrl } = loadResolvers({ items: { "wait-1": slackItem } });
  assert.equal(checkInSourceUrl({ id: "task-9", source: "slack-bookmark", source_id: PERMALINK }), "",
    "an ordinary task is sourceJumpLink's job; this resolver must not claim it");
  assert.equal(checkInSourceUrl(null), "");
  assert.equal(
    checkInSourceUrl({ id: "waiting-checkin-task:wait-1", source: "waiting-checkin", source_id: "javascript:alert(1)", delegatedItemId: "wait-1" }),
    "",
    "scheme safety stays in taskSourceUrl, and a hostile stored value must not fall through to the item"
  );
});

test("checkInOriginBlock resolves the origin task only for a live reminder", () => {
  const origin = { id: "blk-77", date: "2026-08-14", properties: { title: "Ship the migration", local_id: "task-77" } };
  const { checkInOriginBlock } = loadResolvers({ items: { "wait-2": slackItem }, blocks: { "blk-77": origin } });
  const ev = { id: "waiting-checkin-task:wait-2", source: "waiting-checkin", delegatedItemId: "wait-2", linkedBlockId: "blk-77" };
  assert.equal(checkInOriginBlock(ev), origin);
  assert.equal(checkInOriginBlock({ ...ev, linkedBlockId: null }), null,
    "a 👥 reminder has no origin row -- its origin is the Slack message");
  assert.equal(checkInOriginBlock({ id: "task-9", source: "manual", linkedBlockId: "blk-77" }), null);

  const { checkInOriginBlock: withTombstone } = loadResolvers({ blocks: { "blk-77": { ...origin, deleted_at: "2026-08-15T00:00:00Z" } } });
  assert.equal(withTombstone(ev), null, "a deleted origin must not render a chip that goes nowhere");
});

test("the itinerary row renders both jumps and routes the origin one through the day switch", () => {
  assert.match(SCHEDULE_SRC, /\+srcTag\(ev\.source\)\+sourceJumpLink\(ev\)\+originJumpLink\(ev\)\+/,
    "both chips belong in the title row, beside the Check-in pill");
  assert.match(SCHEDULE_SRC, /if\(!url&&typeof window\.waitingCheckInSourceUrl==="function"\)url=window\.waitingCheckInSourceUrl\(ev\)/,
    "sourceJumpLink must fall back to the check-in resolver");
  // The row id, not the block id: taskAnchorById matches ev.id, which fromBlock keys
  // as local_id || block.id. Passing block.id opens an empty shell.
  assert.match(SCHEDULE_SRC, /data-origin-block="'\+escHtml\(bp\.local_id\|\|block\.id\)\+'"/);
  assert.match(WAITING_SRC, /if \(date && viewed && date !== viewed && typeof switchToDate === "function"\) await switchToDate\(date\)/,
    "an origin task on another day needs the day switched before its modal can resolve");
  assert.match(WAITING_SRC, /window\.waitingCheckInSourceUrl = checkInSourceUrl;/);
  assert.match(WAITING_SRC, /window\.waitingCheckInOriginBlock = checkInOriginBlock;/);
});

test("the details modal surfaces the same two jumps", () => {
  const details = mustSlice(FEATURES_SRC, /^function _amBuildDetails\(ev\)\{[\s\S]*?^\}/m, "_amBuildDetails");
  assert.match(details, /window\.DCC\.taskSourceUrl\(ev\.source_id\)/);
  assert.match(details, /window\.waitingCheckInSourceUrl\(ev\)/);
  assert.match(details, /window\.waitingCheckInOriginBlock\(ev\)/);
  assert.match(details, /data-origin-block="'\+esc\(op\.local_id\|\|origin\.id\)\+'"/,
    "the modal reuses the row's handler, so it must emit the same row-id attribute");
});
