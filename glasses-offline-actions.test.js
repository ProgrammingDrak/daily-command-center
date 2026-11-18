const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./public/js/device-views/glasses.js'), 'utf8');
// Execute the production handlers with the adapter's surrounding state controlled.
const handlers = source.slice(source.indexOf('  async function mutate('), source.indexOf('  async function input('));
function harness({ fail = false, signedIn = true } = {}) {
  const calls = [], messages = [];
  const ctx = vm.createContext({
    navigator: { onLine: false }, crypto: require('node:crypto').webcrypto,
    signedIn: () => signedIn, sameAccount: () => signedIn,
    announce: m => messages.push(m), render() {}, updateUndo() {}, renderPreview() {}, reconcile() {},
    refreshSources: async () => {}, nav: { snapshot: () => ({ level: 'select' }) },
    window: {
      DCCWorkingQueue: {
        performTaskAction: async (...args) => { calls.push(args); if (fail) throw new Error('Failed to fetch'); return {}; },
        undoCompletion: async r => { calls.push(['undo', r.taskId]); if (fail) throw new Error('Failed to fetch'); return {}; }
      },
      blockStore: {
        batchOp: async ops => { calls.push(['delete', ops[0].id]); return { ok: false, buffered: true }; }
      }
    }
  });
  vm.runInContext('let pending = false, revision = 0, refreshGeneration = 0, preview = null; let undo = { action: "complete", taskId: "task-1" };' + handlers, ctx);
  return { calls, messages, mutate: action => vm.runInContext('mutate(' + JSON.stringify(action) + ', { actionId: "task-1", title: "Example", kind: "task" })', ctx), undo: () => vm.runInContext('undoTaskAction()', ctx) };
}
test('glasses completion attempts canonical action despite offline flag', async () => {
  const h = harness(); await h.mutate('complete');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'complete');
  assert.equal(h.messages.at(-1), 'Completed Example.');
});
test('glasses undo attempts canonical action despite offline flag', async () => {
  const h = harness(); await h.undo();
  assert.deepEqual(h.calls, [['undo', 'task-1']]);
  assert.equal(h.messages.at(-1), 'Completion undone.');
});
test('unreachable DCC never claims completion or undo succeeded', async () => {
  for (const operation of ['mutate', 'undo']) {
    const h = harness({ fail: true }); await h[operation]('complete');
    assert.equal(h.calls.length, 1);
    assert.match(h.messages.at(-1), /not confirmed: Failed to fetch/i);
  }
});
test('glasses deletion reports the canonical durable retry result', async () => {
  const h = harness(); await h.mutate('delete');
  assert.deepEqual(h.calls, [['delete', 'task-1']]);
  assert.equal(h.messages.at(-1), 'Deletion queued for retry.');
});
test('signed-out glasses cannot submit actions or undo', async () => {
  const h = harness({ signedIn: false }); await h.mutate('complete'); await h.undo();
  assert.equal(h.calls.length, 0);
});
