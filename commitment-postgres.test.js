const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createStore } = require("./commitment-store");
const { createFixtureDb } = require("./scripts/commitment-test-db.cjs");
const uuid = () => crypto.randomUUID();
test("scoped commitments: real transactions, invitation, role, conflict, replay and audit contracts", { skip: process.env.DCC_ACCOUNTABILITY_TEST_PG !== "1" && !process.env.DCC_TEST_DATABASE_URL }, async t => {
  const fixture = await createFixtureDb(); t.after(fixture.cleanup);
  const store = createStore(fixture);
  const input = { id: uuid(), actionId: uuid(), title: "Deliver fictional brief", definitionDone: "The invented brief has a reviewed conclusion", committedDate: "2026-10-08", timeZone: "America/New_York" };
  let c = await store.create(1, "ws-1", input);
  const act = async (who, body) => store.act(who, c.id, { actionId: uuid(), expectedRevision: (await store.read(c.id, 1)).revision, ...body });
  await t.test("private by default; identity and workspace cannot be supplied as another owner", async () => {
    assert.equal(c.owner_user_id, 1); assert.equal(c.events.length, 1);
    assert.deepEqual(await store.list(2), []);
    await assert.rejects(store.read(c.id, 2), e => e.statusCode === 404);
    await assert.rejects(store.create(2, "ws-1", { ...input, id: uuid(), actionId: uuid() }), e => e.statusCode === 403);
    await assert.rejects(store.create(1, "ws-1", { ...input, id: uuid(), actionId: uuid(), committedDate: "2026-02-30" }), e => e.statusCode === 400);
    assert.equal((await store.create(1, "ws-1", input)).events.length, 1);
    await assert.rejects(store.create(1, "ws-1", { ...input, title: "Changed retry" }), e => e.statusCode === 409);
  });
  await t.test("complete collection preserves current commitments and invitations beyond 200 historical rows with bounded queries", async () => {
    await fixture.pool.query(`INSERT INTO accountability_commitments(id,workspace_id,owner_user_id,title,definition_done,committed_date,time_zone)
      SELECT 'history-'||n,'ws-1',1,'Historical fictional commitment','Done','2025-01-01','UTC' FROM generate_series(1,205) n`);
    let queries = 0;
    const counted = createStore({ pool: { connect: async () => {
      const client = await fixture.pool.connect();
      return { query: (...args) => { queries++; return client.query(...args); }, release: () => client.release() };
    } } });
    const all = await counted.list(1);
    assert.equal(all.length,206); assert.ok(all.some(row => row.id === c.id));
    assert.ok(queries <= 6, "list queries should remain bounded as history grows");
    await act(1,{kind:"invite",userId:5,role:"viewer"});
    const invitations = await store.list(5);
    assert.equal(invitations.length,1); assert.equal(invitations[0].id,c.id);
    assert.equal(invitations[0].definition_done,undefined); assert.equal(invitations[0].events,undefined);
    await fixture.pool.query("DELETE FROM accountability_commitments WHERE id LIKE 'history-%'");
    await act(1,{kind:"revoke",userId:5});
  });
  await t.test("invitation reveals a minimal preview; acceptance is explicit", async () => {
    c = await act(1, { kind: "invite", userId: 2, role: "coach" });
    const preview = await store.read(c.id, 2);
    assert.equal(preview.role, "invited"); assert.equal(preview.definition_done, undefined); assert.equal(preview.events, undefined);
    await assert.rejects(act(2, { kind: "challenge", note: "Not accepted" }), e => e.statusCode === 403);
    await act(2, { kind: "accept" });
    assert.equal((await store.read(c.id, 2)).role, "coach");
  });
  await t.test("coach can push, but cannot complete, review, widen grants or read another commitment", async () => {
    await assert.rejects(act(2, { kind: "check_in", note: "Bad date", at: "2026-02-30T16:00:00Z" }), e => e.statusCode === 400);
    await act(2, { kind: "check_in", note: "Bring a draft", at: "2026-10-08T16:00:00Z" });
    await act(2, { kind: "challenge", note: "What is blocking the promised conclusion?" });
    for (const body of [{ kind: "complete" }, { kind: "review", verdict: "met", note: "No" }, { kind: "invite", userId: 3, role: "manager" }, { kind: "renegotiate", committedDate: "2026-10-09", note: "No" }]) {
      await assert.rejects(act(2, body), e => e.statusCode === 403);
    }
    const unrelated = await store.create(3, "ws-3", { ...input, id: uuid(), actionId: uuid(), title: "Private unrelated outcome" });
    await assert.rejects(store.read(unrelated.id, 2), e => e.statusCode === 404);
  });
  await t.test("helper and viewer are distinct; manager reviews are narrative, attributed history", async () => {
    await act(1, { kind: "invite", userId: 3, role: "manager" }); await act(3, { kind: "accept" });
    await act(1, { kind: "invite", userId: 4, role: "helper" }); await act(4, { kind: "accept" });
    await act(1, { kind: "invite", userId: 5, role: "viewer" }); await act(5, { kind: "accept" });
    await act(4, { kind: "comment", note: "I can help review the conclusion" });
    await assert.rejects(act(4, { kind: "challenge", note: "No" }), e => e.statusCode === 403);
    await assert.rejects(act(5, { kind: "comment", note: "No" }), e => e.statusCode === 403);
    await act(1, { kind: "complete", evidence: "Fictional reviewed conclusion attached as text" });
    c = await act(3, { kind: "review", verdict: "partial", note: "Conclusion is present; supporting evidence is still missing" });
    const review = c.events.at(-1); assert.equal(review.actor_name, "casey"); assert.equal(review.detail.verdict, "partial"); assert.equal(c.status, "completed");
    await assert.rejects(act(3, { kind: "revoke", userId: 2 }), e => e.statusCode === 403);
  });
  await t.test("an expanded role requires explicit acceptance again", async () => {
    await act(1, { kind: "invite", userId: 4, role: "coach" });
    const preview = await store.read(c.id, 4);
    assert.equal(preview.role, "invited"); assert.equal(preview.evidence, undefined);
    await assert.rejects(act(4, { kind: "challenge", note: "Not accepted yet" }), e => e.statusCode === 403);
    await act(4, { kind: "accept" });
    assert.equal((await store.read(c.id, 4)).role, "coach");
  });
  await t.test("two devices cannot silently overwrite; duplicate acknowledgement loss is exactly once", async () => {
    c = await store.read(c.id, 1);
    const body = { kind: "reopen", note: "Need the missing evidence", expectedRevision: c.revision, actionId: uuid() };
    const results = await Promise.allSettled([store.act(1, c.id, body), store.act(1, c.id, { ...body, actionId: uuid(), note: "Other stale device" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.statusCode, 409);
    // Use whichever operation won, then retry its exact payload concurrently.
    const last = (await fixture.pool.query("SELECT action_id FROM accountability_events WHERE commitment_id=$1 ORDER BY revision DESC LIMIT 1", [c.id])).rows[0].action_id;
    const winning = last === body.actionId ? body : { ...body, actionId: last, note: "Other stale device" };
    const before = (await store.read(c.id, 1)).events.length;
    await Promise.all([store.act(1, c.id, winning), store.act(1, c.id, winning)]);
    assert.equal((await store.read(c.id, 1)).events.length, before);
  });
  await t.test("renegotiation preserves original date; corrections preserve prior review", async () => {
    c = await act(1, { kind: "renegotiate", committedDate: "2026-10-09", note: "Agreed scope needs more evidence" });
    assert.equal(c.events.at(-1).detail.beforeDate, "2026-10-08"); assert.equal(c.committed_date, "2026-10-09");
    c = await act(3, { kind: "review", verdict: "met", note: "Evidence received; correcting earlier review" });
    assert.equal(c.events.filter(e => e.kind === "review").length, 2);
  });
  await t.test("revocation and blocks deny future reads and queued writes, including old receipts", async () => {
    const oldAction = { kind: "challenge", note: "Earlier review", expectedRevision: (await store.read(c.id, 1)).revision, actionId: uuid() };
    await store.act(2, c.id, oldAction); await act(1, { kind: "revoke", userId: 2 });
    await assert.rejects(store.read(c.id, 2), e => e.statusCode === 404);
    await assert.rejects(store.act(2, c.id, oldAction), e => e.statusCode === 404);
    await fixture.pool.query("INSERT INTO friendships VALUES(1,4,'blocked')");
    await assert.rejects(act(4, { kind: "comment", note: "Queued before block" }), e => e.statusCode === 404);
    assert.deepEqual(await store.list(4), []);
  });
  await t.test("history failure rolls back the business mutation", async () => {
    c = await store.read(c.id, 1);
    await fixture.pool.query(`CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER reject_test_audit BEFORE INSERT ON accountability_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit();`);
    await assert.rejects(act(1, { kind: "blocked", note: "This must roll back" }), /synthetic audit failure/);
    const after = await store.read(c.id, 1); assert.equal(after.revision, c.revision); assert.equal(after.status, c.status);
  });
});
