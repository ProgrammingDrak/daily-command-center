const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TODAY = "2026-08-12";
const source = fs.readFileSync(path.join(__dirname, "public/js/rewards-queue.js"), "utf8");

function response(body, { ok = true, statusText = "OK" } = {}) {
  return { ok, statusText, async json() { return body; } };
}

function harness({ currentDate = TODAY, fetchImpl, toggleImpl, useLocks = false } = {}) {
  const toasts = [];
  const calls = { fetch: [], insert: [], toggle: [], remove: [] };
  const mount = {
    innerHTML: "",
    querySelectorAll() { return []; },
  };
  const badge = { textContent: "", style: {} };
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (id === "rewards-queue-list") return mount;
      if (id === "rewards-section-count") return badge;
      return null;
    },
  };
  const scheduled = [];
  const window = {
    DCC: { toast(message, kind) { toasts.push({ message, kind }); } },
    blockStore: {
      getCurrentDate() { return currentDate; },
      async deleteBlock(id) { calls.remove.push({ id }); },
    },
  };
  const context = {
    console,
    document,
    window,
    viewDate: currentDate,
    __state: { date: currentDate },
    scheduled,
    navigator: useLocks ? { locks: { request: async (_name, callback) => callback() } } : undefined,
    _actualTodayStr: () => TODAY,
    escHtml: value => String(value == null ? "" : value),
    fmtMoney: cents => cents ? "$" + (Number(cents) / 100).toFixed(2) : "",
    isDone: ev => ev.done === true || ev.status === "done",
    insertTaskNow(title, minutes, options) {
      calls.insert.push({ title, minutes, options });
      const ev = { id: "task-new", title, source: options.source, tags: options.tags, status: "open" };
      scheduled.push(ev);
      options.onScheduled({
        localId: ev.id,
        blockId: ev.id,
        start: "10:00",
        dateStr: currentDate,
        persisted: Promise.resolve({ id: "row-new", properties: { local_id: ev.id } }),
      });
    },
    async toggleDone(id, options) {
      calls.toggle.push({ id, options });
      if (toggleImpl) return toggleImpl(id, options, calls, scheduled);
      const ev = scheduled.find(row => row.id === id);
      if (ev) { ev.done = true; ev.status = "done"; }
      return { mutationId: "done-1" };
    },
    render() {},
    async fetch(url, options) {
      calls.fetch.push({ url, options: options || {} });
      if (fetchImpl) return fetchImpl(url, options || {}, calls);
      if (url === "/api/social/rewards/queue") return response([]);
      if (url.startsWith("/api/blocks?date=")) {
        return response([{ id: "row-future", properties: { local_id: "task-future" } }]);
      }
      return response({ changed: true });
    },
  };
  window._actualTodayStr = context._actualTodayStr;

  const instrumented = source.replace(/\n\}\)\(\);\s*$/, `
  window.__rewardQueueTest = {
    completeRewardNow,
    renderRewardsQueue,
    setItems(items) { _items = items; },
    busy: _busy
  };
})();`);
  assert.notEqual(instrumented, source, "reward queue test seam should be injected");
  vm.runInNewContext(instrumented, context, { filename: "rewards-queue.js" });
  return { api: window.__rewardQueueTest, calls, mount, scheduled, toasts };
}

function queued(overrides = {}) {
  return { id: 7, status: "queued", title_snapshot: "Swim", duration_minutes_snapshot: 45, ...overrides };
}

test("queued, claimed, and scheduled reward cards expose Done", () => {
  const h = harness();
  h.api.setItems([
    queued(),
    queued({ id: 9, status: "claimed" }),
    queued({ id: 8, status: "scheduled", scheduled_for: TODAY + "T11:00", scheduled_block_id: "task-old" }),
  ]);
  h.api.renderRewardsQueue();

  assert.equal((h.mount.innerHTML.match(/data-act="done"/g) || []).length, 3);
  assert.match(h.mount.innerHTML, /data-act="schedule"[^>]*>Schedule<\/button>/);
  assert.match(h.mount.innerHTML, /data-act="reschedule"[^>]*>Change time<\/button>/);
});

