"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
const taskActions = fs.readFileSync(require.resolve("./public/js/schedule-tab.js"), "utf8");
const start = source.indexOf("  async function saveDelegatedItem() {");
const end = source.indexOf("\n  function valueOf(id)", start);
assert.ok(start >= 0 && end > start);
const saveSource = source.slice(start, end).trim();
const selectorStart = source.indexOf("  function setVal(id, value) {");
const selectorEnd = source.indexOf("\n  function closeTaskDependencyModal()", selectorStart);
assert.ok(selectorStart >= 0 && selectorEnd > selectorStart);
const selectorSource = source.slice(selectorStart, selectorEnd);

function harness(values, existing = null) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-09-28T12:00:00"])); }
  }
  const requests = [];
  const notices = [];
  let refreshed = false;
  const context = {
    valueOf: id => values[id] || "",
    getDelegatedItemById: () => existing,
    _pendingContactMeta: null,
    _pendingSourceTaskId: values.__pendingSourceTaskId || null,
    toDateInputValue: date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"),
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
    closeDelegatedModal: () => {},
    refreshDelegatedItems: async () => { refreshed = true; },
    afterWaitingAction: async () => { refreshed = true; },
    toast: (message, type) => notices.push({ message, type }),
    window: {},
    Date: FixedDate,
  };
  const save = vm.runInNewContext(`(${saveSource})`, context);
  return { save, requests, notices, refreshed: () => refreshed };
}

test("Waiting access is prominent and contact fields are collapsed below the blocker", () => {
  const header = html.slice(html.indexOf('id="date-nav"'), html.indexOf('id="date-picker-drop"'));
  assert.match(header, /loose-ends-pill[\s\S]*waiting-pill-nav/);
  assert.match(taskActions, /function buildTaskChangeItems[\s\S]*label:"Delegate \/ block"/);
  const form = html.slice(html.indexOf('id="delegated-modal-form"'), html.indexOf('id="dm-save"'));
  assert.ok(form.indexOf('id="dm-blocker-name"') < form.indexOf('id="dm-contact-details"'));
  assert.ok(form.indexOf('id="dm-contact-details"') < form.indexOf('id="dm-contact-channel"'));
  assert.match(form, /<details class="dm-contact-details"/);
  assert.match(form, /<select id="dm-task-link"/);
  assert.match(form, /<input type="hidden" id="dm-my-task"/);
  assert.doesNotMatch(form, /dm-blocker-kind|dm-waiting-reason|dm-blocker-title|type="text" id="dm-my-task"/);
  assert.match(form, /id="dm-date-fields"[\s\S]*id="dm-check-in-date"/);
  assert.match(form, /id="dm-cadence-fields" hidden[\s\S]*id="dm-check-in-days"/);
});

test("follow-up switch only displays controls for the selected mode", () => {
  const start = source.indexOf("  function setCheckInMode(mode) {");
  const end = source.indexOf("\n  function closeDelegatedModal()", start);
  assert.ok(start >= 0 && end > start);
  const nodes = {
    "dm-check-in-mode": { value: "" },
    "dm-date-fields": { hidden: false },
    "dm-cadence-fields": { hidden: true },
  };
  for (const mode of ["date", "repeat"]) {
    nodes["dm-mode-" + mode] = {
      classList: { toggle(name, on) { this.active = on; } },
      setAttribute(name, value) { this[name] = value; },
    };
  }
  const context = {
    setVal: (id, value) => { nodes[id].value = value; },
    document: { getElementById: id => nodes[id] || null },
  };
  const setMode = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  setMode("date");
  assert.equal(nodes["dm-cadence-fields"].hidden, true);
  assert.equal(nodes["dm-date-fields"].hidden, false);
  setMode("repeat");
  assert.equal(nodes["dm-date-fields"].hidden, true);
  assert.equal(nodes["dm-cadence-fields"].hidden, false);
  assert.equal(nodes["dm-mode-repeat"]["aria-pressed"], "true");
});

test("task dropdown sets the Waiting title and conversion target", () => {
  const elements = {
    "dm-id": { value: "" }, "dm-my-task": { value: "" }, "dm-linked-block-id": { value: "" },
  };
  const select = {
    value: "", options: [],
    replaceChildren() { this.options = []; },
    appendChild(option) { this.options.push(option); },
    get selectedOptions() { return this.options.filter(option => option.value === this.value); },
  };
  elements["dm-task-link"] = select;
  const context = {
    document: {
      getElementById: id => elements[id] || null,
      createElement: () => ({ dataset: {}, value: "", textContent: "" }),
    },
    scheduled: [{ id: "task-local", _blockId: "task-block", title: "Review signed agreement" }],
    backlog: [],
    resolveLinkedBlock: id => id === "task-block" ? { id: "task-block" } : null,
    _pendingSourceTaskId: null,
    valueOf: id => elements[id] && elements[id].value || "",
  };
  vm.createContext(context);
  vm.runInContext(selectorSource + "\nthis.populate = populateTaskLinkSelect; this.sync = syncTaskLinkSelection;", context);
  context.populate("task-block", "Review signed agreement", "task-local");
  assert.equal(select.value, "task-block");
  assert.equal(elements["dm-my-task"].value, "Review signed agreement");
  assert.equal(elements["dm-linked-block-id"].value, "task-block");
  assert.equal(context._pendingSourceTaskId, "task-block");

  select.value = "";
  context.sync();
  assert.equal(elements["dm-my-task"].value, "");
  assert.equal(context._pendingSourceTaskId, null);

  select.value = "__new__";
  context.sync();
  assert.equal(elements["dm-my-task"].value, "");
  assert.equal(elements["dm-linked-block-id"].value, "");

  context.populate(null, "Typed quick add", null);
  assert.equal(select.value, "__current__");
  assert.equal(elements["dm-my-task"].value, "Typed quick add");
  assert.equal(elements["dm-linked-block-id"].value, "");
  assert.equal(context._pendingSourceTaskId, null);

  elements["dm-id"].value = "wait-1";
  context.populate("task-block", "Review signed agreement", null);
  assert.equal(context._pendingSourceTaskId, null);
});

