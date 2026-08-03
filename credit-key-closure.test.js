// Phase C5 — the ledger gate. Pins lib/task-credit-keys.js, the equivalence closure
// that stops one task from being credited twice under its two source_key spellings
// (client `<date>:<local_id>` vs server `<date>:<blockId>`).
//
// WHAT THIS FILE CAN AND CANNOT PROVE, stated up front because A1 hit the same wall
// and wrote the same disclaimer for canonical-migration.test.js:
//
//   • The JS contract — which query runs for which key shape, the parameters it
//     carries, and the fact that callers act on the RETURNED key — is provable here
//     and is what this file pins.
//   • The SQL's completeness over real data is NOT provable here. The closure exists
//     because of Date.now() local_id collisions, and synthetic rows cannot reproduce
//     them. That half is verified against a restore of prod by
//     scripts/credit-closure-check.mjs, which runs the set-based simulation AND the
//     per-key JS closure over the same rows and asserts they agree. Its result is
//     recorded in handoffs/phase-C5-complete.md: 436 presentations, 326 of which
//     exact matching would double-credit, 0 under the closure.
//
// The earn/revoke side of the contract (does the store WRITE to the key the closure
// returned?) lives in slot-store.test.js, where the store's mock pool already is.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findEquivalentTaskCredit,
  splitSourceKey,
  isClosableDatePart,
  CLOSURE_SQL,
  CLOSURE_AUDIT_SQL,
  EXACT_SQL,
} = require("./lib/task-credit-keys");

// Records every query so a test can assert WHICH statement ran, not just what came
// back. `rowsFor` picks the response by SQL shape.
function stubPool({ closureRows = [], exactRows = [], throwOnClosure = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes("WITH cand AS")) {
        if (throwOnClosure) throw new Error("relation \"blocks\" does not exist");
        return { rows: closureRows };
      }
      return { rows: exactRows };
    },
  };
}

const LEGACY = "2026-06-22:qa-1782144115615-zddpn";
const ROWID = "2026-06-22:917e70d8-7eaa-4000-ba84-ff686d7931f5";

test("splitSourceKey splits on the FIRST colon, so an id containing one survives", () => {
  assert.deepEqual(splitSourceKey(LEGACY), {
    datePart: "2026-06-22",
    idHalf: "qa-1782144115615-zddpn",
  });
  // The rollup bonus key. Prefix is not a date, which isClosableDatePart rejects.
  assert.deepEqual(splitSourceKey("shell:abc-123"), { datePart: "shell", idHalf: "abc-123" });
  // A real prod key whose id half carries its own hyphenated date suffix.
  assert.deepEqual(splitSourceKey("2026-06-26:qt-mqtwh7gp-resched-20260626"), {
    datePart: "2026-06-26",
    idHalf: "qt-mqtwh7gp-resched-20260626",
  });
  assert.equal(splitSourceKey("nocolon"), null);
  assert.equal(splitSourceKey(":leading"), null);   // empty date half is not a key
  assert.equal(splitSourceKey(""), null);
  assert.equal(splitSourceKey(null), null);
});

test("isClosableDatePart rejects the shapes a regex alone would admit", () => {
  assert.equal(isClosableDatePart("2026-06-22"), true);
  // A shape regex admits both of these; casting them is what would 500 the audit
  // endpoint, which is why pg-schema.js has dcc_try_date at all.
  assert.equal(isClosableDatePart("2026-02-31"), false);
  assert.equal(isClosableDatePart("0000-99-99"), false);
  assert.equal(isClosableDatePart("shell"), false);
  assert.equal(isClosableDatePart("unknown"), false);
  assert.equal(isClosableDatePart("2026-6-2"), false);
  assert.equal(isClosableDatePart(""), false);
});

test("a legacy-keyed credit is FOUND when the row-id spelling is presented", async () => {
  const pool = stubPool({ closureRows: [{ source_key: LEGACY, delta: 75, description: "Go over Metrics" }] });
  const hit = await findEquivalentTaskCredit(pool, "ws-1", ROWID);

  // The whole point: the answer is the key the LEDGER holds, not the one asked about.
  assert.equal(hit.sourceKey, LEGACY);
  assert.notEqual(hit.sourceKey, ROWID);
  assert.equal(hit.delta, 75);

  assert.equal(pool.calls.length, 1);
  const call = pool.calls[0];
  assert.ok(call.text.includes("WITH cand AS"), "must use the closure, not exact match");
  // Parameter order is load-bearing: $3 is the id half the candidate join reads and
  // $4 is the date half the key set is rebuilt from. Swap them and the closure
  // silently matches nothing while still reporting success.
  assert.deepEqual(call.params, ["ws-1", ROWID, "917e70d8-7eaa-4000-ba84-ff686d7931f5", "2026-06-22"]);
});

test("no equivalent credit reports null, so a genuinely new completion still pays", async () => {
  const pool = stubPool({ closureRows: [] });
  assert.equal(await findEquivalentTaskCredit(pool, "ws-1", ROWID), null);
});

