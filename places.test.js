const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const Model = require("./lib/places-model");
const { createActivityDb } = require("./test-support/activity-db");
const { createRouter } = require("./lib/places-providers");
const { createStore, SCHEMA_SQL } = require("./places-store");

const actor = { userId: 1, workspaceId: "ws-1" };
const other = { userId: 2, workspaceId: "ws-2" };
const viewer = { userId: 3, workspaceId: "ws-1" };
const makeDay = (...stops) => ({ id: randomUUID(), stops });
const stop = (placeId, options = {}) => ({ id: randomUUID(), placeId, ...options });
const makeTrip = (...days) => ({ name: "Sanriku winter and autumn", zone: "Asia/Tokyo", days });

test("validation preserves unresolved places, checks geometry and evidence, and keeps dates independent of lifecycle", () => {
  assert.deepEqual(Model.parse(Model.place, { name: "Ramen" }).geometries, []);
  const route = { kind: "route", shape: { type: "LineString", coordinates: [[141.61, 40.51], [141.56, 40.54]] } };
  assert.deepEqual(Model.parse(Model.place, { name: "Trail", geometries: [route] }).geometries, [route]);
  assert.throws(() => Model.parse(Model.place, { name: "X", geometries: [{ ...route, kind: "area" }] }), /Geometry/);
  assert.throws(() => Model.parse(Model.place, { name: "X", sources: [{ url: "javascript:alert(1)" }] }), /HTTP/);
  assert.throws(() => Model.parse(Model.place, { name: "X", evidence: [{ field: "hours", status: "verified" }] }), /Verified/);
  const plan = Model.parse(Model.trip, { ...makeTrip(makeDay()), status: "Ready to Schedule" });
  assert.equal(plan.mode, "Hypothetical");
  assert.equal(plan.start, "");
  assert.throws(() => Model.parse(Model.trip, { ...plan, start: "2027-10-04" }), /Only a scheduled/);
  assert.throws(() => Model.parse(Model.trip, { ...plan, days: [plan.days[0], plan.days[0]] }), /unique IDs/);
});

test("planning respects locks, creates fresh stop identities and applies the entered transfer buffer", () => {
  const placeId = randomUUID();
  const first = stop(placeId, { time: "09:30", duration: 30, optional: true, locked: true });
  const second = stop(placeId, { time: "10:25", duration: 20, transferMinutes: 20 });
  const third = stop(placeId, { optional: true });
  const plan = Model.parse(Model.trip, { ...makeTrip(makeDay(first, second, third), makeDay()), mode: "Scheduled", start: "2027-10-04" });
  const [day] = Model.preview(plan, new Map(), [], "America/New_York");
  assert.equal(day.stops[0].plan.date, "2027-10-03");
  assert.match(day.stops[1].issues.join(" "), /26 minutes/);
  const alternative = Model.copy(plan, "Relaxed", "relaxed");
  assert.equal(alternative.days[0].stops.length, 2);
  assert.notEqual(alternative.days[0].id, plan.days[0].id);
  assert.notEqual(alternative.days[0].stops[0].id, first.id);
  assert.equal(alternative.days[0].stops[0].placeId, placeId);
  assert.equal(alternative.days[0].stops[0].time, "09:30");
  assert.equal(alternative.days[0].stops[1].time, "");
  assert.equal(plan.days[0].stops[1].time, "10:25");
  const spring = Model.parse(Model.trip, { ...makeTrip(makeDay(stop(placeId, { time: "02:10", duration: 20 }))),
    mode: "Scheduled", start: "2027-03-14", zone: "America/New_York" });
  assert.match(Model.preview(spring, new Map(), [], "UTC")[0].stops[0].issues.join(" "), /does not exist/);
});

