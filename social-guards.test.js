// Contract tests for the three guards that decide who can see or write what in
// the social layer. All three became REACHABLE for the first time on this
// branch, and each one fails silently rather than loudly:
//
//   1. publishPost's work-task wall. The comment on feed_posts has always said a
//      `private_task` post can never be published, but nothing ever created a
//      post, so the SQL had never run. Worse, `listPublishablePosts` also filters
//      locked posts out of the UI, so the two guards MASK EACH OTHER: if the wall
//      regressed, the queue would still look right and the only symptom would be
//      a leak in production.
//   2. listFriendsFeed's friend-only predicate, now that it is a longer query
//      with two joins wrapped around the friendship subquery.
//   3. sendPetVisit's per-sender-per-day key, and that it writes into the HOST's
//      workspace rather than the sender's.
//
// Harness: the repo's require-cache mock pool (open-tasks-query.test.js,
// reschedule-pool-query.test.js). Both stores do `const pool = require("./pg-pool")`
// at module scope, so swapping the cache entry before require gives a recorder
// without a database.
const test = require("node:test");
const assert = require("node:assert/strict");

function loadWithMockPool(modulePath, mockPool) {
  const poolPath = require.resolve("./pg-pool");
  const target = require.resolve(modulePath);
  delete require.cache[poolPath];
  delete require.cache[target];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };
  const mod = require(target);
  delete require.cache[poolPath];
  delete require.cache[target];
  return mod;
}

const recorder = (rows = []) => {
  const log = [];
  return { log, async query(sql, params = []) { log.push({ sql: String(sql), params }); return { rows }; } };
};

// ── 1. the work-task wall ────────────────────────────────────────────────────

test("publishPost refuses a private_task post, in the SQL itself", async () => {
  const pool = recorder([]);                       // UPDATE matched nothing
  const store = loadWithMockPool("./social-store", pool);
  const out = await store.publishPost(1, 7, {});
  assert.match(pool.log[0].sql, /publish_source <> 'private_task'/, "the wall must be in the WHERE");
  assert.match(pool.log[0].sql, /owner_user_id=\$2/, "and you can only publish your own post");
  // A refused publish must report false rather than a silent success, because the
  // UI shows a toast either way and "Published" over a refusal is a lie.
  assert.equal(out.published, false);
  assert.equal(out.post, null);
});

test("the publish queue excludes locked posts as well", async () => {
  const pool = recorder([]);
  const store = loadWithMockPool("./social-store", pool);
  await store.listPublishablePosts(7);
  const { sql, params } = pool.log[0];
  assert.match(sql, /publish_state='hidden'/);
  assert.match(sql, /publish_source <> 'private_task'/);
  assert.match(sql, /owner_user_id=\$1/);
  assert.equal(params[0], 7);
});

// ── 2. the friend-only feed ──────────────────────────────────────────────────

test("the feed is published posts from ACCEPTED, non-blocked friends or yourself", async () => {
  const pool = recorder();
  const store = loadWithMockPool("./social-store", pool);
  await store.listFriendsFeed(7, { limit: 10 });
  const { sql, params } = pool.log[0];
  assert.deepEqual(params, [7, 10]);
  assert.match(sql, /p\.publish_state='published'/, "hidden posts never leave their owner");
  assert.match(sql, /status='accepted'/, "pending friendships do not grant read");
  assert.match(sql, /EXCEPT/, "a block must revoke feed access");
  assert.match(sql, /status='blocked'/);
  // Composition: the friendship subquery must be ANDed under publish_state, never
  // offered as an alternative to it.
  const where = sql.slice(sql.indexOf("WHERE")).split("ORDER BY")[0];
  assert.ok(!/\bOR\b\s+p\.publish_state/.test(where), "publish_state is never an OR branch");
});

test("areFriends lets a block veto an accepted row", async () => {
  // friendships rows are DIRECTED, so blockUser inserts a second row and the
  // original 'accepted' one survives. Proven against a live database: the old
  // single-row lookup matched the survivor and kept returning true.
  const store = loadWithMockPool("./social-store",
    recorder([{ friends: true, blocked: true }]));
  assert.equal(await store.areFriends(1, 2), false, "blocked pair are not friends");

  const store2 = loadWithMockPool("./social-store",
    recorder([{ friends: true, blocked: false }]));
  assert.equal(await store2.areFriends(1, 2), true);

  const store3 = loadWithMockPool("./social-store",
    recorder([{ friends: false, blocked: false }]));
  assert.equal(await store3.areFriends(1, 2), false, "strangers are not friends");
});

