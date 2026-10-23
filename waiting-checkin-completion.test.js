const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const delegated = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const schedule = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
function region(src, start, end) {
  const a = src.indexOf(start), b = src.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return src.slice(a, b);
}
const promptSource = region(delegated, '  function markDelegatedItemCheckedById(', '  async function snoozeWaitingItem(');
const commitSource = region(schedule, 'async function commitDoneOnDate(', '\n// Completion bonus');
function harness({ mobile = false, result = { status: "completed" } } = {}) {
  const requests = [], notices = [], overlays = [];
  const item = { id: "w1", updated_at: '2026-10-12T00:00:00Z', properties: { status: "open", checkInHistory: [] } };
  const controls = new Map();
  for (const selector of ['[data-wci-cancel]', '[role="alert"]', '[type="submit"]', '#wci-date', '#wci-note', '[name="wci-outcome"]:checked', '[data-wci-followup]', '[data-wci-complete]']) controls.set(selector, { value: selector === '#wci-date' ? '2026-10-21' : '', disabled: false, addEventListener(event, fn) { this[event] = fn; } });
  const form = { listeners: {}, valid: true, reportValidity() { return this.valid; }, querySelector(s) { return controls.get(s); }, querySelectorAll() { return []; }, addEventListener(e, fn) { this.listeners[e] = fn; } };
  const context = vm.createContext({
    Promise, Set, Date, document: { activeElement: {}, getElementById: () => null, createElement: () => form },
    window: { innerWidth: mobile ? 375 : 1200, DCC: { overlay: { open(options) {
      const handle = { el: { querySelectorAll: () => [...controls.values()] }, close(reason) { if (options.canClose()) options.onClose(reason); } };
      overlays.push({ options, handle }); return handle;
    } } } },
    _checkInPrompt: null, _savingCheckIns: new Set(),
    getDelegatedItemById: id => id === item.id ? item : null, isOpenDelegated: row => row.properties.status === 'open',
    cycleKey: () => 'waiting:w1:2026-10-12', todayStr: () => '2026-10-12',
    parseLocalDate: value => new Date(value + 'T12:00:00'), checkInDaysFor: () => 7,
    toDateInputValue: date => date.toISOString().slice(0, 10), esc: String, closeDelegatedModal() {},
    checkInItemId: ev => ev && ev.source === 'waiting-checkin' ? ev.delegatedItemId || '' : null,
    postWaitingAction: async (...args) => { requests.push(args); if (result instanceof Error) throw result; return result; },
    completeCheckInCycle: async (...args) => { requests.push(args); return result; }, afterWaitingAction: async () => {},
    toast: (...args) => notices.push(args), console,
  });
  vm.runInContext(promptSource, context);
  return { context, requests, overlays, controls, form, item, notices };
}

