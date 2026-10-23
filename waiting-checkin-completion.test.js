const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const delegated = fs.readFileSync(require.resolve("./public/js/delegated.js"), "utf8");
const schedule = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
const slots = fs.readFileSync(require.resolve("./public/js/slots.js"), "utf8");
const taskModel = require("./public/js/task-model.js");
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
    window: { innerWidth: mobile ? 375 : 1200, DCC: { TaskModel: taskModel, overlay: { open(options) {
      const handle = { el: { querySelectorAll: () => [...controls.values()] }, close(reason) { if (options.canClose()) options.onClose(reason); } };
      overlays.push({ options, handle }); return handle;
    } } } },
    _checkInPrompt: null, _savingCheckIns: new Set(),
    getDelegatedItemById: id => id === item.id ? item : null, isOpenDelegated: row => row.properties.status === 'open',
    cycleKey: () => 'waiting:w1:2026-10-12', todayStr: () => '2026-10-12',
    parseLocalDate: value => new Date(value + 'T12:00:00'), checkInDaysFor: () => 7,
    toDateInputValue: date => date.toISOString().slice(0, 10), esc: String, closeDelegatedModal() {},
    checkInItemId: ev => ev && ev.source === 'waiting-checkin' ? ev.delegatedItemId || '' : null,
    postWaitingAction: async (...args) => { requests.push(args); if (result instanceof Error) throw result; return typeof result === 'function' ? result(...args) : result; },
    completeCheckInCycle: async (...args) => { requests.push(args); return result; }, afterWaitingAction: async () => {},
    toast: (...args) => notices.push(args), console,
  });
  vm.runInContext(promptSource, context);
  return { context, requests, overlays, controls, form, item, notices };
}

function completedWork(overrides = {}) {
  return {
    id: 'canonical-work', type: 'added_task', date: '2026-10-11',
    properties: {
      local_id: 'work-occurrence-1', title: 'Finish the actual work', type: 'task', source: 'manual',
      duration: 65, actualMinutes: 42, pointsDurationMinutes: 42, tags: ['writing'],
      responsibilityId: 'responsibility-1', repeatOccurrenceKey: 'occurrence-2026-10-11',
      status: 'done', completedAt: '2026-10-23T01:30:00Z', _completionMutationId: 'waiting:w1:1792719000000',
      ...overrides.properties,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'properties')),
  };
}

// Exercise the existing award adapter, durable queue and earn payload rather
// than accepting an isolated spy call as evidence that ordinary credit lands.
function installRewards(h, { missing = false } = {}) {
  const storage = new Map(), requests = [], ledger = new Map();
  const faults = [];
  Object.assign(h.context, {
    viewDate: '2026-10-23', __state: { date: '2026-10-23' }, scheduled: [], doneAt: {},
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    AWARD_QUEUE_KEY: 'pa-slot-award-queue', readAwardQueue: () => JSON.parse(storage.get('pa-slot-award-queue') || '[]'),
    loadSlots: async () => {}, pointLabel: value => String(value), showToast: () => {},
    api: async (url, init) => {
      assert.equal(url, '/api/slot/earn-task');
      const body = JSON.parse(init.body); requests.push(body);
      const fault = faults.shift();
      if (fault === 'before') throw new Error('offline before credit');
      const awarded = !ledger.has(body.source_key);
      if (awarded) ledger.set(body.source_key, body);
      if (fault === 'after') throw new Error('credit acknowledgement lost');
      return { awarded, credits: awarded ? 42 : 0 };
    },
  });
  h.context.window.__state = h.context.__state;
  vm.runInContext(fs.readFileSync(require.resolve('./public/js/points.js'), 'utf8'), h.context);
  vm.runInContext(region(schedule, 'function awardSlotTaskCredit(', '\n// Mark every subtask'), h.context);
  vm.runInContext(region(slots, '  function writeAwardQueue(', '  async function syncCompletedTaskCredits('), h.context);
  vm.runInContext(region(slots, '  function taskDurationMinutes(', '  // How recent a completion'), h.context);
  const connect = () => { h.context.window.SlotRewards = { earnTaskCredit: h.context.earnTaskCredit }; };
  if (!missing) connect();
  return { storage, requests, ledger, faults, connect };
}

function chooseTask(h) {
  const pending = h.context.completeCheckInTask({ id: 'reminder', _blockId: 'reminder-row', source: 'waiting-checkin', delegatedItemId: 'w1' });
  h.controls.get('[name="wci-outcome"]:checked').value = 'task';
  h.form.listeners.change();
  return pending;
}
const submitPrompt = h => h.form.listeners.submit({ preventDefault() {} });
const drainRewards = () => new Promise(resolve => setImmediate(resolve));

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