test("configured routing uses only placed coordinates, validates provider legs and labels estimates", async () => {
  const points = [[141.61, 40.51], [141.56, 40.54]];
  const request = async (url, init) => {
    assert.match(url, /foot-walking\/geojson$/);
    assert.deepEqual(JSON.parse(init.body).coordinates, points);
    return { ok: true, json: async () => ({ features: [{
      geometry: { type: "LineString", coordinates: points },
      properties: { summary: { distance: 9200, duration: 6900 }, segments: [{ distance: 9200, duration: 6900 }] }
    }] }) };
  };
  const router = createRouter({ key: "local-fixture", request });
  const result = await router.route(points, "Walking");
  assert.equal(result.provider, "openrouteservice");
  assert.equal(result.summary.duration, 6900);
  await assert.rejects(router.route(points, "Public transit"), { statusCode: 422 });
  await assert.rejects(createRouter({ key: "" }).route(points, "Walking"), { statusCode: 503 });
});

test("Postgres Places end-to-end preserves ownership, sources, copy isolation, schedule replay and attachments", {
  skip: !process.env.DCC_TEST_DATABASE_URL
}, async t => {
  const ctx = await createActivityDb();
  t.after(() => ctx.close());
  await ctx.pool.query(SCHEMA_SQL);
  const store = createStore(ctx);
  const mutate = (input, key = randomUUID(), who = actor) => store.mutate(who, key, input);
  const trailId = randomUUID(), duplicateId = randomUUID(), restaurantId = randomUUID();
  const trail = { name: "Michinoku Coastal Trail", category: "Outdoors", region: "Hachinohe", collections: ["Someday"],
    sources: [{ url: "https://www.instagram.com/p/example/", kind: "discovery" }], season: "Check October access", duration: 35, availability: [{ date: "2027-10-05", kind: "closed" }] };
  const first = await mutate({ action: "place-create", id: trailId, value: trail });
  const duplicate = await mutate({ action: "place-create", id: duplicateId, value: {
    name: trail.name, category: "Outdoors", notes: "Northern section", sources: [{ url: "https://example.org/trail" }]
  } });
  const restaurant = await mutate({ action: "place-create", id: restaurantId, value: { name: "Ramen with Fae" } });
  const tripId = randomUUID();
  const activity = stop(duplicateId, { time: "08:30", duration: 45, notes: "Check coastal weather" });
  const draft = await mutate({ action: "trip-create", id: tripId, value: {
    ...makeTrip(makeDay(activity), makeDay(stop(restaurant.id, { period: "Evening" })), makeDay(), makeDay(), makeDay()), status: "Ready to Schedule"
  } });
  const merge = await mutate({ action: "place-merge", id: first.id, revision: first.revision, sourceId: duplicate.id, sourceRevision: duplicate.revision });
  assert.equal(merge.sources.length, 2);
  const collection = await mutate({ action: "place-collect", collection: "With Fae", items: [
    { id: trailId, revision: merge.revision }, { id: restaurant.id, revision: restaurant.revision }
  ] });
  assert.equal(collection.count, 2);
  let { trips: [current] } = await store.list(actor);
  assert.equal(current.days[0].stops[0].placeId, trailId);
  assert.equal(current.revision, draft.revision + 1);
  await assert.rejects(mutate({ action: "trip-save", id: tripId, revision: draft.revision, value: draft }), { statusCode: 409 });
  await assert.rejects(store.list(viewer), { statusCode: 403 });
  assert.deepEqual(await store.list(other), { places: [], trips: [] });
  await assert.rejects(store.review(other, tripId, "2027-10-04"), { statusCode: 404 });

  const date = "2027-10-04";
  const onClosedDate = await store.review(actor, tripId, "2027-10-05");
  assert.match(onClosedDate.days[0].stops[0].issues.join(" "), /closed on/);
  const checked = await store.review(actor, tripId, date);
  assert.equal(checked.days[4].date, "2027-10-08");
  assert.match(checked.days[0].stops[0].checks.join(" "), /October/);
  assert.equal((await ctx.pool.query("SELECT count(*) FROM blocks WHERE properties->>'source'='places'")).rows[0].count, "0");
  const dating = { action: "trip-date", id: tripId, revision: current.revision, date, asCopy: true };
  const requestId = randomUUID();
  const dated = await mutate(dating, requestId);
  assert.equal((await mutate(dating, requestId)).id, dated.id);
  await assert.rejects(mutate({ ...dating, date: "2027-10-05" }, requestId), { statusCode: 409 });
  assert.equal(dated.mode, "Scheduled");
  assert.notEqual(dated.days[0].id, current.days[0].id);
  assert.notEqual(dated.days[0].stops[0].id, current.days[0].stops[0].id);
  assert.equal(dated.days[0].stops[0].notes, activity.notes);
  assert.equal((await store.list(actor)).trips.find(item => item.id === tripId).start, "");

  const create = async (start, end) => {
    const [row] = await ctx.blockDB.createItineraryTasks([{ date: "2027-10-03", properties: {
      title: "Existing DCC event", kind: "task", start, end, duration: 30
    } }], actor);
    return row;
  };
  const beforeConflict = await store.review(actor, dated.id);
  const existing = await create("19:45", "20:15");
  const withConflict = await store.review(actor, dated.id);
  assert.match(withConflict.days[0].stops[0].issues.join(" "), /Existing DCC event/);
  const publish = approval => ({ action: "trip-publish", id: dated.id, revision: dated.revision, approval, stopIds: [dated.days[0].stops[0].id] });
  await assert.rejects(mutate(publish(beforeConflict.approval)), { statusCode: 409 });
  await assert.rejects(mutate(publish(withConflict.approval)), { statusCode: 409 });
  await ctx.blockDB.deleteBlock(existing.id);
  const fresh = await store.review(actor, dated.id);
  const firstWrite = await mutate(publish(fresh.approval));
  const second = await store.review(actor, dated.id);
  assert.deepEqual(second.days[0].stops[0].issues, []);
  const secondWrite = await mutate(publish(second.approval));
  assert.deepEqual(secondWrite.blockIds, firstWrite.blockIds);
  const [blockId] = firstWrite.blockIds;
  assert.equal((await ctx.blockDB.getBlock(blockId)).properties.kind, "task");
  const shifted = await mutate({ action: "trip-date", id: dated.id, revision: dated.revision, date: "2027-10-11", asCopy: false });
  const shiftedPreview = await store.review(actor, dated.id);
  assert.deepEqual(shiftedPreview.days[0].stops[0].issues, []);
  const shiftedWrite = await mutate({ ...publish(shiftedPreview.approval), revision: shifted.revision });
  assert.deepEqual(shiftedWrite.blockIds, [blockId]);
  assert.equal((await ctx.blockDB.getBlock(blockId)).date, "2027-10-10");
  await ctx.blockDB.updateBlock(blockId, { properties: { title: "Changed in DCC" } });
  assert.match((await store.review(actor, dated.id)).days[0].stops[0].issues.join(" "), /edited/);
  const task = await mutate({ action: "linked-task", id: tripId, revision: current.revision, kind: "trip", title: "Confirm permits" });
  assert.equal(task.links[0].id, task.blockIds[0]);
  assert.ok((await store.related(actor, "confirm")).some(link => link.id === task.blockIds[0]));

  const files = new Map();
  const attachments = require("./task-attachment-store").createStore({ pool: ctx.pool, storage: {
    configured: true, async put(key, bytes) { files.set(key, bytes); }, async get(key) { return files.get(key); }
  } });
  const placeActor = { ...actor, placeId: trailId };
  const parent = await attachments.placeParent(placeActor, true);
  const uploadId = randomUUID();
  const bytes = Buffer.from("trip source");
  const meta = require("./lib/task-attachment-policy").validateFile({ originalname: "source.txt", mimetype: "text/plain", buffer: bytes });
  await attachments.upload(placeActor, parent, uploadId, meta, bytes);
  assert.deepEqual((await attachments.download(placeActor, parent, uploadId)).bytes, bytes);
  await assert.rejects(attachments.placeParent({ ...viewer, placeId: trailId }), { statusCode: 404 });
  await assert.rejects(attachments.download(actor, parent, uploadId), { statusCode: 404 });
  assert.ok((await store.list(actor)).places.find(place => place.id === trailId).hasAttachments);
});