// ── 3. the pet visit ─────────────────────────────────────────────────────────

function petPoolFor({ hostRows, insertRows }) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      const text = String(sql);
      log.push({ sql: text, params });
      if (/FROM pet_homes/.test(text)) return { rows: hostRows };
      if (/INSERT INTO pet_home_events/.test(text)) return { rows: insertRows.shift() ?? [] };
      return { rows: [] };
    }
  };
}

test("a pet visits a given friend once per DAY, keyed on sender and date", async () => {
  const pool = petPoolFor({
    hostRows: [{ workspace_id: "ws-host", user_id: 9 }],
    insertRows: [[{ id: 1, created_at: "now" }], []]   // second insert conflicts
  });
  const store = loadWithMockPool("./pet-home-store", pool);
  const args = {
    fromUserId: 7, fromUsername: "drake", fromPetName: "Mochi",
    toUserId: 9, toWorkspaceId: "ws-host", message: "hi", onDate: "2026-08-18"
  };
  assert.deepEqual(await store.sendPetVisit(args), { visited: true, alreadyVisitedToday: false });
  // Not an error: the sender is told they already went, which is a normal outcome.
  assert.deepEqual(await store.sendPetVisit(args), { visited: false, alreadyVisitedToday: true });

  const insert = pool.log.find(l => /INSERT INTO pet_home_events/.test(l.sql));
  assert.equal(insert.params[0], "ws-host", "written into the HOST's workspace, not the sender's");
  assert.equal(insert.params[2], "2026-08-18:7", "per SENDER per day, not per host per day");
  assert.match(insert.sql, /ON CONFLICT \(workspace_id, source_type, source_key\) DO NOTHING/);
});

test("a visit records the sender's account, because the pet name is renameable", async () => {
  const pool = petPoolFor({
    hostRows: [{ workspace_id: "ws-host", user_id: 9 }],
    insertRows: [[{ id: 1 }]]
  });
  const store = loadWithMockPool("./pet-home-store", pool);
  await store.sendPetVisit({
    fromUserId: 7, fromUsername: "drake", fromPetName: "Mochi",
    toUserId: 9, toWorkspaceId: "ws-host", message: "hi", onDate: "2026-08-18"
  });
  const insert = pool.log.find(l => /INSERT INTO pet_home_events/.test(l.sql));
  assert.equal(insert.params[3], "Mochi", "actor_name is the pet, a display label");
  assert.equal(insert.params[5].fromUsername, "drake", "and the real account rides in metadata");
});

test("a visit with no resolvable host workspace is a 404, not a write somewhere else", async () => {
  const store = loadWithMockPool("./pet-home-store", petPoolFor({ hostRows: [], insertRows: [] }));
  await assert.rejects(
    () => store.sendPetVisit({ fromUserId: 7, toUserId: 9, toWorkspaceId: "", onDate: "2026-08-18" }),
    (e) => e.statusCode === 404
  );
});

test("the public pet page never serves pet_visit events", async () => {
  // The leak this allowlist exists to close: an anonymous holder of the share
  // link was served a friend's private note verbatim, plus metadata carrying the
  // sender's numeric user id. Verified with an anonymous curl before the fix.
  const pool = {
    log: [],
    async query(sql, params = []) {
      const text = String(sql);
      this.log.push({ sql: text, params });
      if (/FROM pet_homes WHERE share_slug/.test(text)) {
        return { rows: [{ workspace_id: "ws-1", user_id: 1, pet: {}, home: {} }] };
      }
      return { rows: [] };
    }
  };
  const store = loadWithMockPool("./pet-home-store", pool);
  await store.getPublicHome("slug", "2026-08-19");
  const eventsRead = pool.log.find(l => /FROM pet_home_events/.test(l.sql));
  assert.ok(eventsRead, "the public page does read the event ledger");
  assert.match(eventsRead.sql, /event_type = ANY/, "and it must pass an allowlist");
  const allowed = eventsRead.params.find(p => Array.isArray(p));
  assert.ok(allowed, "the allowlist is a bound parameter");
  assert.ok(!allowed.includes("pet_visit"), "pet_visit is never public");
  assert.ok(allowed.includes("encouragement"), "encouragement still is");
});