test("Waiting form accepts a task without a named blocker and derives follow-up from cadence", async () => {
  const ui = harness({ "dm-my-task": "Review agreement", "dm-check-in-mode": "repeat", "dm-check-in-days": "5" });
  await ui.save();
  assert.equal(ui.requests.length, 1);
  const props = JSON.parse(ui.requests[0].options.body).properties;
  assert.equal(props.myTask, "Review agreement");
  assert.equal(props.delegatee.name, null);
  assert.equal(props.waitingReason, "blocked");
  assert.equal(props.checkInMode, "repeat");
  assert.equal(props.checkInRepeat, true);
  assert.equal(props.checkInDays, 5);
  assert.equal(props.checkInDate, "2026-10-03");
  assert.equal(ui.refreshed(), true);
});

test("saving a selected task sends conversion in the same request", async () => {
  const ui = harness({
    "dm-my-task": "Review agreement", "dm-linked-block-id": "task-block",
    "dm-check-in-mode": "repeat", "dm-check-in-days": "5",
    __pendingSourceTaskId: "task-block",
  });
  await ui.save();
  assert.equal(ui.requests.length, 1);
  const body = JSON.parse(ui.requests[0].options.body);
  assert.equal(body.convertTaskId, "task-block");
  assert.equal(body.properties.linkedBlockId, "task-block");
});

test("Waiting form keeps existing contact metadata and uses a chosen first date", async () => {
  const existing = { id: "wait-1", properties: {
    title: "Old blocker description", waitingReason: "delegated", status: "open",
    delegatee: { name: "Alex", kind: "team" },
    contact: { channel: "slack", address: "C123", sourceRef: "https://example.com/thread", threadTs: "123.4" },
    lastCheckedAt: "2026-09-20T12:00:00Z",
  } };
  const ui = harness({
    "dm-id": "wait-1", "dm-my-task": "Review agreement", "dm-blocker-name": "Alex",
    "dm-notes": "Need approval", "dm-check-in-mode": "date", "dm-check-in-date": "2026-10-05", "dm-check-in-days": "7",
    "dm-contact-channel": "slack", "dm-contact-address": "C123",
    "dm-contact-source-ref": "https://example.com/thread",
  }, existing);
  await ui.save();
  const props = JSON.parse(ui.requests[0].options.body).properties;
  assert.equal(ui.requests[0].options.method, "PATCH");
  assert.equal(props.title, "");
  assert.equal(props.notes, "Need approval");
  assert.equal(props.delegatee.kind, "team");
  assert.equal(props.contact.threadTs, "123.4");
  assert.equal(props.checkInMode, "date");
  assert.equal(props.checkInRepeat, false);
  assert.equal(props.checkInDate, "2026-10-05");
  assert.equal(props.checkInDays, 7);
  assert.equal(props.lastCheckedAt, "2026-09-20T12:00:00Z");
});

test("date mode requires a date and ignores a hidden cadence value", async () => {
  const ui = harness({ "dm-my-task": "Review agreement", "dm-check-in-mode": "date", "dm-check-in-days": "4" });
  await ui.save();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.notices[0].message, "Choose a follow-up date");
});

test("a completed dated follow-up can save notes without setting another date", async () => {
  const existing = { id: "wait-2", properties: {
    myTask: "Review agreement", checkInMode: "date", checkInRepeat: false,
    checkInDate: null, status: "open",
  } };
  const ui = harness({
    "dm-id": "wait-2", "dm-my-task": "Review agreement",
    "dm-check-in-mode": "date", "dm-notes": "Still waiting",
  }, existing);
  await ui.save();
  assert.equal(ui.requests.length, 1);
  const props = JSON.parse(ui.requests[0].options.body).properties;
  assert.equal(props.checkInDate, null);
  assert.equal(props.notes, "Still waiting");
});


test("Waiting date assignments refresh the visible picker without firing save events", () => {
  const begin = source.indexOf("  function setVal(id, value) {");
  const end = source.indexOf("\n  function getLinkableTasks()", begin);
  let renders = 0;
  const field = { value: "", __twRender() { renders++; this.label = this.value; } };
  const buttons = ["today", "tomorrow"].map(token => ({
    dataset: { dmDate: token },
    classList: { toggle(_name, on) { this.active = on; } },
    setAttribute(name, value) { this[name] = value; },
  }));
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-10-07T12:00:00"])); }
  }
  const ctx = {
    Date: FixedDate,
    document: { getElementById: () => field, querySelectorAll: () => buttons },
    toDateInputValue: date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"),
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(begin, end), ctx);
  for (const [value, selected] of [["2026-10-07", "today"], ["2026-10-08", "tomorrow"], ["2026-12-19", null], ["", null]]) {
    ctx.setVal("dm-check-in-date", value);
    assert.equal(field.value, value);
    assert.equal(field.label, value);
    for (const button of buttons) {
      assert.equal(button["aria-pressed"], String(button.dataset.dmDate === selected));
      assert.equal(button.classList.active, button.dataset.dmDate === selected);
    }
  }
  assert.equal(renders, 4);
  // A manual field edit uses the same highlight rule.
  field.value = "2026-10-08";
  ctx.syncCheckInDateShortcuts();
  assert.equal(buttons[1]["aria-pressed"], "true");
  assert.equal(buttons[0]["aria-pressed"], "false");
});
