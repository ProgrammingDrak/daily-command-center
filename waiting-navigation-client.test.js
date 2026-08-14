const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const TRIAGE_SRC = fs.readFileSync(require.resolve("./public/js/triage.js"), "utf8");
const WAITING_SRC = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");

function mustSlice(src, re, name) {
  const match = src.match(re);
  assert.ok(match, name + " not found");
  return match[0];
}

test("Waiting check-in reminders expose a link to their canonical item", () => {
  const source = mustSlice(TRIAGE_SRC, /^function waitingItemLinkHtml\(item, className\)\{[\s\S]*?\n\}/m, "waitingItemLinkHtml");
  const render = vm.runInNewContext("(" + source + ")", {
    DCC: { esc: value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;") },
  });
  const html = render({ waiting_item_id: 'waiting-1" onclick="bad()' }, "open-source");
  assert.match(html, />Open task<\/button>/);
  assert.match(html, /data-waiting-item="waiting-1&quot; onclick=&quot;bad\(\)"/);
  assert.equal(render({}, "open-source"), "");
  assert.match(TRIAGE_SRC, /waitingItemLinkHtml\(item,'schedule-triage-open-waiting'\)/);
  assert.match(TRIAGE_SRC, /window\.openWaitingItem\(btn\.dataset\.waitingItem\)/);
});

test("opening a reminder targets the full Waiting card and its lifecycle actions", () => {
  const openSource = mustSlice(WAITING_SRC, /^ {2}function openWaitingItem\(id\) \{[\s\S]*?^ {2}\}/m, "openWaitingItem");
  assert.match(openSource, /openTasksToSection\("tm-delegated-blocked-section", \{ solo: true \}\)/);
  assert.match(openSource, /node\.dataset\.id === String\(id\)/);
  assert.match(WAITING_SRC, /data-delegated-action="unblock"[\s\S]*?>Schedule task<\/button>/);
  assert.match(WAITING_SRC, /data-delegated-action="complete"[\s\S]*?>Complete task<\/button>/);
  assert.match(WAITING_SRC, /postWaitingAction\(id, "complete"/);
});

test("source-backed drafts consolidate into Review and Send", () => {
  const source = mustSlice(TRIAGE_SRC, /^function triageDraftAction\(item\)\{[\s\S]*?\n\}/m, "triageDraftAction");
  const actionFor = vm.runInNewContext("(" + source + ")", {
    window: { DCC: { safeUrlAttr: value => /^https?:/.test(value || "") ? value : "" } },
  });
  assert.deepEqual(
    { ...actionFor({ draft_id: "draft-1", draft_preview: "Hello", link: "https://slack.example/thread" }) },
    { kind: "copy-link", href: "https://slack.example/thread", label: "Review and Send" }
  );
  assert.deepEqual(
    { ...actionFor({ draft_id: "draft-2", draft_preview: "Hello" }) },
    { kind: "copy", label: "Copy Draft" }
  );
  assert.deepEqual(
    { ...actionFor({ draft_id: "draft-3", draft_link: "https://mail.example/draft" }) },
    { kind: "link", href: "https://mail.example/draft", label: "Review and Send" }
  );
  assert.match(TRIAGE_SRC, /class="tri-copy-draft"[\s\S]*?>Review and Send<\/a>/);
  assert.match(TRIAGE_SRC, /class="schedule-triage-copy"[\s\S]*?>Review and Send<\/a>/);
});

test("Review and Send navigates only after the draft copy succeeds", async () => {
  const source = mustSlice(TRIAGE_SRC, /^async function activateTriageDraftAction\(event, element\)\{[\s\S]*?\n\}/m, "activateTriageDraftAction");
  const pending = { opener: {}, location: {}, closed: false, close() { this.closed = true; } };
  let copied = false;
  let prevented = false;
  const activate = vm.runInNewContext("(" + source + ")", {
    copyTriageDraft: async () => copied,
    showToast() {},
    window: {
      DCC: { safeUrl: value => /^https?:/.test(value || "") ? value : "" },
      open: () => pending,
    },
  });
  const event = { stopPropagation() {}, preventDefault() { prevented = true; } };
  const element = { dataset: { copyDraft: "draft-1" }, getAttribute: () => "https://slack.example/thread?a=1&b=2" };

  assert.equal(await activate(event, element), false);
  assert.equal(prevented, true);
  assert.equal(pending.closed, true);
  assert.equal(pending.location.href, undefined);

  copied = true;
  pending.closed = false;
  assert.equal(await activate(event, element), true);
  assert.equal(pending.location.href, "https://slack.example/thread?a=1&b=2");
});
