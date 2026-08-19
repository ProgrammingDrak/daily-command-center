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
const { taskBlockProps, taskSourceUrl, taskSourceUrlBlocked, recoverSourceUrl } = require("./public/js/task-serialize");

const PERMALINK = "https://cleverrealestate.slack.com/archives/C1/p1723999999000100";
const OTHER_PERMALINK = "https://cleverrealestate.slack.com/archives/C9/p1799999999000999";

// The `^ {2}\}` terminator assumes a multi-line body, so a one-liner silently swallows
// the NEXT declaration (isCheckInTask used to drag all of checkInItem in with it). It
// only "worked" because sloppy-mode vm permits duplicate function declarations; a single
// const landing in that window turns it into an opaque redeclaration SyntaxError. Fail
// loudly on over-capture instead.
function mustSlice(src, re, name) {
  const match = src.match(re);
  assert.ok(match, name + " not found");
  assert.equal((match[0].match(/\bfunction \w+\(/g) || []).length, 1,
    name + " slice over-captured a neighbouring declaration -- tighten the terminator");
  return match[0];
}

function sliceFn(src, name, opts) {
  const re = (opts && opts.oneLine)
    ? new RegExp("^ {2}function " + name + "\\(.*$", "m")
    : new RegExp("^ {2}(?:async )?function " + name + "\\([\\s\\S]*?^ {2}\\}", "m");
  return mustSlice(src, re, name);
}

// The check-in resolvers, lifted out of the IIFE and given the same collaborators the
// browser hands them. resolveLinkedBlock and getDelegatedItemById are stubbed because
// they are block-cache lookups, not part of what is under test here.
function loadResolvers({ items = {}, blocks = {} } = {}) {
  const source = [
    sliceFn(WAITING_SRC, "waitingSourceRef"),
    sliceFn(WAITING_SRC, "recoverUrl"),
    sliceFn(WAITING_SRC, "checkInItemId"),
    sliceFn(WAITING_SRC, "isCheckInTask", { oneLine: true }),
    sliceFn(WAITING_SRC, "checkInItem"),
    sliceFn(WAITING_SRC, "checkInSourceUrl"),
    sliceFn(WAITING_SRC, "checkInOriginBlock"),
  ].join("\n");
  const names = ["waitingSourceRef", "recoverUrl", "checkInItemId", "isCheckInTask", "checkInItem", "checkInSourceUrl", "checkInOriginBlock"];
  const context = {
    window: { DCC: { taskSourceUrl, taskSourceUrlBlocked, recoverSourceUrl }, blockStore: { get: id => blocks[id] || null } },
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
  // Precedence is the only thing this helper decides, so the two fields have to DISAGREE
  // for any assertion to observe it. The same ordering is duplicated server-side in
  // waiting-items.js, and the two silently drifting apart is the realistic regression.
  assert.equal(waitingSourceRef({ contact: { sourceRef: OTHER_PERMALINK }, source_id: PERMALINK }), OTHER_PERMALINK,
    "contact.sourceRef is the structured home and wins when the flat twin disagrees");
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

  const orphan = { id: "waiting-checkin-task:gone", source: "waiting-checkin", source_id: "", delegatedItemId: "gone" };
  assert.equal(checkInSourceUrl(orphan), "", "a reminder whose item is gone resolves to no link, not a throw");
});

// Leg 1 exists so a reminder keeps its link once the Waiting item is completed or
// deleted. When both legs can produce the SAME permalink no assertion can tell them
// apart, and deleting leg 1 leaves the file green. These two cases make it observable.
test("the reminder's own source_id outlives its item and wins any disagreement", () => {
  const fresh = { id: "waiting-checkin-task:wait-1", source: "waiting-checkin", source_id: PERMALINK, delegatedItemId: "wait-1" };

  const { checkInSourceUrl: noItem } = loadResolvers();
  assert.equal(noItem(fresh), PERMALINK, "leg 1 still resolves with no live item at all");

  const moved = { ...slackItem, properties: { ...slackItem.properties, source_id: OTHER_PERMALINK, contact: { sourceRef: OTHER_PERMALINK } } };
  const { checkInSourceUrl: divergent } = loadResolvers({ items: { "wait-1": moved } });
  assert.equal(divergent(fresh), PERMALINK, "the row's own source_id wins over the live item's");
});

test("checkInSourceUrl is scoped to reminders and refuses an unsafe stored value", () => {
  const { checkInSourceUrl } = loadResolvers({ items: { "wait-1": slackItem } });
  assert.equal(checkInSourceUrl({ id: "task-9", source: "slack-bookmark", source_id: PERMALINK }), "",
    "an ordinary task is sourceJumpLink's job; this resolver must not claim it");
  assert.equal(checkInSourceUrl(null), "");
  for (const hostile of ["javascript:alert(1)", "jav" + String.fromCharCode(9) + "ascript:alert(1)"]) {
    assert.equal(
      checkInSourceUrl({ id: "waiting-checkin-task:wait-1", source: "waiting-checkin", source_id: hostile, delegatedItemId: "wait-1" }),
      "",
      "a hostile stored value must abort, not launder through to the item's link"
    );
  }
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

// The chip builder is RUN, not grepped: the dateless branch is what makes the click
// handler skip the day switch, and the attribute has to survive a hostile id.
function loadOriginChip(blocks) {
  const source = [
    sliceFn(WAITING_SRC, "checkInItemId"),
    sliceFn(WAITING_SRC, "isCheckInTask", { oneLine: true }),
    sliceFn(WAITING_SRC, "checkInOriginBlock"),
    sliceFn(WAITING_SRC, "checkInOriginChipHtml"),
  ].join("\n");
  return vm.runInNewContext(source + "\n(checkInOriginChipHtml)", {
    window: { blockStore: { get: id => blocks[id] || null } },
    resolveLinkedBlock: id => blocks[id] || null,
    esc: v => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  });
}

test("the origin chip renders one markup contract for every surface", () => {
  const dated = { id: "blk-77", date: "2026-08-14", properties: { title: "Ship the migration", local_id: "task-77" } };
  const dateless = { id: "blk-88", properties: { title: "Backlog thing" } };
  const hostile = { id: 'b" onclick="bad()', properties: {} };
  const ev = id => ({ id: "waiting-checkin-task:w", source: "waiting-checkin", linkedBlockId: id });

  const withDate = loadOriginChip({ "blk-77": dated })(ev("blk-77"));
  assert.match(withDate, /data-origin-open="task-77"/, "the ROW id, not the block id");
  assert.match(withDate, /data-origin-date="2026-08-14"/);
  assert.match(withDate, /class="src-jump origin"/, "the row's default class");

  const noDate = loadOriginChip({ "blk-88": dateless })(ev("blk-88"));
  assert.match(noDate, /data-origin-open="blk-88"/, "falls back to the block id with no local_id");
  assert.doesNotMatch(noDate, /data-origin-date/,
    "a dateless origin must emit no date, so the handler skips the day switch");

  assert.match(loadOriginChip({ x: hostile })(ev("x")), /data-origin-open="b&quot; onclick=&quot;bad\(\)"/,
    "the id is escaped into the attribute");

  // The modal reuses the same builder with its own class and label.
  const modal = loadOriginChip({ "blk-77": dated })(ev("blk-77"), "detail-action-link", "Open origin task");
  assert.match(modal, /class="detail-action-link"/);
  assert.match(modal, /Open origin task &#8599;<\/button>/);

  assert.equal(loadOriginChip({})(ev("missing")), "", "no origin, no chip");
});

// The only new interactive path. A source regex cannot verify statement ORDER, and the
// order is the whole correctness story here: close before re-opening (or the notes editor
// is destroyed unsaved), switch days before opening (or the modal resolves nothing).
// The only new interactive path, and ORDER is its whole correctness story: close before
// re-opening (or the notes editor is destroyed unsaved, and the deferred render never
// flushes), switch days before opening (or the modal resolves nothing), and wait for the
// row to actually appear (the flush lands a frame later). A source regex cannot check any
// of that, so the function is driven.
test("the origin chip closes, switches days, waits for the row, then opens -- in that order", async () => {
  const openChip = ctx => vm.runInNewContext(
    "const ORIGIN_ANCHOR_TRIES = 20;\n" + sliceFn(WAITING_SRC, "nextFrame") + "\n"
      + sliceFn(WAITING_SRC, "openOriginBlockFromChip") + "\n(openOriginBlockFromChip)",
    Object.assign({ blockTitle: () => "Ship the migration", requestAnimationFrame: cb => setTimeout(cb, 0) }, ctx));

  const overlayOpen = { classList: { contains: () => true } };

  // Clicked from INSIDE the details modal, origin on another day, row appears one frame
  // after the close flush -- the real sequence in the browser.
  let calls = [];
  let resolvedAfter = 2;
  await openChip({
    document: { getElementById: () => overlayOpen },
    closeAddModal: () => calls.push("close"),
    viewDate: "2026-08-18",
    switchToDate: async d => calls.push("switch:" + d),
    taskAnchorById: () => (resolvedAfter-- > 0 ? null : { ev: {}, blockId: "blk-77" }),
    openAddModal: id => calls.push("open:" + id),
    toast: m => calls.push("toast:" + m),
  })({ dataset: { originOpen: "task-77", originDate: "2026-08-14" } });
  assert.deepEqual(calls, ["close", "switch:2026-08-14", "open:task-77"],
    "close, then switch, then open -- and a row that needs a frame must still be opened");

  // Dateless origin: no switch at all.
  calls = [];
  await openChip({
    document: { getElementById: () => null },
    viewDate: "2026-08-18",
    switchToDate: async d => calls.push("switch:" + d),
    taskAnchorById: () => ({ ev: {} }),
    openAddModal: id => calls.push("open:" + id),
    toast: m => calls.push("toast:" + m),
  })({ dataset: { originOpen: "task-77" } });
  assert.deepEqual(calls, ["open:task-77"], "a dateless origin opens on the viewed day, no switch");

  // Never resolves: the jump STILL opens. A hard bail here was tried and reverted --
  // closing the modal defers the render that builds the day's task array, so the miss is
  // routine on the modal path and the bail refused the jump outright. Waiting a bounded
  // number of frames and then opening anyway costs a sparse details panel (exactly what
  // every other openAddModal caller does with an unresolved id) instead of a dead chip.
  calls = [];
  await openChip({
    document: { getElementById: () => null },
    viewDate: "2026-08-18",
    switchToDate: async () => calls.push("switch"),
    taskAnchorById: () => null,
    openAddModal: id => calls.push("open:" + id),
    toast: m => calls.push("toast:" + m),
  })({ dataset: { originOpen: "task-77", originDate: "2026-08-14" } });
  assert.deepEqual(calls, ["switch", "open:task-77"],
    "a row that never resolves is still opened, and must not raise an error toast");

  // A null viewDate must still switch: the idiom falls back to __state.date.
  calls = [];
  await openChip({
    document: { getElementById: () => null },
    viewDate: null,
    __state: { date: "2026-08-18" },
    switchToDate: async d => calls.push("switch:" + d),
    taskAnchorById: () => ({ ev: {} }),
    openAddModal: id => calls.push("open:" + id),
    toast: m => calls.push("toast:" + m),
  })({ dataset: { originOpen: "task-77", originDate: "2026-08-14" } });
  assert.deepEqual(calls, ["switch:2026-08-14", "open:task-77"]);

  // An empty id is a no-op; a throwing dependency surfaces as a toast.
  calls = [];
  await openChip({ document: { getElementById: () => null }, toast: m => calls.push("toast:" + m) })({ dataset: {} });
  assert.deepEqual(calls, [], "no id, no work");

  calls = [];
  await openChip({
    document: { getElementById: () => { throw new Error("boom"); } },
    toast: m => calls.push("toast:" + m),
  })({ dataset: { originOpen: "task-77" } });
  assert.match(calls.join("|"), /toast:Could not open the origin task: boom/);

  // The wait must poll the real condition, not sleep a guessed duration.
  const body = sliceFn(WAITING_SRC, "openOriginBlockFromChip");
  assert.match(body, /for \(let i = 0; i < ORIGIN_ANCHOR_TRIES && !anchored\(\); i \+= 1\)/,
    "the readiness wait must be a bounded poll on the row resolving");
  assert.match(sliceFn(WAITING_SRC, "nextFrame"), /requestAnimationFrame/,
    "the wait must ride animation frames, not a guessed millisecond sleep");
  assert.doesNotMatch(body, /setTimeout\(/, "the handler itself must not sleep");
});

test("both surfaces render through the shared builder and the row keeps its Slack fallback", () => {
  assert.match(SCHEDULE_SRC, /\+srcTag\(ev\.source\)\+sourceJumpLink\(ev\)\+originJumpLink\(ev\)\+/,
    "both chips belong in the title row, beside the Check-in pill");
  assert.match(SCHEDULE_SRC, /if\(!url&&typeof window\.waitingCheckInSourceUrl==="function"\)url=window\.waitingCheckInSourceUrl\(ev\)/,
    "sourceJumpLink must fall back to the check-in resolver");
  assert.match(SCHEDULE_SRC, /window\.waitingOriginChipHtml\(ev\)/,
    "the row must use the shared builder, not its own copy of the markup");
  assert.match(FEATURES_SRC, /window\.waitingOriginChipHtml\(ev,'detail-action-link','Open origin task'\)/,
    "the modal must use the same builder with its own class");
  assert.doesNotMatch(SCHEDULE_SRC + FEATURES_SRC, /data-origin-open="'\+/,
    "no surface may hand-build the attribute contract any more");
  assert.match(WAITING_SRC, /window\.waitingOriginChipHtml = checkInOriginChipHtml;/);
  assert.match(WAITING_SRC, /window\.waitingCheckInSourceUrl = checkInSourceUrl;/);
});

test("the details modal surfaces the source deeplink for any task, not just check-ins", () => {
  const details = mustSlice(FEATURES_SRC, /^function _amBuildDetails\(ev\)\{[\s\S]*?^\}/m, "_amBuildDetails");
  const build = vm.runInNewContext("(" + details + ")", {
    window: { DCC: { esc: v => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;"), taskSourceUrl, taskSourceLabel: () => "Slack" } },
    dur: () => 15, ms: m => m + "m", f12: t => t,
  });
  assert.match(build({ source_id: PERMALINK }), /class="detail-action-link" href="https:\/\/cleverrealestate[^"]*"/,
    "a plain slack-bookmark task gets the jump the modal never had");
  assert.match(build({ source_id: PERMALINK }), /Open in Slack &#8599;/);
  assert.doesNotMatch(build({ source_id: "" }), /detail-action-link/, "no provenance, no link");
  assert.doesNotMatch(build({ source_id: "javascript:alert(1)" }), /href/, "a hostile stored value renders no href");
});

// resolveLinkedBlock's fallback is a whole-cache spread + filter + sort, and
// checkInOriginBlock put it on the per-row render path. The memo has to key on the same
// mutation generation the file's other index uses, or a write can serve a stale row.
test("the local_id lookup is memoized on the mutation generation, like waitingLinkIndex", () => {
  assert.match(WAITING_SRC, /function localIdIndex\(\)/);
  assert.match(WAITING_SRC, /_localIdIndexGen === gen\) return _localIdIndex;/);
  assert.match(WAITING_SRC, /Promise\.resolve\(\)\.then\(\(\) => \{ _localIdIndex = null; \}\);/,
    "the memo must not outlive its render burst");
  assert.match(WAITING_SRC, /return window\.blockStore\.get\(id\) \|\| localIdIndex\(\)\.get\(String\(id\)\) \|\| null;/,
    "resolveLinkedBlock must route its fallback through the memo, not getByType directly");
  assert.doesNotMatch(WAITING_SRC, /getByType\("block"\)\.find\(/,
    "the per-call whole-cache scan must stay deleted");
});

// ── Leg 3: the permalink that only ever made it into prose ──────────────────
// Legs 1 and 2 both read LINK fields. Neither can help the reminder in the bug that
// prompted this: made before leg 1 was stamped, and its Waiting item deleted outright,
// so there is no record left holding the URL in a field. The URL itself was never lost
// -- scheduleDelegatedItem copies the item's notes into the reminder's `detail`.

const NOTES = "Delegated from Slack\n" + PERMALINK + "\n\nFrom unknown in #slack:";

test("recoverSourceUrl only recovers links it can honestly label", () => {
  assert.equal(recoverSourceUrl(NOTES), PERMALINK);
  assert.equal(recoverSourceUrl("see https://mail.google.com/mail/u/0/#inbox/abc please"),
    "https://mail.google.com/mail/u/0/#inbox/abc");

  // A `detail` is free text and routinely quotes a third party's message, so anything
  // outside the two hosts taskSourceLabel can NAME must not become a provenance chip.
  assert.equal(recoverSourceUrl("ping me at https://example.com/thread/9"), "");
  assert.equal(recoverSourceUrl("https://cleverrealestate.slack.com/team/U04Q"), "",
    "a slack.com URL that is not an archives permalink is not a message link");

  // Lookalike hosts. A bare host match would have taken both.
  assert.equal(recoverSourceUrl("https://evil-slack.com/archives/C1/p1"), "");
  assert.equal(recoverSourceUrl("https://slack.com.evil.com/archives/C1/p1"), "");
  assert.equal(recoverSourceUrl("https://mail.google.com.evil.com/x"), "");

  // The pattern only ever matches http(s), so there is no scheme to launder.
  assert.equal(recoverSourceUrl("javascript:alert(1)"), "");
  assert.equal(recoverSourceUrl('<a href="javascript:alert(1)">slack.com/archives/C1</a>'), "");

  // Prose punctuation is not part of the href. A trailing slash is.
  assert.equal(recoverSourceUrl("see (" + PERMALINK + ")."), PERMALINK);
  assert.equal(recoverSourceUrl("here: " + PERMALINK + ","), PERMALINK);
  assert.equal(recoverSourceUrl("https://cleverrealestate.slack.com/archives/C1/"),
    "https://cleverrealestate.slack.com/archives/C1/");

  assert.equal(recoverSourceUrl(null), "");
  assert.equal(recoverSourceUrl(undefined), "");
});

test("an orphaned reminder recovers its permalink from its own detail", () => {
  // The exact shape from prod: source_id never stamped, Waiting item deleted.
  const orphan = {
    id: "waiting-checkin-task:gone",
    source: "waiting-checkin",
    source_id: "",
    delegatedItemId: "gone",
    detail: "Check in\n\nWaiting on an external dependency\n\n" + NOTES,
  };
  const { checkInSourceUrl } = loadResolvers();
  assert.equal(checkInSourceUrl(orphan), PERMALINK);

  assert.equal(checkInSourceUrl({ ...orphan, detail: "Check in\n\nWaiting on Mike" }), "",
    "a reminder with no link anywhere still resolves to no link, not a throw");
});

test("leg 3 is last: a live item and a stored link both outrank prose", () => {
  const detail = "Check in\n\nDelegated from Slack\n" + OTHER_PERMALINK;

  const withItem = { id: "waiting-checkin-task:wait-1", source: "waiting-checkin", source_id: "", delegatedItemId: "wait-1", detail };
  const { checkInSourceUrl: viaItem } = loadResolvers({ items: { "wait-1": slackItem } });
  assert.equal(viaItem(withItem), PERMALINK, "the live item's link wins over the reminder's prose");

  const stored = { ...withItem, source_id: PERMALINK, delegatedItemId: "gone" };
  const { checkInSourceUrl: viaStored } = loadResolvers();
  assert.equal(viaStored(stored), PERMALINK, "the row's own source_id wins over its prose");

  // The hostile abort covers the whole resolver, not just leg 2. Falling through to
  // prose would launder exactly what the abort exists to stop.
  assert.equal(viaStored({ ...withItem, source_id: "javascript:alert(1)" }), "",
    "a hostile stored value must abort before leg 3, not fall through to it");
});

test("a Waiting item whose only trace of Slack is its notes still yields a deeplink", () => {
  const { waitingSourceRef } = loadResolvers();
  // What the drawer card reads, and what scheduleDelegatedItem stamps onto a NEW
  // reminder -- so this is the half that stops the bug recurring going forward.
  assert.equal(waitingSourceRef({ contact: { sourceRef: "" }, notes: NOTES }), PERMALINK);
  assert.equal(waitingSourceRef({ captureNotes: NOTES }), PERMALINK);
  assert.equal(waitingSourceRef({ contact: { sourceRef: OTHER_PERMALINK }, notes: NOTES }), OTHER_PERMALINK,
    "recovery fills an EMPTY field; it never overrides a stored one");
  assert.equal(waitingSourceRef({ notes: "Waiting to hear back from Matt." }), "",
    "a hand-made item with no origin gets no invented one");
});