test("Complete task credits canonical off-view and undated work, never the reminder or viewed day", async () => {
  for (const date of ['2026-10-11', '2026-10-25', null]) {
    const actualWork = completedWork({ date });
    const h = harness({ result: { status: 'completed', actualWork, actualWorkCreditDate: date || '2026-10-22' } });
    const rewards = installRewards(h);
    const pending = chooseTask(h);
    await submitPrompt(h); await drainRewards();
    assert.equal(await pending, 'task_completed');
    assert.equal(rewards.ledger.size, 1);
    const credit = rewards.requests[0];
    assert.equal(credit.task_id, 'work-occurrence-1');
    assert.equal(credit.source_key, (date || '2026-10-22') + ':work-occurrence-1');
    assert.equal(credit.title, 'Finish the actual work');
    assert.equal(credit.duration_minutes, 65);
    assert.equal(credit.actual_minutes, 42);
    assert.equal(credit.points_duration_minutes, 42);
    assert.equal(credit.completed_at, actualWork.properties.completedAt);
    assert.equal(credit.responsibility, true);
    assert.deepEqual(credit.tags, ['writing']);
    assert.equal(h.context.scheduled.length, 0, 'off-view work does not depend on the itinerary fold');
  }
});

test("completed work uses the normal durable award queue when rewards have not loaded", async () => {
  const actualWork = completedWork();
  const h = harness({ result: { status: 'completed', actualWork } });
  const rewards = installRewards(h, { missing: true });
  const pending = chooseTask(h);
  await submitPrompt(h);
  assert.equal(await pending, 'task_completed');
  const queued = JSON.parse(rewards.storage.get('pa-slot-award-queue'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].task.id, actualWork.properties.local_id);
  assert.equal(queued[0].task._blockId, actualWork.id);
  assert.equal(queued[0].task.repeatOccurrenceKey, actualWork.properties.repeatOccurrenceKey);
  assert.equal(queued[0].options.sourceDate, actualWork.date);
  rewards.connect();
  await h.context.flushTaskCreditQueue();
  assert.equal(rewards.ledger.size, 1);
  assert.equal(JSON.parse(rewards.storage.get('pa-slot-award-queue')).length, 0);
});

test("cleanup retries and a lost award acknowledgement keep a single ordinary credit", async () => {
  for (const fault of [undefined, 'before', 'after']) {
    let attempt = 0;
    const actualWork = completedWork();
    const h = harness({ result: () => ({ status: 'completed', actualWork, cleanupPending: ++attempt === 1, duplicate: attempt > 1 }) });
    const rewards = installRewards(h);
    if (fault) rewards.faults.push(fault);
    const pending = chooseTask(h);
    await submitPrompt(h); await drainRewards();
    assert.equal(h.controls.get('[type="submit"]').textContent, 'Retry cleanup');
    assert.equal(rewards.ledger.size, fault === 'before' ? 0 : 1);
    h.context.viewDate = '2026-10-24';
    await submitPrompt(h); await drainRewards();
    assert.equal(await pending, 'task_completed');
    await h.context.flushTaskCreditQueue();
    assert.equal(rewards.ledger.size, 1);
    assert.ok(rewards.requests.every(row => row.source_key === '2026-10-11:work-occurrence-1'));
    assert.deepEqual(h.requests[0], h.requests[1], 'cleanup retry keeps the original completion intent');
  }
});

test("lost completion acknowledgement awards only after canonical replay confirms persistence", async () => {
  let attempt = 0;
  const h = harness({ result: () => {
    if (++attempt === 1) throw new Error('completion acknowledgement lost');
    return { status: 'completed', duplicate: true, actualWork: completedWork() };
  } });
  const rewards = installRewards(h);
  const pending = chooseTask(h);
  await submitPrompt(h); await drainRewards();
  assert.equal(rewards.requests.length, 0);
  await submitPrompt(h); await drainRewards();
  assert.equal(await pending, 'task_completed');
  assert.equal(rewards.ledger.size, 1);
  assert.deepEqual(h.requests[0], h.requests[1]);
});

test("reminder-only completion and standalone Waiting work never earn ordinary task credit", async () => {
  const checkIn = harness({ result: { status: 'completed', actualWork: completedWork() } });
  const checkInRewards = installRewards(checkIn);
  const checkedIn = checkIn.context.completeCheckInTask({ id: 'reminder', source: 'waiting-checkin', delegatedItemId: 'w1' });
  await submitPrompt(checkIn); await drainRewards();
  assert.equal(await checkedIn, true);
  assert.equal(checkInRewards.requests.length, 0, 'the check-in outcome never calls the work award path');

  const standalone = harness({ result: { status: 'completed', actualWork: null, task: completedWork(), item: { id: 'w1' } } });
  const standaloneRewards = installRewards(standalone);
  const completed = chooseTask(standalone);
  await submitPrompt(standalone); await drainRewards();
  assert.equal(await completed, 'task_completed');
  assert.equal(standaloneRewards.requests.length, 0, 'no fallback to the legacy task field or Waiting item');
});

