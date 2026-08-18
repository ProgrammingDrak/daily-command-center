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

// Serves /api/state/day by date, the way the real endpoint does, so the anchoring and
// look-back walks can be exercised instead of stubbed.
function dayServer(rows, seen) {
  return async (url) => {
    if (seen) seen.push(url);
    const date = String(url).split("date=")[1] || "";
    const state = rows[date];
    if (!state) return { ok: true, json: async () => ({ date, glymphatic_brief: { current: { pages: [] } } }) };
    return { ok: true, json: async () => state };
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
  const seen = [];
  const { sandbox } = load(today, dayServer({ [REVIEW_DATE]: reviewState(REVIEW_DATE) }, seen));
  const ctx = await sandbox.DCC.DayReview.load();
  assert.equal(ctx.packetDate, REVIEW_DATE);
  assert.equal(ctx.reviewDate, REVIEW_DATE);
  assert.equal(seen[0], "/api/state/day?date=2026-08-13");
  assert.equal(ctx.packets.length, 1, "the day before it has no packet of its own");
});

// The packet is published into its review day AND the next day's row; the next night
// overwrites the borrowed copy. Reading it from the borrowed row is fine, WRITING there
// is not: the decision outlives the row it was made against.
test("decisions are anchored to the packet's own day, not the row it was read from", async () => {
  const state = reviewState();                       // TODAY's row, reviewing REVIEW_DATE
  const owner = reviewState(REVIEW_DATE);            // the same packet in its own row
  const calls = [];
  const { sandbox } = load(state, async (url, opts) => {
    if (String(url).startsWith("/api/state/day")) return dayServer({ [REVIEW_DATE]: owner })(url);
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const ctx = await sandbox.DCC.DayReview.load();
  assert.equal(ctx.packetDate, REVIEW_DATE, "anchored to the packet's durable home");
  await sandbox.DCC.DayReview.dismissItem("did-1");
  assert.equal(calls[0].url, "/api/dcc/brief/decision");
  assert.equal(calls[0].body.date, REVIEW_DATE);
});

test("older unsettled packets stay reachable, and a click lands on its own packet", async () => {
  const older = {
    date: "2026-08-12",
    glymphatic_brief: {
      decisions: {},
      current: { pages: [{ id: "day-review", review_date: "2026-08-12", items: [{ id: "did-old", title: "Older work" }] }] }
    }
  };
  const calls = [];
  const { sandbox } = load(reviewState(REVIEW_DATE), async (url, opts) => {
    if (String(url).startsWith("/api/state/day")) return dayServer({ "2026-08-12": older })(url);
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const ctx = await sandbox.DCC.DayReview.load();
  assert.equal(ctx.packets.map(p => p.packetDate).join(","), REVIEW_DATE + ",2026-08-12");
  assert.equal(sandbox.DCC.DayReview.pendingCount(ctx), 3, "both days count");
  const html = sandbox.DCC.DayReview.renderPending(ctx);
  assert.match(html, /data-gb-packet="2026-08-12"/, "each card names the packet it came from");
  assert.match(html, /Older work/);

  // The click routes by the card's stamp, so a packet swapped under an open modal
  // cannot send one day's ids to another day's packet.
  const card = { closest: () => ({ getAttribute: () => "2026-08-12" }) };
  await sandbox.DCC.DayReview.dismissItem("did-old", card);
  assert.equal(calls[0].body.date, "2026-08-12");
  assert.equal(calls[0].body.task_id, "did-old");
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

test("approve writes both the completion and its decision to the review day", async () => {
  const state = reviewState(REVIEW_DATE);
  state.glymphatic_brief.current.pages[0].items[0].followups = [];
  const calls = [];
  const { sandbox } = load(state, async (url, opts) => {
    if (String(url).startsWith("/api/state/day")) return dayServer({})(url);
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => url.endsWith("log-done") ? { credit: { credits: 2 } } : { ok: true } };
  });
  const ctx = await sandbox.DCC.DayReview.load();
  await sandbox.DCC.DayReview.approveItem("did-1");
  assert.equal(calls[0].url, "/api/dcc/brief/log-done");
  assert.equal(calls[0].body.date, REVIEW_DATE);
  assert.equal(calls[1].url, "/api/dcc/brief/decision");
  assert.equal(calls[1].body.date, REVIEW_DATE);
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
