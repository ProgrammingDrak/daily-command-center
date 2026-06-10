const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateServiceCreateItem,
  validateServicePatchBody,
} = require("./service-task-policy");

function taskProps(overrides = {}) {
  return {
    kind: "chat_action",
    status: "open",
    title: "Follow up from chat",
    source: "codex-chat",
    source_id: "chat:abc",
    created_by: "dcc-task-ops",
    idempotency_key: "chat:abc:1",
    ...overrides,
  };
}

test("service create accepts allowed task/action fields", () => {
  const item = validateServiceCreateItem({
    type: "block",
    date: "2026-06-03",
    properties: taskProps({ duration: 25, priority: "High" }),
  });

  assert.equal(item.type, "block");
  assert.equal(item.properties.kind, "chat_action");
  assert.equal(item.properties.idempotency_key, "chat:abc:1");
});

test("service create accepts Sweep Suite metadata idempotency provenance", () => {
  const item = validateServiceCreateItem({
    type: "block",
    date: "2026-06-03",
    properties: {
      kind: "sweep_suite_task",
      title: "Sweep task",
      source: "sweep-suite",
      source_id: "gmail:1",
      metadata: {
        created_by: "write-dcc-task",
        idempotency_key: "sweep:gmail:1",
      },
    },
  });

  assert.equal(item.properties.created_by, "write-dcc-task");
  assert.equal(item.properties.idempotency_key, "sweep:gmail:1");
});

test("service create rejects missing idempotency", () => {
  assert.throws(
    () => validateServiceCreateItem({ type: "block", properties: taskProps({ idempotency_key: "" }) }),
    /idempotency_key/
  );
});

test("service create rejects unsupported kind and fields", () => {
  assert.throws(
    () => validateServiceCreateItem({ type: "block", properties: taskProps({ kind: "calendar_event" }) }),
    /allowed kind/
  );
  assert.throws(
    () => validateServiceCreateItem({ type: "block", properties: taskProps({ secret: "nope" }) }),
    /cannot mutate property: secret/
  );
});

test("service patch allows completion fields on an existing task", () => {
  const existing = {
    id: "task-1",
    properties: taskProps({ status: "open", unknown_readonly: "kept" }),
  };
  const patch = validateServicePatchBody(existing, {
    idempotency_key: "complete:task-1",
    properties: {
      ...existing.properties,
      status: "done",
      completed: true,
      done: true,
      completedAt: "2026-06-03T18:00:00Z",
      doneAt: "2026-06-03T18:00:00Z",
      completionNotes: "Verified in DCC.",
      evidence: [{ type: "note", text: "Codex completed the work." }],
    },
  });

  assert.equal(patch.properties.status, "done");
  assert.equal(patch.properties.unknown_readonly, "kept");
});

test("service patch rejects changed non-task fields", () => {
  const existing = {
    id: "task-1",
    properties: taskProps({ foreign_field: "original" }),
  };
  assert.throws(
    () => validateServicePatchBody(existing, {
      idempotency_key: "complete:task-1",
      properties: { ...existing.properties, foreign_field: "changed" },
    }),
    /cannot mutate property: foreign_field/
  );
});

test("service batch child create accepts subtask action fields", () => {
  const item = validateServiceCreateItem({
    op: "create",
    id: "subtask-1",
    type: "block",
    parent_id: "task-1",
    date: "2026-06-03",
    properties: {
      id: "subtask-1",
      kind: "task",
      status: "open",
      title: "Check source evidence",
      text: "Check source evidence",
      parent_task_id: "task-1",
      source: "codex-chat",
      source_id: "chat:abc",
      created_by: "dcc-task-ops",
      idempotency_key: "subtask:task-1:1",
    },
  });

  assert.equal(item.properties.parent_task_id, "task-1");
  assert.equal(item.properties.text, "Check source evidence");
});

test("service create accepts task classification and point tier fields", () => {
  const item = validateServiceCreateItem({
    type: "block",
    date: "2026-06-03",
    properties: taskProps({
      title: "Lunch",
      type: "break",
      point_tier: "none",
      point_multiplier: 0,
    }),
  });

  assert.equal(item.properties.type, "break");
  assert.equal(item.properties.point_tier, "none");
  assert.equal(item.properties.point_multiplier, 0);
});