test("stale, reopened, newer, reminder and log receipts cannot award old work", async () => {
  const h = harness(); const rewards = installRewards(h);
  const rejected = [
    { status: 'skipped_stale', actualWork: completedWork() },
    { status: 'completed', pending: true, actualWork: completedWork() },
    { status: 'completed', actualWork: null },
    { status: 'completed', actualWork: completedWork({ properties: { status: 'open' } }) },
    { status: 'completed', actualWork: completedWork({ deleted_at: '2026-10-24T00:00:00Z' }) },
    { status: 'completed', actualWork: completedWork({ properties: { _completionMutationId: '' } }) },
    { status: 'completed', actualWork: completedWork({ properties: { completedAt: null } }) },
    { status: 'completed', actualWork: completedWork({ properties: { source: 'waiting-checkin' } }) },
    { status: 'completed', actualWork: completedWork({ properties: { source: 'waiting-checkin-log' } }) },
    { status: 'completed', actualWork: completedWork({ properties: { source: 'waiting_checkin' } }) },
    { status: 'completed', actualWork: completedWork({ properties: { source: 'waiting_checkin_log' } }) },
    { status: 'completed', actualWork: completedWork({ properties: { local_id: 'waiting-checkin-task:w1:0' } }) },
    { status: 'completed', actualWork: completedWork({ properties: { kind: 'delegated_item' } }) },
    { status: 'completed', actualWork: completedWork({ type: 'time_entry' }) },
    { status: 'completed', actualWork: completedWork({ properties: { _completionMutationId: 'newer-completion' } }), item: { properties: { waitingCompletionMutationId: 'original-completion' } } },
  ];
  for (const result of rejected) h.context.awardCompletedWaitingTask(result);
  await drainRewards();
  assert.equal(rewards.requests.length, 0);
});

test("later ordinary reconciliation and repeated cleanup share the same date-occurrence credit", async () => {
  const actualWork = completedWork();
  const h = harness(); const rewards = installRewards(h);
  h.context.awardCompletedWaitingTask({ status: 'completed', actualWork });
  await drainRewards();
  h.context.viewDate = actualWork.date;
  h.context.scheduled = [taskModel.fromBlock(actualWork, { deriveEnd: true })];
  h.context.doneAt[actualWork.properties.local_id] = actualWork.properties.completedAt;
  h.context.isDone = () => true;
  h.context.RECONCILE_MAX_AGE_MS = Infinity;
  vm.runInContext(region(slots, '  function _completionMsOf(', '  function init()'), h.context);
  await h.context.reconcileCompletedTaskCredits();
  h.context.awardCompletedWaitingTask({ status: 'completed', duplicate: true, actualWork });
  await drainRewards();
  assert.equal(rewards.requests.length, 3);
  assert.equal(rewards.ledger.size, 1);
  const nextOccurrence = completedWork({ date: '2026-10-25', properties: { repeatOccurrenceKey: 'occurrence-2026-10-25' } });
  h.context.awardCompletedWaitingTask({ status: 'completed', actualWork: nextOccurrence });
  await drainRewards();
  assert.equal(rewards.ledger.size, 2, 'another dated occurrence is not collapsed into the prior award');
});

test("canonical subtask shares preserve explicit zero without borrowing another row or date's override", async () => {
  for (const variant of ['share', 'zero', 'other-row', 'other-date']) {
    const actualWork = completedWork({ properties: { subtaskOf: 'parent-task' } });
    const h = harness({ result: { status: 'completed', actualWork } });
    const rewards = installRewards(h);
    let overrides = 0;
    h.context._pointAwardOverride = id => { assert.equal(id, actualWork.properties.local_id); overrides++; return variant === 'share' ? 7 : 0; };
    h.context.viewDate = variant === 'other-date' ? '2026-10-23' : actualWork.date;
    h.context.scheduled = [{ id: actualWork.properties.local_id, _blockId: variant === 'other-row' ? 'different-work' : actualWork.id }];
    const pending = chooseTask(h);
    await submitPrompt(h); await drainRewards();
    assert.equal(await pending, 'task_completed');
    assert.equal(overrides, ['share', 'zero'].includes(variant) ? 1 : 0);
    assert.equal(rewards.ledger.size, variant === 'zero' ? 0 : 1, 'an explicit zero must never fall back to ordinary scoring');
    if (variant !== 'zero') {
      assert.equal(rewards.requests[0].task_id, actualWork.properties.local_id);
      assert.equal(rewards.requests[0].points_override, variant === 'share' ? 7 : undefined);
    }
  }
  const actualWork = completedWork({ properties: { subtaskOf: 'canonical-parent' } });
  const h = harness({ result: { status: 'completed', actualWork } });
  const rewards = installRewards(h, { missing: true });
  const pending = chooseTask(h); await submitPrompt(h); await pending;
  assert.equal(JSON.parse(rewards.storage.get('pa-slot-award-queue'))[0].task.subtaskOf, 'canonical-parent');
});
