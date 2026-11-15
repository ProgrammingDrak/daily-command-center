// Synthetic data calibrated to the reported 4,249 live blocks and row JSON
// volume. The per-kind proportions are illustrative, not production counts.
async function seedTaskLibrary(pool) {
  const rows = [];
  const add = (id, properties, options = {}) => {
    rows.push({
      id, properties, type: "block", sort_order: 1000 + rows.length,
      workspace_id: "ws-1", created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, rows.length)),
      ...options,
    });
  };
  const projectId = "library-project";
  const date = "2026-11-20";
  add(projectId, { kind: "project", name: "Library QA", status: "active" });
  add("library-facet", {
    kind: "task_facet", name: "Area", scope: "project", projectId, cardinality: "single",
    values: [{ id: "kitchen", name: "Kitchen" }, { id: "outside", name: "Outside" }],
  });
  add("library-view", {
    kind: "task_view", name: "Kitchen work", scope: "open",
    filters: [{ key: "facet:library-facet", op: "in", value: ["kitchen"] }],
  });
  add("library-blocker", {
    kind: "task", local_id: "local-blocker", title: "Buy baseboards", projectId, projectOrder: -3,
    detail: "Measure the kitchen first.", facetValues: { "library-facet": ["kitchen"] },
  });
  add("library-waiting", {
    kind: "backlog", local_id: "local-waiting", title: "Install baseboards", projectId, projectOrder: "-1.5",
    facetValues: { "library-facet": ["kitchen"] },
  });
  add("library-completed", {
    kind: "task", local_id: "local-completed", title: "Choose flooring", projectId, projectOrder: -1.5,
    done: true, completedAt: "2026-11-02T12:00:00Z",
  });
  add("library-fallback", { kind: "task", title: "Order supplies", projectId, projectOrder: null }, { sort_order: 4 });
  add("library-invalid-order", { kind: "task", title: "Book delivery", projectId, projectOrder: "invalid" }, { sort_order: 3 });
  add("library-someday", { kind: "backlog", title: "Visit the salvage shop", someday: true, tags: ["Ideas"] });
  add("library-meeting", { kind: "meeting", type: "oneone", title: "Renovation check-in", start: "09:00", end: "09:30" }, { date });
  add("library-shell", { type: "shell", title: "Renovation work" });
  add("library-responsibility", { kind: "responsibility_task", title: "Check progress" });
  add("library-placeholder", { kind: "placeholder_task", title: "Confirm delivery details" });
  for (const type of ["added_task", "schedule_item", "pending_task", "trivial_task", "action_item", "subtask"]) {
    add("legacy-" + type, { text: "Legacy " + type }, { type });
  }
  add("library-dependency", {
    kind: "delegated_item", blockerType: "task", linkedBlockId: "local-waiting", blockerBlockId: "local-blocker",
  });
  add("library-done-dependency", {
    kind: "delegated_item", blockerType: "task", linkedBlockId: "local-waiting", blockerBlockId: "local-completed",
  });
  add("library-deleted-dependency", {
    kind: "delegated_item", blockerType: "task", linkedBlockId: "local-waiting", blockerBlockId: "missing",
  }, { deleted_at: "2026-11-02T00:00:00Z" });

  // Named modern and legacy cases for coercion boundaries in isLibraryTask.
  add("title-null", { kind: "task", title: null, text: "Null fallback" });
  add("title-empty", { kind: "task", title: "", text: "Empty fallback" });
  add("title-false", { kind: "task", title: false, text: "False fallback" });
  add("title-whitespace", { kind: "task", title: " \t\u00a0", text: "Whitespace suppresses fallback" });
  add("title-missing", { kind: "task" });
  add("text-whitespace", { kind: "task", text: "\uFEFF\n" });
  add("title-number", { kind: "task", title: 42 });
  add("title-true", { kind: "task", title: true });
  add("title-array-empty", { kind: "task", title: [], text: "Truthy empty array suppresses fallback" });
  for (const [name, local_id] of Object.entries({
    null: null, false: false, zero: 0, empty: "", stringZero: "0", stringFalse: "false",
    whitespace: " ", number: 42, true: true, array: [], object: {},
  })) {
    add("alias-" + name, { title: "Alias " + name, local_id });
  }
  add("alias-missing", { title: "Missing alias" });
  add("props-json-null", null);
  add("props-json-string", JSON.stringify({ kind: "task", text: "Encoded legacy task" }));
  add("artifact-unknown-type", { title: "Unsupported type", local_id: "unknown" }, { type: "other" });

  for (const kind of [
    "meeting_prep", "meeting_transcript", "meeting_summary", "proposed_action_item", "task_group",
    "reschedule_tombstone", "slack_reaction_tombstone", "slack_done_intent", "triage_suppression",
    "anytime_item", "responsibility", "responsibility_definition",
  ]) {
    // Titles and local IDs alone must never turn these artifacts into candidates.
    add("artifact-" + kind, { kind, title: "Artifact " + kind, local_id: "legacy-id" });
  }
  add("artifact-day-root", { kind: "task", title: "Day container" }, { type: "day_root" });
  add("artifact-time-entry", { kind: "task", title: "Time segment" }, { type: "time_entry" });
  add("library-deleted", { kind: "task", title: "Deleted task" }, { deleted_at: "2026-11-02T00:00:00Z" });
  add("library-foreign", { kind: "task", local_id: "local-blocker", title: "Foreign task" }, { workspace_id: "ws-2" });
  add("library-third-workspace", { kind: "task", title: "Third workspace task" }, { workspace_id: "ws-3" });
  add("artifact-third-workspace", { kind: "meeting_transcript", title: "Third workspace transcript" }, { workspace_id: "ws-3" });
  add("library-unscoped", { kind: "task", title: "Unscoped task" }, { workspace_id: null });

  for (let i = 0; i < 950; i++) {
    add("bulk-task-" + i, { kind: "task", title: "Fixture task " + i, detail: "Synthetic task notes. ".repeat(96) });
  }
  for (let i = 0; i < 1950; i++) {
    const kind = ["meeting_transcript", "meeting_prep", "meeting_summary", "proposed_action_item"][i % 4];
    add("artifact-bulk-" + i, {
      kind, title: "Fixture artifact " + i, document: "Synthetic meeting material. ".repeat(65),
    });
  }
  const segments = 4249 - rows.filter(row => row.workspace_id === "ws-1" && !row.deleted_at).length;
  for (let i = 0; i < segments; i++) {
    add("artifact-segment-" + i, { title: "Fixture segment " + i, minutes: 5 }, { type: "time_entry" });
  }

  await pool.query(`
    INSERT INTO workspaces(id, name, slug, owner_id, created_at, updated_at)
    VALUES ('ws-3', 'Third review', 'third-review', 3, NOW(), NOW())
  `);
  await pool.query(`
    INSERT INTO blocks (id, type, date, properties, sort_order, created_at, updated_at, deleted_at, user_id, workspace_id)
    SELECT id, type, date, COALESCE(properties, 'null'), sort_order, created_at, created_at, deleted_at,
           CASE workspace_id WHEN 'ws-1' THEN 1 WHEN 'ws-2' THEN 2 WHEN 'ws-3' THEN 3 END, workspace_id
    FROM jsonb_to_recordset($1::jsonb) AS fixture(
      id text, type text, date date, properties jsonb, sort_order double precision, created_at timestamptz,
      deleted_at timestamptz, workspace_id text
    )
  `, [JSON.stringify(rows)]);
  await pool.query("ANALYZE blocks");
}

module.exports = { seedTaskLibrary };