test("Done is blocked when the itinerary is not viewing today", async () => {
  const h = harness({ currentDate: "2026-08-11" });
  const changed = await h.api.completeRewardNow(queued());

  assert.equal(changed, false);
  assert.equal(h.calls.insert.length, 0);
  assert.equal(h.calls.fetch.length, 0);
  assert.deepEqual(h.toasts, [{ message: "Switch to today to complete this", kind: "info" }]);
});

test("Done creates, links, completes, and redeems a queued reward", async () => {
  const h = harness();
  const changed = await h.api.completeRewardNow(queued());

  assert.equal(changed, true);
  assert.equal(h.calls.insert.length, 1);
  assert.deepEqual(
    { title: h.calls.insert[0].title, minutes: h.calls.insert[0].minutes },
    { title: "🎁 Swim", minutes: 45 }
  );
  assert.equal(h.calls.insert[0].options.source, "reward");
  assert.deepEqual(Array.from(h.calls.insert[0].options.tags), ["reward"]);
  assert.equal(h.calls.toggle.length, 1);
  assert.equal(h.calls.toggle[0].id, "task-new");
  assert.equal(h.calls.toggle[0].options.silent, true);

  const link = h.calls.fetch.find(call => call.url.endsWith("/queue/7/schedule"));
  assert.deepEqual(JSON.parse(link.options.body), {
    scheduledFor: TODAY + "T10:00",
    blockId: "task-new",
    expectedBlockId: null,
  });
  const redeem = h.calls.fetch.find(call => call.url === "/api/social/rewards/redeem-by-block");
  assert.deepEqual(JSON.parse(redeem.options.body), { blockId: "task-new" });
  assert.deepEqual(h.toasts.at(-1), { message: "Done, logged on today", kind: "success" });
});

test("Done completes an existing reward task scheduled today without duplicating it", async () => {
  const h = harness();
  h.scheduled.push({ id: "task-old", source: "reward", tags: ["reward"], status: "open" });
  const changed = await h.api.completeRewardNow(queued({
    status: "scheduled",
    scheduled_for: TODAY + "T09:30",
    scheduled_block_id: "task-old",
  }));

  assert.equal(changed, true);
  assert.equal(h.calls.insert.length, 0);
  assert.equal(h.calls.toggle.length, 1);
  assert.equal(h.calls.toggle[0].id, "task-old");
  assert.equal(h.calls.toggle[0].options.silent, true);
  assert.equal(h.calls.fetch.some(call => call.url.endsWith("/schedule")), false);
  assert.equal(h.calls.remove.length, 0);
});

test("Done replaces a reward scheduled on another day only after the new link succeeds", async () => {
  const events = [];
  const h = harness({
    fetchImpl: async (url) => {
      events.push(url.endsWith("/schedule") ? "link" : url);
      if (url === "/api/social/rewards/queue") return response([]);
      if (url.startsWith("/api/blocks?date=")) {
        return response([{ id: "row-future", properties: { local_id: "task-future" } }]);
      }
      return response({ changed: true });
    },
  });
  const changedPromise = h.api.completeRewardNow(queued({
    status: "scheduled",
    scheduled_for: "2026-08-13T14:00",
    scheduled_block_id: "task-future",
  }));
  const changed = await changedPromise;

  assert.equal(changed, true);
  assert.deepEqual(h.calls.remove, [{ id: "row-future" }]);
  assert.ok(events.indexOf("link") >= 0);
  assert.ok(events.indexOf("link") < events.indexOf("/api/blocks?date=2026-08-13"));
});

test("Done replaces a legacy untimed scheduled reward whose date was not recorded", async () => {
  const h = harness({
    fetchImpl: async url => {
      if (url === "/api/blocks?type=block") {
        return response([{ id: "row-untimed", properties: { local_id: "task-untimed" } }]);
      }
      if (url === "/api/social/rewards/queue") return response([]);
      return response({ changed: true });
    },
  });

  const changed = await h.api.completeRewardNow(queued({
    status: "scheduled",
    scheduled_for: null,
    scheduled_block_id: "task-untimed",
  }));

  assert.equal(changed, true);
  assert.deepEqual(h.calls.remove, [{ id: "row-untimed" }]);
  assert.equal(h.calls.toggle.length, 1);
});

