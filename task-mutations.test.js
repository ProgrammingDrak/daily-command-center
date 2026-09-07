const test = require("node:test");
const assert = require("node:assert/strict");
const { applyCompletionChanges, compareMutationVersion } = require("./lib/task-mutations");

function shuffled(values, seed) {
  const out = [...values];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("completion conflict resolution is stable across 2,000 hostile delivery orders", () => {
  const intents = [];
  for (let version = 1; version <= 100; version++) {
    intents.push({ id: "task-a", completed: version % 3 !== 0, version, completedAt: new Date(1700000000000 + version).toISOString() });
    intents.push({ id: "task-b", completed: version % 4 === 0, version: 1000 + version, completedAt: new Date(1700000100000 + version).toISOString() });
  }
  for (let seed = 1; seed <= 2000; seed++) {
    const { state } = applyCompletionChanges({}, shuffled(intents, seed));
    assert.equal(state.ids.includes("task-a"), true, `task-a seed ${seed}`);
    assert.equal(state.ids.includes("task-b"), true, `task-b seed ${seed}`);
    assert.equal(state.mutations["task-a"], 100);
    assert.equal(state.mutations["task-b"], 1100);
  }
});

test("an old retry cannot resurrect or uncomplete a newer task state", () => {
  const first = applyCompletionChanges({}, [{ id: "t", completed: true, version: 20 }]).state;
  const second = applyCompletionChanges(first, [{ id: "t", completed: false, version: 30 }]).state;
  const replay = applyCompletionChanges(second, [{ id: "t", completed: true, version: 20 }]);
  assert.deepEqual(replay.state.ids, []);
  assert.equal(replay.applied, 0);
  assert.equal(replay.state.mutations.t, 30);
});

test("duplicate completion delivery is idempotent", () => {
  const intent = { id: "t", completed: true, version: 42, completedAt: "2026-08-08T12:00:00.000Z" };
  const once = applyCompletionChanges({}, [intent]);
  const twice = applyCompletionChanges(once.state, [intent]);
  assert.equal(once.applied, 1);
  assert.equal(twice.applied, 0);
  assert.deepEqual(twice.state, once.state);
});

test("reschedule versions classify new, duplicate, stale, and invalid intents", () => {
  assert.equal(compareMutationVersion(100, 101), "new");
  assert.equal(compareMutationVersion(100, 100), "duplicate");
  assert.equal(compareMutationVersion(100, 99), "stale");
  assert.equal(compareMutationVersion(100, 0), "invalid");
});
