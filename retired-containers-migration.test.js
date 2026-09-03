const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const sql=fs.readFileSync("migrations/007_retire_shell_wrap.sql","utf8");

test("retired-container migration is mechanically gated and idempotent",()=>{
  assert.match(sql,/-- @gated:/);
  assert.match(sql,/properties->>'type' IN \('shell', 'wrap'\)/);
  assert.match(sql,/retired_containers\.converted_roots/);
  assert.match(sql,/retired_containers\.promoted_children/);
});

test("migration preserves identifiers, history, and scoring history",()=>{
  assert.doesNotMatch(sql,/DELETE FROM blocks/i);
  assert.doesNotMatch(sql,/UPDATE\s+(slot_ledger|points_ledger)/i);
  assert.match(sql,/retired_containers\.task_ids_changed=0/);
  assert.match(sql,/retired_containers\.historical_points_touched=0/);
});

test("migration promotes direct children and keeps recurring anchors",()=>{
  assert.match(sql,/root\.id::text/);
  assert.match(sql,/retiredContainerPromotedFrom/);
  assert.match(sql,/retiredContainerHidden/);
  assert.match(sql,/occurrenceAnchor/);
  assert.match(sql,/templateTree,root,type/);
});
