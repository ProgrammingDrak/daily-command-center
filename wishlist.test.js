const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { createActivityDb } = require("./test-support/activity-db");
const { createStore } = require("./wishlist-store");
const { createStore: createFiles } = require("./task-attachment-store");
const { validateFile } = require("./lib/task-attachment-policy");
const { total, stale, requirement } = require("./public/js/wishlist-pricing");

const actor = { userId: 1, workspaceId: "ws-1" };
const zeros = { shipping: "0", taxes: "0", extras: "0", discount: "0" };

test("Wishlist comparison preserves unknowns, currency precision and must-have warnings", () => {
  assert.equal(total({ ...zeros, price: "38000", currency: "JPY" }), "38000");
  assert.equal(total({ ...zeros, price: "10.125", shipping: "0.002", discount: "0.003", currency: "KWD" }), "10.124");
  assert.equal(total({ ...zeros, shipping: null, price: "38000", currency: "JPY" }), null);
  assert.equal(total({ ...zeros, price: "10" }), null);
  assert.equal(stale(null), true);
  assert.equal(stale("2026-01-01", Date.parse("2026-02-02")), true);
  assert.equal(stale("2026-01-31", Date.parse("2026-02-02")), false);
  const mustHave = { importance: "Must-have" };
  assert.equal(requirement(mustHave), "Must-have unverified");
  assert.equal(requirement(mustHave, { verdict: "Fails" }), "Failed must-have");
  assert.equal(requirement(mustHave, { verdict: "Partly meets" }), "Must-have partly met");
  assert.equal(requirement(mustHave, { verdict: "Not applicable" }), "");
});