test("Done ignores a second click while the first completion is in flight", async () => {
  let releaseLink;
  const linkPending = new Promise(resolve => { releaseLink = resolve; });
  const h = harness({
    fetchImpl: async (url) => {
      if (url.endsWith("/schedule")) { await linkPending; return response({ changed: true }); }
      if (url === "/api/social/rewards/queue") return response([]);
      return response({ changed: true });
    },
  });

  const first = h.api.completeRewardNow(queued());
  const second = await h.api.completeRewardNow(queued());
  assert.equal(second, false);
  assert.equal(h.calls.insert.length, 1);
  releaseLink();
  assert.equal(await first, true);
});

test("a link failure removes only the newly-created task and leaves the prior placement", async () => {
  const h = harness({
    fetchImpl: async (url) => {
      if (url.endsWith("/schedule")) return response({ error: "link failed" }, { ok: false, statusText: "Bad Request" });
      return response({ changed: true });
    },
  });
  const changed = await h.api.completeRewardNow(queued({
    status: "scheduled",
    scheduled_for: "2026-08-13T14:00",
    scheduled_block_id: "task-future",
  }));

  assert.equal(changed, false);
  assert.deepEqual(h.calls.remove, [{ id: "row-new" }]);
  assert.equal(h.calls.toggle.length, 0);
  assert.equal(h.calls.fetch.some(call => call.url === "/api/social/rewards/redeem-by-block"), false);
  assert.deepEqual(h.toasts.at(-1), { message: "Could not mark reward done: link failed", kind: "error" });
});

test("completion failure does not redeem or report success", async () => {
  const h = harness({ toggleImpl: async () => false });
  const changed = await h.api.completeRewardNow(queued());

  assert.equal(changed, false);
  assert.equal(h.calls.fetch.some(call => call.url === "/api/social/rewards/redeem-by-block"), false);
  assert.equal(h.toasts.some(entry => entry.kind === "success"), false);
  assert.deepEqual(h.toasts.at(-1), { message: "Could not mark reward done: The task completion was not saved", kind: "error" });
});

test("redemption waits for durable completion", async () => {
  let releaseCompletion;
  const completionPending = new Promise(resolve => { releaseCompletion = resolve; });
  const h = harness({
    toggleImpl: async (_id, _options, _calls, rows) => {
      await completionPending;
      const ev = rows.find(row => row.id === "task-new");
      ev.done = true;
      ev.status = "done";
      return { mutationId: "done-delayed" };
    },
  });

  const completion = h.api.completeRewardNow(queued());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.fetch.some(call => call.url === "/api/social/rewards/redeem-by-block"), false);
  releaseCompletion();
  assert.equal(await completion, true);
  assert.equal(h.calls.fetch.some(call => call.url === "/api/social/rewards/redeem-by-block"), true);
});

test("a stale cross-tab card is revalidated before creating a task", async () => {
  const h = harness({
    useLocks: true,
    fetchImpl: async url => {
      if (url === "/api/social/rewards/queue") return response([{ ...queued(), status: "redeemed" }]);
      return response({ changed: true });
    },
  });

  assert.equal(await h.api.completeRewardNow(queued()), false);
  assert.equal(h.calls.insert.length, 0);
  assert.deepEqual(h.toasts.at(-1), { message: "This reward was already handled", kind: "info" });
});

test("silent reward completion is forwarded to the shared completion hook", () => {
  const scheduleSource = fs.readFileSync(path.join(__dirname, "public/js/schedule.js"), "utf8");
  const durableCompletion = scheduleSource.slice(scheduleSource.indexOf("async function commitDoneOnDate"), scheduleSource.indexOf("function _shellBonusPoints"));
  const toggleCompletion = scheduleSource.slice(scheduleSource.indexOf("function toggleDone"), scheduleSource.indexOf("function adjustDur"));
  assert.match(durableCompletion, /awardSlotTaskCredit[\s\S]*silent:!!opts\.silent/);
  assert.match(toggleCompletion, /commitDoneOnDate\(id,_today,\{ev:[^}]+,silent:!!opts\.silent\}\)/);
});