test("a shell: key gets EXACT matching only — closing over it would be wrong", async () => {
  // The rollup container bonus is pinned to the row id ON PURPOSE so it dedupes
  // across calendar dates (schedule.js awardSlotTaskCredit). It has no date half to
  // close against, and inventing one would let a shell bonus match a task's credit.
  const pool = stubPool({ exactRows: [{ source_key: "shell:abc", delta: 12, description: "Shell" }] });
  const hit = await findEquivalentTaskCredit(pool, "ws-1", "shell:abc");
  assert.equal(hit.sourceKey, "shell:abc");
  assert.equal(pool.calls.length, 1);
  assert.ok(!pool.calls[0].text.includes("WITH cand AS"), "shell keys must skip the closure");
  // Bind order, same reason the closure test asserts it: swap these and the query
  // matches nothing in production while the stub still answers happily.
  assert.deepEqual(pool.calls[0].params, ["ws-1", "shell:abc"], "$1 is the workspace, $2 the key");
});

test("an unparsable prefix also degrades to exact matching instead of throwing", async () => {
  // `sourceDate` falls back to the string "unknown" in public/js/slots.js, so this
  // key shape is reachable in production, not hypothetical.
  const pool = stubPool({ exactRows: [] });
  assert.equal(await findEquivalentTaskCredit(pool, "ws-1", "unknown:task-9"), null);
  assert.ok(!pool.calls[0].text.includes("WITH cand AS"));
});

test("a broken closure query falls back to exact match rather than failing the completion", async () => {
  const pool = stubPool({ throwOnClosure: true, exactRows: [{ source_key: ROWID, delta: 40, description: "x" }] });
  const hit = await findEquivalentTaskCredit(pool, "ws-1", ROWID);
  // Degrades to today's behavior (which is the double-credit bug) rather than
  // blocking the check-off. Two calls: the failed closure, then the fallback.
  assert.equal(hit.sourceKey, ROWID);
  assert.equal(pool.calls.length, 2);
  assert.ok(pool.calls[0].text.includes("WITH cand AS"));
  assert.ok(!pool.calls[1].text.includes("WITH cand AS"));
});

test("an empty source key is null before any query runs", async () => {
  const pool = stubPool();
  assert.equal(await findEquivalentTaskCredit(pool, "ws-1", "   "), null);
  assert.equal(pool.calls.length, 0, "must not query on an empty key");
});

// ── Shape guards on the SQL itself ────────────────────────────────────────────
// These do not prove the queries are CORRECT (only the prod restore can), but they
// pin the three properties whose absence is silent: tenant fencing, the closure step
// that does the actual work, and the audit gate's non-vacuity.

test("both queries fence on workspace with IS NOT DISTINCT FROM, never bare equality", () => {
  // `workspace_id = $1` evaluates to NULL for a null workspace and matches nothing
  // while still reporting success — the seven-reader hazard C3 reported to Track A.
  // EXACT_SQL is in the list because it is the DEGRADED path — the one that runs for
  // every shell: key and every closure failure — and it was previously an inline string
  // this test could not reach, so a regression to bare equality there would have been
  // invisible.
  for (const [name, sql] of [["CLOSURE_SQL", CLOSURE_SQL], ["CLOSURE_AUDIT_SQL", CLOSURE_AUDIT_SQL], ["EXACT_SQL", EXACT_SQL]]) {
    assert.ok(!/workspace_id\s*=\s*\$/.test(sql), `${name} must not use bare workspace equality`);
    assert.ok(/workspace_id IS NOT DISTINCT FROM/.test(sql), `${name} must fence on workspace`);
  }
});

test("the closure actually closes: the key set includes each candidate row's own local_id", () => {
  // Drop the closure step and the query still parses, still runs, still returns
  // rows, and silently stops catching the case it exists for.
  //
  // MY FIRST VERSION OF THIS GUARD WAS VACUOUS and the mutation check caught it.
  // It asserted `/properties->>'local_id'/`, which also appears in the candidate
  // CTE's projection — so deleting the UNION line that actually builds the
  // `<date>:<local_id>` key left the guard green. Assert the KEY CONSTRUCTION, not
  // a substring that happens to occur twice.
  const keySet = CLOSURE_SQL.slice(CLOSURE_SQL.indexOf("), keys AS ("), CLOSURE_SQL.indexOf("SELECT l.source_key"));
  assert.ok(/cand\.local_id/.test(keySet),
    "the key set must include <date>:<row's own local_id> — this is the whole closure");
  assert.ok(/cand\.id/.test(keySet),
    "and <date>:<row id>, for a credit stored in row-id space");
  assert.ok(/canonical_source_key/.test(CLOSURE_SQL), "A1's sidecar covers rows since tombstoned");
  assert.ok(/ORDER BY/.test(CLOSURE_SQL), "several equivalent rows must resolve deterministically");
});

test("the audit gate reports the exact-match baseline beside its own result", () => {
  // A gate that reports only its own 0 is unfalsifiable. Reporting how many
  // presentations exact matching WOULD have double-credited is what makes a pass
  // mean something, and it is how the endpoint shows the fix is still doing work.
  assert.ok(/exact_match_would_double_credit/.test(CLOSURE_AUDIT_SQL));
  assert.ok(/closure_would_double_credit/.test(CLOSURE_AUDIT_SQL));
  assert.ok(/closure_presentations/.test(CLOSURE_AUDIT_SQL));
  // shell: keys must be excluded from the simulation the same way the JS excludes
  // them, or the gate reports failures for keys the closure never claims to handle.
  assert.ok(/key_date IS NOT NULL/.test(CLOSURE_AUDIT_SQL));
});