test(
  "Wishlist carry-on fixture through HTTP, PostgreSQL, private attachments and OAuth scopes",
  { skip: !(process.env.DCC_PGLITE_MODULE || process.env.DCC_TEST_DATABASE_URL) },
  async (t) => {
    const ctx = await createActivityDb();
    t.after(() => ctx.close());
    const store = createStore(ctx);
    const app = express();
    const bytesByKey = new Map();
    const privateFiles = createFiles({
      pool: ctx.pool,
      storage: {
        configured: true,
        async put(key, bytes) {
          bytesByKey.set(key, bytes);
        },
        async get(key) {
          return bytesByKey.get(key);
        }
      }
    });
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { userId: Number(req.get("fixture-user")) || undefined };
      req.workspaceId = req.get("fixture-workspace") || "ws-1";
      next();
    });
    require("./routes/task-attachments")(app, { taskAttachmentStore: privateFiles });
    require("./routes/wishlists")(app, ctx);
    const server = await new Promise((resolve) => {
      const running = app.listen(0, "127.0.0.1", () => resolve(running));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = "http://127.0.0.1:" + server.address().port;
    const call = (path, method = "GET", body, headers = {}) =>
      fetch(base + path, {
        method,
        headers: { "fixture-user": "1", "content-type": "application/json", "x-dcc-wishlist": "1", ...headers },
        body: body ? JSON.stringify(body) : undefined
      });

    const id = randomUUID();
    const path = "/api/wishlists/" + id;
    const create = { id, title: "Carry-on research" };
    const initial = await call("/api/wishlists", "POST", create);
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).stage, "Idea");
    assert.equal((await (await call("/api/wishlists", "POST", create)).json()).duplicate, true);
    assert.equal((await call("/api/wishlists", "POST", { ...create, title: "Different" })).status, 409);
    assert.equal((await call(path, "GET", null, { "fixture-user": "3" })).status, 404);
    assert.equal((await call(path, "GET", null, { "fixture-user": "2", "fixture-workspace": "ws-2" })).status, 404);
    assert.equal((await call(path, "GET", null, { "fixture-user": "" })).status, 401);
    assert.equal((await call(path, "PATCH", {}, { origin: "https://other.example" })).status, 403);

    const save = (kind, recordId, data, revision = 0, mutationId = randomUUID()) =>
      store.save(actor, id, kind, recordId, { data, revision, mutationId });
    const international = randomUUID(),
      domestic = randomUUID(),
      dimensions = randomUUID();
    for (const [option, variant] of [
      [international, "International"],
      [domestic, "Domestic"]
    ]) {
      await save("options", option, { title: "Fixture Spinner", kind: "Product", variant, status: "Selected" });
    }
    const requirementData = {
      title: "Airline size compatibility",
      importance: "Must-have",
      scope: "Fixture airline · international",
      desired: "55 × 40 × 23",
      units: "cm",
      notes: "Include wheels and handles"
    };
    await save("criteria", dimensions, requirementData);
    for (const [title, importance] of [
      ["Four smooth wheels", "Important"],
      ["Laundry separation", "Important"],
      ["Strong compression", "Important"],
      ["External electronics pocket", "Important"],
      ["Hooks", "Nice-to-have"]
    ]) {
      await save("criteria", randomUUID(), { title, importance });
    }
    const assessment = {
      optionId: domestic,
      criterionId: dimensions,
      verdict: "Fails",
      actual: "57 × 40 × 23 cm including wheels and handles",
      checkedOn: "2026-11-12"
    };
    const assessmentId = randomUUID();
    await save("assessments", assessmentId, assessment);
    await assert.rejects(save("assessments", randomUUID(), assessment), { statusCode: 409 });
    const firstOffer = randomUUID();
    await save("offers", firstOffer, {
      optionId: domestic,
      title: "Fixture seller Japan",
      currency: "JPY",
      price: "38000",
      ...zeros
    });
    await save("offers", firstOffer, { price: "36000" }, 1);
    await save("offers", randomUUID(), {
      optionId: domestic,
      title: "Fixture seller Kuwait",
      currency: "KWD",
      price: "10.125"
    });
    await save("research", randomUUID(), { title: "Measured with wheels", kind: "My observation", assessmentId });
    await save("research", randomUUID(), {
      title: "Conflicting catalogue dimensions",
      kind: "Manufacturer claim",
      assessmentId
    });
    await assert.rejects(save("research", randomUUID(), { title: "Invalid link", url: "javascript:alert(1)" }), {
      statusCode: 400
    });
    await assert.rejects(save("research", randomUUID(), { title: "Foreign option", optionId: randomUUID() }), {
      statusCode: 404
    });
    const mutation = randomUUID();
    const edit = { ...requirementData, scope: "Fixture airline only" };
    await save("criteria", dimensions, edit, 1, mutation);
    const concurrent = await Promise.allSettled([
      save("criteria", dimensions, { units: "cm", desired: "55 × 40 × 22" }, 2),
      save("criteria", dimensions, { notes: "Measure again" }, 2)
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.find((result) => result.status === "rejected").reason.statusCode, 409);
    assert.equal((await save("criteria", dimensions, edit, 1, mutation)).duplicate, true);

    await save(
      "overview",
      null,
      {
        favoriteId: international,
        neededBy: "2026-12-10",
        reviewOn: "2026-11-20",
        stage: "Decided",
        outcome: "Purchased"
      },
      1
    );
    await save("overview", null, { stage: "Researching" }, 2);
    const wishlist = await store.get(actor, id);
    assert.equal(wishlist.outcome, "Purchased");
    assert.equal(wishlist.options.filter((option) => option.status === "Selected").length, 2);
    assert.equal(
      wishlist.assessments.some((item) => item.optionId === international),
      false
    );
    assert.equal(wishlist.offerHistory.filter((item) => item.offerId === firstOffer).length, 2);
    assert.equal(wishlist.research.length, 2);
    const beforeTask = (await ctx.pool.query("SELECT type,date,properties FROM blocks")).rows;
    assert.deepEqual(
      beforeTask.map((row) => [row.type, row.date, row.properties]),
      [["wishlist_attachment", null, {}]]
    );
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM work_rotations")).rows[0].n, 0);

    const next = { id: randomUUID(), title: "Check airline dimensions" };
    const task = await store.addTask(actor, id, next);
    assert.equal((await store.addTask(actor, id, next)).taskId, task.taskId);
    assert.equal((await ctx.blockDB.getBlock(task.taskId)).date, null);
    assert.equal((await (await call("/api/wishlists/task-choices?q=check%20airline")).json())[0].id, task.taskId);

    const original = await ctx.blockDB.createBlock({
      type: "block",
      date: "2026-11-12",
      user_id: 1,
      workspace_id: "ws-1",
      properties: { kind: "task", title: "Visit a showroom", detail: "Measure including wheels and handles" }
    });
    await ctx.blockDB.createBlock({
      type: "time_entry",
      date: "2026-11-12",
      user_id: 1,
      workspace_id: "ws-1",
      properties: { blockId: original.id, minutes: 12 }
    });
    const bytes = Buffer.from("Fixture private notes");
    const file = randomUUID();
    const meta = validateFile({ originalname: "measurements.txt", mimetype: "text/plain", buffer: bytes });
    await privateFiles.upload(actor, original.id, file, meta, bytes);
    const conversion = { id: randomUUID(), taskId: original.id };
    const converted = await store.create(actor, conversion);
    assert.equal((await store.create(actor, conversion)).duplicate, true);
    assert.equal((await ctx.blockDB.getBlockIncludingDeleted(original.id)).deleted_at != null, true);
    const originalHistory = (await store.get(actor, converted.id)).original;
    assert.equal(originalHistory.properties.detail, "Measure including wheels and handles");
    assert.equal(originalHistory.timeEntries[0].properties.minutes, 12);
    assert.equal(originalHistory.operations[0].action, "delete");
    await assert.rejects(ctx.blockDB.undeleteBlock(original.id), { statusCode: 409 });
    const originalFile = "/api/wishlists/" + converted.id + "/attachments/" + file + "/download";
    assert.equal(await (await call(originalFile)).text(), bytes.toString());
    assert.equal((await call(originalFile, "GET", null, { "fixture-user": "3" })).status, 404);
    assert.equal((await call("/api/tasks/" + original.id + "/attachments/" + file + "/download")).status, 404);
    assert.equal((await call(path + "/attachments/" + file + "/download")).status, 404);

    const failedMutation = randomUUID(),
      failedRecord = randomUUID();
    const failingStore = createStore({
      ...ctx,
      pool: {
        async connect() {
          const client = await ctx.pool.connect();
          return {
            release: () => client.release(),
            query(sql, params) {
              if (sql.startsWith("INSERT INTO wishlist_mutations")) throw new Error("Injected interrupted save");
              return client.query(sql, params);
            }
          };
        }
      }
    });
    const failed = { revision: 0, mutationId: failedMutation, data: { title: "Retry capture" } };
    await assert.rejects(failingStore.save(actor, id, "research", failedRecord, failed), /Interrupted save/i);
    assert.equal(
      (await store.get(actor, id)).research.some((record) => record.id === failedRecord),
      false
    );
    assert.equal((await store.save(actor, id, "research", failedRecord, failed)).revision, 1);
    assert.equal((await store.save(actor, id, "research", failedRecord, failed)).duplicate, true);

    const mcp = require("./lib/wishlist-mcp");
    assert.equal(mcp.scopeFor("dcc_read_wishlist"), "dcc.wishlist.read");
    assert.equal(mcp.scopeFor("dcc_save_wishlist_offers"), "dcc.wishlist.write");
    assert.equal((await mcp.run(ctx, "dcc_read_wishlist", { wishlistId: id }, actor)).title, "Carry-on research");
  }
);
