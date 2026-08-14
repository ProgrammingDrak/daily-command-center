const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/glymphatic-brief.js"), "utf8");
const TODAY = "2026-08-14";
const REVIEW_DATE = "2026-08-13";

function reviewState(packetDate = TODAY) {
  return {
    date: packetDate,
    glymphatic_brief: {
      decisions: {},
      current: {
        suggested_tasks: [],
        pages: [{
          id: "day-review",
          review_date: REVIEW_DATE,
          items: [{
            id: "did-1", title: "Shipped the review", start: "14:00", duration: 30,
            idempotency_key: "day-review:2026-08-13:did-1",
            followups: [{ id: "follow-1", title: "Send the rollout note", duration: 15 }]
          }]
        }]
      }
    }
  };
}

function load(state, fetchImpl) {
  const storage = new Map();
  const scopedFetch = async (url, opts) => {
    if (url === "/api/me") {
      return { ok: true, json: async () => ({ userId: 1, workspaceId: "ws-1" }) };
    }
    if (fetchImpl) return fetchImpl(url, opts);
    return { ok: true, json: async () => ({}) };
  };
  const sandbox = {
    console,
    __state: state,
    __todayDate: TODAY,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document: {
      activeElement: null,
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ style: {}, addEventListener() {}, appendChild() {}, remove() {} })
    },
    fetch: scopedFetch,
    setInterval() {}, setTimeout() {}, clearInterval() {},
    CustomEvent: function CustomEvent(type) { this.type = type; },
    dispatchEvent() {},
    showToast() {},
    ms: minutes => minutes + "m"
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__DCC_STATE__ = state;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, storage };
}

test("Day Review falls back to the previous packet without changing its review date", async () => {
  const today = { date: TODAY, glymphatic_brief: { current: { suggested_tasks: [], pages: [] } } };
  const previous = reviewState(REVIEW_DATE);
  const seen = [];
  const { sandbox } = load(today, async url => {
    seen.push(url);
    return { ok: true, json: async () => previous };
  });
  const ctx = await sandbox.DCC.DayReview.load();
  assert.equal(ctx.packetDate, REVIEW_DATE);
  assert.equal(ctx.reviewDate, REVIEW_DATE);
  assert.deepEqual(seen, ["/api/state/day?date=2026-08-13"]);
});

test("a review card stays pending until its parent and follow-up are both handled", async () => {
  const state = reviewState();
  state.glymphatic_brief.decisions["did-1"] = { action: "approve" };
  const { sandbox } = load(state);
  const ctx = await sandbox.DCC.DayReview.load();
  assert.equal(sandbox.DCC.DayReview.pendingCount(ctx), 1);
  const html = sandbox.DCC.DayReview.renderPending(ctx);
  assert.match(html, /Logged/);
  assert.match(html, /Send the rollout note/);
  assert.match(html, /Push to Fri, Aug 14/);
});

test("approve writes completion to review_date and its durable decision to packetDate", async () => {
  const state = reviewState();
  state.glymphatic_brief.current.pages[0].items[0].followups = [];
  const calls = [];
  const { sandbox } = load(state, async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => url.endsWith("log-done") ? { credit: { credits: 2 } } : { ok: true } };
  });
  const ctx = await sandbox.DCC.DayReview.load();
  await sandbox.DCC.DayReview.approveItem("did-1");
  assert.equal(calls[0].url, "/api/dcc/brief/log-done");
  assert.equal(calls[0].body.date, REVIEW_DATE);
  assert.equal(calls[1].url, "/api/dcc/brief/decision");
  assert.equal(calls[1].body.date, TODAY);
  assert.equal(calls[1].body.action, "approve");
  assert.equal(sandbox.DCC.DayReview.pendingCount(ctx), 0);
});

test("review-local UI is scoped to the authenticated workspace and user", async () => {
  const { sandbox, storage } = load(reviewState());
  await sandbox.DCC.DayReview.load();
  assert.ok([...storage.keys()].some(key => key.includes("review:ws-1:1:")));
  assert.equal([...storage.keys()].some(key => key === "dcc-glymphatic-brief:" + TODAY), false);
});

test("previous-day fetch failures stay retryable", async () => {
  const today = { date: TODAY, glymphatic_brief: { current: { suggested_tasks: [], pages: [] } } };
  const { sandbox } = load(today, async () => { throw new Error("offline"); });
  await assert.rejects(() => sandbox.DCC.DayReview.load(), /offline/);
});