test("check-in completion opens the same prompt without writes; cancel, Escape, and backdrop leave occurrence open", async () => {
  for (const reason of ['cancel', 'escape', 'backdrop']) {
    const h = harness();
    const pending = h.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
    assert.equal(h.requests.length, 0);
    assert.match(h.form.innerHTML, /When should you check in next/);
    assert.match(h.form.innerHTML, /type="date" data-tw-skip[^>]*required min="2026-10-12"/);
    assert.equal(await h.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' }), false, 'double click never opens another prompt');
    h.overlays[0].handle.close(reason);
    assert.equal(await pending, false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.item.properties.status, 'open');
  }
});

test("mobile check-in Save submits the exact occurrence and history revision only once", async () => {
  const h = harness({ mobile: true });
  const pending = h.context.completeCheckInTask({ id: 'local-reminder', _blockId: 'db-reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
  assert.equal(h.overlays[0].options.kind, 'sheet');
  const submit = () => h.form.listeners.submit({ preventDefault() {} });
  h.form.valid = false;
  await submit();
  assert.equal(h.requests.length, 0, 'native invalid date never submits');
  h.form.valid = true;
  await Promise.all([submit(), submit()]);
  assert.equal(await pending, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][3].checkInTaskId, 'db-reminder');
  assert.equal(h.requests[0][3].expectedCheckInCount, 0);
  assert.equal(h.requests[0][3].nextCheckInDate, '2026-10-21');
});

test("remote cycle conflict and missing parent never complete the occurrence; real work bypasses prompt", async () => {
  const h = harness({ result: { status: 'skipped_stale' } });
  assert.equal(h.context.completeCheckInTask({ id: 'real', source: 'waiting-unblock', delegatedItemId: 'w1' }), null);
  assert.equal(await h.context.completeCheckInTask({ id: 'gone', source: 'waiting-checkin', delegatedItemId: 'missing' }), false);
  const pending = h.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
  await h.form.listeners.submit({ preventDefault() {} });
  assert.equal(await pending, false);
  assert.equal(h.requests.length, 1, 'conflict never silently retries another cycle');
});

test("canonical completion intercepts reminders on any viewed day before optimistic writes and offline completion queue", async () => {
  for (const date of ['2026-10-11', '2026-10-12', '2026-10-13']) {
    const h = harness();
    const ev = { id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' };
    Object.assign(h.context, { viewDate: date, scheduled: [], __state: {}, manualDone: new Set(), doneAt: {} });
    h.context.window.DCC.Waiting = { completeCheckInTask: h.context.completeCheckInTask };
    vm.runInContext(commitSource, h.context);
    const pending = h.context.commitDoneOnDate(ev.id, date, { ev });
    assert.equal(h.overlays.length, 1);
    assert.equal(h.context.manualDone.size, 0);
    h.overlays[0].handle.close('cancel');
    assert.equal(await pending, false);
    assert.equal(h.context.manualDone.size, 0);
  }
});

test("primary task checkbox routes reminders to Checked in before any normal completion path", async () => {
  const toggleSource = region(schedule, 'function toggleDone(id,opts){', '\n// ');
  const h = harness();
  const ev = { id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' };
  Object.assign(h.context, { scheduled: [ev], manualDone: new Set(), doneAt: {} });
  h.context.window.DCC.Waiting = { completeCheckInTask: h.context.completeCheckInTask };
  vm.runInContext(toggleSource, h.context);
  const pending = h.context.toggleDone(ev.id);
  assert.equal(h.overlays.length, 1);
  assert.equal(h.context.manualDone.size, 0);
  h.overlays[0].handle.close('escape');
  assert.equal(await pending, false);
  assert.equal(h.requests.length, 0);
});

test("triage check-in cancellation leaves suppression, dismissal, and reward untouched; Save resolves them", async () => {
  const triage = fs.readFileSync(require.resolve('./public/js/triage.js'), 'utf8');
  const src = region(triage, 'async function dismissTriage(', '\n// ── Durable triage');
  for (const saved of [false, true, 'task_completed']) {
    const writes = [], rewards = [], dismissed = {};
    const context = vm.createContext({
      _triageSuppressionInFlight: new Set(), INIT_TRIAGE: [{ id: 'triage1', waiting_item_id: 'w1', waiting_cycle_key: 'waiting:w1:2026-10-12' }],
      loadDismissed: () => dismissed, saveDismissed() {}, __state: {}, Date,
      window: { DCC: { Waiting: { completeCheckIn: async id => { assert.equal(id, 'w1'); return saved; } } }, SlotRewards: { earnTaskCredit: task => rewards.push(task) } },
      persistTriageSuppression: async () => { writes.push('suppression'); return {}; }, triageTaskPayload: item => item,
      closeDismissModal() {}, buildTriage() {},
    });
    const fn = vm.runInContext('(' + src + ')', context);
    assert.equal(await fn('triage1'), !!saved);
    assert.equal(writes.length, saved === true ? 1 : 0);
    assert.equal(rewards.length, saved === true ? 1 : 0);
    assert.equal(Object.keys(dismissed).length, saved === true ? 1 : 0);
    assert.equal(context._triageSuppressionInFlight.size, 0);
  }
});


test("Complete task uses canonical action once, with the captured revision and no check-in fields", async () => {
  const h = harness();
  const pending = h.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
  h.controls.get('[name="wci-outcome"]:checked').value = 'task';
  h.form.listeners.change();
  const capturedVersion = h.item.updated_at;
  h.item.updated_at = '2026-10-12T01:00:00Z';
  assert.equal(h.controls.get('#wci-date').required, false);
  assert.equal(h.controls.get('#wci-date').disabled, true);
  const submit = () => h.form.listeners.submit({ preventDefault() {} });
  await Promise.all([submit(), submit()]);
  assert.equal(await pending, 'task_completed');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][1], 'complete');
  assert.equal(h.requests[0][2].expectedUpdatedAt, capturedVersion);
  assert.equal(h.requests[0][2].resolveBlockedTask, true);
  assert.equal(h.requests[0][2].nextCheckInDate, undefined);
});

test("failed actual completion retains the dialog and retries the identical intent", async () => {
  const h = harness({ result: new Error('connection lost') });
  h.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
  h.controls.get('[name="wci-outcome"]:checked').value = 'task'; h.form.listeners.change();
  await h.form.listeners.submit({ preventDefault() {} });
  assert.match(h.controls.get('[role="alert"]').textContent, /Retry safely/);
  await h.form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.equal(h.controls.get('#wci-date').disabled, true);
  h.overlays[0].handle.close('cancel');
});

test("cleanup can be retried from a leftover itinerary reminder after reload without reopening work", async () => {
  const h = harness(); h.item.properties.status = 'done';
  const pending = h.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
  assert.equal(h.controls.get('[type="submit"]').textContent, 'Retry cleanup');
  await h.form.listeners.submit({ preventDefault() {} });
  assert.equal(await pending, 'task_completed');
  assert.equal(h.requests[0][1], 'complete');
});
