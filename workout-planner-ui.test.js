const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const W = require('./public/js/workout-model');
const M = require('./public/js/activity-model');
const clone = value => structuredClone(value);
const source = fs.readFileSync(path.join(__dirname, 'public/js/workout-planner.js'), 'utf8');

// Minimal rendered DOM and API boundary: run the actual controller and event
// handlers, rather than asserting implementation text or opening a browser.
function attributes(text) {
  const result = {};
  for (const match of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) result[match[1]] = match[2] ?? '';
  return result;
}
function element(tag, attrs = {}) {
  const dataset = {};
  for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  return {
    tagName: tag.toUpperCase(), dataset, type: attrs.type || '', value: attrs.value ?? '',
    disabled: Object.hasOwn(attrs, 'disabled'), textContent: '',
    closest(selector) { return selector === '[data-w-act]' && dataset.wAct ? this : null; },
    focus() {}, setSelectionRange() {}
  };
}
class Host {
  constructor() { this.isConnected = true; this.listeners = new Map(); this.nodes = []; this.classList = { add() {} }; }
  set innerHTML(html) {
    this.html = html; this.nodes = [];
    for (const match of html.matchAll(/<(input|select|button|p|span)\b([^>]*)>/g)) {
      const node = element(match[1], attributes(match[2]));
      if (match[1] === 'select') {
        const contents = html.slice(match.index + match[0].length).split('</select>')[0];
        const options = [...contents.matchAll(/<option\b([^>]*)>/g)].map(m => attributes(m[1]));
        node.value = (options.find(o => Object.hasOwn(o, 'selected')) || options[0] || {}).value || '';
      }
      if (match[1] === 'span' || match[1] === 'p') node.textContent = html.slice(match.index + match[0].length).split('</' + match[1] + '>')[0];
      node.attrs = attributes(match[2]); this.nodes.push(node);
    }
  }
  get innerHTML() { return this.html || ''; }
  contains() { return false; }
  closest(selector) { return selector === '.wp-dialog' && this.inDialog ? this : null; }
  addEventListener(type, handler) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); }
  querySelector(selector) {
    if (selector === 'input' || selector === 'select') return this.nodes.find(n => n.tagName === selector.toUpperCase()) || null;
    if (selector === '[role=alert]') return this.nodes.find(n => n.attrs.role === 'alert') || null;
    if (selector === '.wp-status') return this.nodes.find(n => (n.attrs.class || '').split(' ').includes('wp-status')) || null;
    const field = selector.match(/^\[data-w-path="([^"]+)"\]$/);
    if (field) return this.nodes.find(n => n.dataset.wPath === field[1]) || null;
    return null;
  }
  querySelectorAll(selector) { return selector === '[data-w-path]' ? this.nodes.filter(n => n.dataset.wPath) : []; }
  async emit(type, target) {
    const event = { target, stopPropagation() {}, preventDefault() {} };
    if (typeof this['on' + type] === 'function') await this['on' + type](event);
    for (const handler of this.listeners.get(type) || []) await handler(event);
  }
  button(action, extra = {}) { return this.nodes.find(n => n.dataset.wAct === action && Object.entries(extra).every(([k, v]) => n.dataset[k] === v)); }
  async fill(field, value) {
    const node = this.querySelector('[data-w-path="' + field + '"]');
    assert.ok(node, 'Rendered field: ' + field); node.value = String(value);
    await this.emit('input', node);
  }
}
function record() {
  const value = W.empty();
  value.plan.exercises = [{ id: 'bench-entry', catalogExerciseId: 'bench-press', name: 'Bench Press', sets: [1, 2].map(round => ({ id: 'target-' + round, round, reps: 8, weight: 135, unit: 'lb', seconds: null, loadMode: 'total', repsMode: 'total' })) }];
  value.plan.groups = [{ id: 'bench-group', kind: 'single', rounds: 2, exerciseIds: ['bench-entry'] }];
  value.plan.runs = [{ id: 'run-plan', name: 'Run', distance: 1, unit: 'mi', seconds: 600 }];
  return W.validate(value);
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function harness(initialRecord = record()) {
  const state = { row: { taskId: 'task-1', title: 'Synthetic workout', date: '2026-10-13', revision: 1, archived: false, removed: false, canUndo: false, record: clone(initialRecord) }, templates: [], failNext: null, uncertainNext: false, putGate: null };
  const requests = [], mutations = new Map(), modals = [];
  const D = {
    esc: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    dates: { todayKey: () => '2026-10-13', addDays: () => '2025-10-13' },
    Activity: { refresh() {} }, toast() {},
    async api(url, options = {}) {
      const method = options.method || 'GET', body = options.body ? clone(options.body) : null;
      requests.push({ url, method, body });
      if (url === '/api/activity/tasks/task-1' && method === 'GET') return clone(state.row);
      if (url === '/api/activity/exercises') return { exercises: clone(W.CATALOG) };
      if (url === '/api/activity/tasks/task-2' && method==='GET') return {...clone(state.row),taskId:'task-2'};
      if (url === '/api/activity/templates' && method === 'GET') {
        if (state.templateRefreshFailNext) { state.templateRefreshFailNext = false; throw new Error('Library unavailable'); }
        return { templates: clone(state.templates) };
      }
      if (url.startsWith('/api/activity/templates') && ['POST', 'PUT'].includes(method)) {
        if (state.templateGate) await state.templateGate.promise;
        if (state.templateFailNext) { const failure = state.templateFailNext; state.templateFailNext = null; throw failure; }
        const current = method === 'PUT' ? state.templates.find(t => url.endsWith('/' + t.id)) : null;
        if (method === 'PUT' && (!current || body.expectedRevision !== current.revision)) throw new Error('Template changed elsewhere');
        const template = { ...body, id: current?.id || 'new-template', revision: (current?.revision || 0) + 1 };
        if (current) Object.assign(current, template); else state.templates.push(template);
        return clone(template);
      }
      if (url.startsWith('/api/activity?')) return { records: [] };
      if (url === '/api/activity/tasks/task-1' && method === 'PUT') {
        if (state.putGate) await state.putGate.promise;
        if (state.failNext) { const failure = state.failNext; state.failNext = null; throw failure; }
        if (mutations.has(body.mutationId)) return clone(mutations.get(body.mutationId));
        if (body.expectedRevision !== state.row.revision) throw Object.assign(new Error('Record changed elsewhere'), { statusCode: 409 });
        state.row = { ...state.row, revision: state.row.revision + 1, record: M.validate(body.record), canUndo: true };
        mutations.set(body.mutationId, clone(state.row));
        if (state.uncertainNext) { state.uncertainNext = false; throw new Error('Response lost after commit'); }
        return clone(state.row);
      }
      throw new Error('Unexpected API request: ' + method + ' ' + url);
    },
    modal(options) {
      const previous = modals.at(-1); if (previous && !previous.closed) previous.close('replaced');
      const modal = { ...options, el: { classList: { add(name) { if (name === 'wp-dialog') options.body.inDialog = true; } } }, closed: false,
        close(reason = 'action') { if (this.closed) return; this.closed = true; if (options.body instanceof Host) options.body.isConnected = false; options.onClose?.(reason); },
        async choose(label) {
          const action = options.actions.find(a => a.label === label); assert.ok(action, 'Modal action: ' + label);
          const result = action.onClick ? await action.onClick(modal) : undefined;
          if (result !== false && !action.keepOpen) modal.close('action');
          return result;
        }
      };
      modals.push(modal); return modal;
    }
  };
  const document = { activeElement: null, createElement: () => new Host() };
  vm.runInNewContext(source, { window: { DCC: D, WorkoutModel: W, ActivityModel: M }, document, crypto, performance, structuredClone, URLSearchParams, Date, queueMicrotask: callback => Promise.resolve().then(callback) }, { filename: 'workout-planner.js' });
  await D.Workout.open(clone(state.row));
  const host = modals[0].body, controller = await D.Workout.controller('task-1');
  return {
    state, requests, modals, host, controller,
    editTemplate(template) { D.Workout.editTemplate(template, clone(W.CATALOG), clone(state.templates)); return modals.at(-1).body; },
    getController: () => D.Workout.controller('task-1'),
    controllerApi: id => D.Workout.controller(id),
    puts: () => requests.filter(r => r.method === 'PUT'),
    actualRepsPath: index => host.nodes.filter(n => n.dataset.wPath?.startsWith('drafts.') && n.dataset.wPath.endsWith('.reps'))[index].dataset.wPath,
    async click(action, extra = {}) {
      const node = host.button(action, extra); assert.ok(node, 'Rendered action: ' + action);
      if (node.disabled) return false;
      await host.emit('click', node); return true;
    }
  };
}

test('failed PUT leaves exact retry and reload available while normal writes stay locked', async () => {
  const h = await harness(); h.state.failNext = new Error('Synthetic connection failure');
  await h.click('start');
  assert.ok(h.controller.pending); assert.equal(h.controller.busy, false);
  assert.equal(h.host.button('retry').disabled, false);
  assert.equal(h.host.button('reload').disabled, false);
  assert.equal(h.host.button('start').disabled, true);
  const before = clone(h.controller.pending); await h.click('retry');
  assert.equal(h.controller.pending, null); assert.equal(h.controller.status, 'Synced');
  assert.deepEqual(h.puts()[1].body, before);
});

test('uncertain commit retries the identical mutation, payload and revision without duplicate timing', async () => {
  const h = await harness(); h.state.uncertainNext = true;
  await h.click('start');
  assert.equal(h.state.row.revision, 2); assert.equal(h.state.row.record.session.events.length, 2);
  assert.equal(h.controller.row.revision, 1);
  await h.click('retry');
  assert.equal(h.puts().length, 2); assert.deepEqual(h.puts()[0].body, h.puts()[1].body);
  assert.equal(h.state.row.revision, 2); assert.equal(h.controller.row.revision, 2);
  assert.equal(h.controller.v.session.events.length, 2);
  assert.equal(new Set(h.controller.v.session.events.map(e => e.id)).size, 2);
});

test('reload can discard a rejected pending action and recover the saved record', async () => {
  const h = await harness(); h.state.failNext = new Error('Offline');
  await h.click('start'); await h.click('reload');
  assert.equal(h.controller.pending, null); assert.equal(h.controller.dirty, false);
  assert.equal(h.controller.v.session.events.length, 0); assert.equal(h.controller.status, 'Synced');
});

test('extra-set validation failure keeps modal and inputs until a valid explicit log succeeds', async () => {
  const h = await harness(); await h.click('extra', { entry: 'bench-entry' });
  const modal = h.modals.at(-1); await modal.body.fill('extra.reps', '1.5');
  assert.equal(await modal.choose('Log extra set'), false);
  assert.equal(modal.closed, false); assert.equal(h.puts().length, 0);
  assert.equal(modal.body.querySelector('[data-w-path="extra.reps"]').value, '1.5');
  await modal.body.fill('extra.reps', '8'); await modal.choose('Log extra set');
  assert.equal(modal.closed, true); assert.equal(h.state.row.record.actual.sets.length, 1);
  assert.equal(h.state.row.record.actual.sets[0].reps, 8);
});

test('run validation failure keeps modal input and creates no actual result', async () => {
  const h = await harness(); await h.click('run', { run: '0' });
  const modal = h.modals.at(-1); await modal.body.fill('seconds', '-1');
  assert.equal(await modal.choose('Log run'), false); assert.equal(modal.closed, false);
  assert.equal(h.puts().length, 0); assert.equal(h.state.row.record.actual.runs.length, 0);
  assert.equal(modal.body.querySelector('[data-w-path="seconds"]').value, '-1');
  await modal.body.fill('seconds', '600'); await modal.choose('Log run');
  assert.equal(modal.closed, true); assert.equal(h.state.row.record.actual.runs[0].seconds, 600);
});

test('stop rejected by server leaves confirmation open and saved running timing intact', async () => {
  const h = await harness(); await h.click('start'); await h.click('stop');
  const modal = h.modals.at(-1); h.state.failNext = Object.assign(new Error('Synthetic timing validation rejection'), { statusCode: 400 });
  assert.equal(await modal.choose('Stop · partial'), false); assert.equal(modal.closed, false);
  assert.equal(W.replay(h.state.row.record).status, 'running');
  assert.equal(h.state.row.record.session.events.length, 2); assert.ok(h.controller.pending);
});

test('task move refreshes first results date without losing unsaved plan or actual drafts', async () => {
  const h = await harness();
  await h.host.fill('plan.exercises.0.sets.0.weight', '225');
  await h.host.fill(h.actualRepsPath(0), '9');
  h.state.row.date = '2026-10-16';
  await h.click('log', { entry: 'bench-entry', target: 'target-1' });
  assert.equal(h.state.row.record.occurredOn, '2026-10-16');
  assert.equal(h.state.row.record.plan.exercises[0].sets[0].weight, 225);
  assert.equal(h.state.row.record.actual.sets[0].reps, 9);
  h.state.row.date = '2026-10-20';
  await h.host.fill(h.actualRepsPath(0), '7');
  await h.click('log', { entry: 'bench-entry', target: 'target-2' });
  assert.equal(h.state.row.record.occurredOn, '2026-10-16');
  assert.equal(h.state.row.record.actual.sets.length, 2);
});

test('in-flight save locks repeated action taps and input mutation until acknowledgement', async () => {
  const h = await harness(); const gate = deferred(); h.state.putGate = gate;
  const oldStart = h.host.button('start'); const saving = h.click('start');
  for (let i = 0; i < 20 && !h.puts().length; i++) await Promise.resolve();
  assert.equal(h.controller.busy, true); assert.equal(h.puts().length, 1);
  assert.equal(h.host.button('start').disabled, true);
  await h.host.emit('click', oldStart);
  await h.host.fill('plan.exercises.0.sets.0.weight', '999');
  assert.equal(h.controller.v.plan.exercises[0].sets[0].weight, 135);
  assert.equal(h.puts().length, 1);
  gate.resolve(); await saving;
  assert.equal(h.controller.busy, false); assert.equal(h.controller.pending, null);
  assert.equal(h.state.row.record.session.events.length, 2);
});

test('cached controller refreshes moved task metadata without replacing local inputs or revision', async () => {
  const h = await harness();
  await h.host.fill('plan.exercises.0.sets.0.weight', '225');
  await h.host.fill(h.actualRepsPath(0), '9');
  h.state.row.date = '2026-10-16'; h.state.row.title = 'Moved workout';
  h.state.row.revision = 2; h.state.row.record.plan.exercises[0].sets[0].weight = 155;
  const cached = await h.getController();
  assert.equal(cached, h.controller); assert.equal(cached.row.date, '2026-10-16');
  assert.equal(cached.row.title, 'Moved workout'); assert.equal(cached.row.revision, 1);
  assert.equal(cached.v.plan.exercises[0].sets[0].weight, 225);
  assert.equal(cached.drafts[h.actualRepsPath(0).split('.')[1]].reps, 9);
});

test('another tab revision blocks overwrite, retaining local drafts until explicit reload', async () => {
  const h = await harness();
  await h.host.fill('plan.exercises.0.sets.0.weight', '225');
  await h.host.fill(h.actualRepsPath(0), '9');
  h.state.row.revision = 2; h.state.row.record.plan.exercises[0].sets[0].weight = 155;
  await h.click('log', { entry: 'bench-entry', target: 'target-1' });
  assert.equal(h.state.row.record.plan.exercises[0].sets[0].weight, 155);
  assert.equal(h.state.row.record.actual.sets.length, 0);
  assert.equal(h.controller.v.plan.exercises[0].sets[0].weight, 225);
  assert.equal(h.controller.pending.expectedRevision, 1);
  assert.equal(h.controller.pending.record.actual.sets[0].reps, 9);
  assert.match(h.controller.error, /changed elsewhere/);
  assert.equal(h.host.button('reload').disabled, false);
  await h.click('reload');
  assert.equal(h.controller.row.revision, 2); assert.equal(h.controller.pending, null);
  assert.equal(h.controller.v.plan.exercises[0].sets[0].weight, 155);
});

test('cancelling extra, run, or stop modal returns to the planner with draft inputs retained', async () => {
  for (const action of ['extra', 'run', 'stop']) {
    const h = await harness();
    await h.host.fill(h.actualRepsPath(0), '9');
    if (action === 'stop') await h.click('start');
    const before = clone(h.controller.drafts);
    await h.click(action, action === 'extra' ? { entry: 'bench-entry' } : action === 'run' ? { run: '0' } : {});
    const confirmation = h.modals.at(-1);
    assert.equal(h.modals[0].closed, true, 'Opening the child replaces the planner modal');
    await confirmation.choose('Cancel');
    for (let i = 0; i < 20 && !h.modals.at(-1).body?.button?.('reload'); i++) await Promise.resolve();
    const reopened = h.modals.at(-1);
    assert.equal(reopened.title, 'Synthetic workout'); assert.equal(reopened.closed, false);
    assert.ok(reopened.body.button('reload')); assert.equal(reopened.body.isConnected, true);
    assert.deepEqual(clone(h.controller.drafts), before);
  }
});

test('successful extra-set confirmation returns to planner showing the acknowledged result', async () => {
  const h = await harness(); await h.click('extra', { entry: 'bench-entry' });
  const modal = h.modals.at(-1); await modal.body.fill('extra.reps', '8');
  assert.equal(await modal.choose('Log extra set'), true);
  for (let i = 0; i < 20 && !h.modals.at(-1).body?.button?.('reload'); i++) await Promise.resolve();
  const reopened = h.modals.at(-1);
  assert.equal(modal.closed, true); assert.equal(reopened.title, 'Synthetic workout');
  assert.equal(reopened.closed, false); assert.ok(reopened.body.button('reload'));
  assert.equal(h.controller.v.actual.sets.length, 1); assert.equal(h.controller.v.actual.sets[0].reps, 8);
  assert.equal(h.controller.history.find(r => r.taskId === 'task-1').record.actual.sets[0].reps, 8);
});

test('extra set in an earlier group does not borrow an unrelated active group round', async () => {
  let value = record(); value.plan.exercises[0].sets = value.plan.exercises[0].sets.slice(0, 1);
  value.plan.groups[0].rounds = 1;
  value.plan.exercises.push({ id: 'curl-entry', catalogExerciseId: 'dumbbell-curls', name: 'Dumbbell Curls', sets: [1, 2].map(round => ({ id: 'curl-target-' + round, round, reps: 8, weight: 10, unit: 'lb', seconds: null, loadMode: 'per-dumbbell', repsMode: 'total' })) });
  value.plan.groups.push({ id: 'curl-group', kind: 'single', rounds: 2, exerciseIds: ['curl-entry'] });
  value = W.action(value, { id: 'start', type: 'start', at: '2026-10-13T10:00:00Z' });
  const sequence = [['bench-start', 'start-round', 'bench-group', 1], ['bench-end', 'finish-round', 'bench-group', 1], ['curl-start-1', 'start-round', 'curl-group', 1], ['curl-end-1', 'finish-round', 'curl-group', 1], ['curl-start-2', 'start-round', 'curl-group', 2]];
  for (let i = 0; i < sequence.length; i++) {
    const [id, type, groupId, round] = sequence[i];
    value = W.action(value, { id, type, groupId, round, at: new Date(Date.parse('2026-10-13T10:00:00Z') + (i + 1) * 1000).toISOString() });
  }
  const h = await harness(value); await h.click('extra', { entry: 'bench-entry' });
  const modal = h.modals.at(-1); await modal.body.fill('extra.reps', '8');
  assert.equal(await modal.choose('Log extra set'), true);
  const actual = h.state.row.record.actual.sets[0];
  assert.equal(actual.exerciseId, 'bench-entry'); assert.equal(actual.round, 1);
  assert.equal(actual.planSetId, null); assert.equal(actual.reps, 8);
});

test('new template is selectable in every existing workout controller without reload', async () => {
 const h=await harness(),second=await h.controllerApi('task-2');
 assert.equal(second.library.length,0);await h.click('template-save');
 assert.equal(h.controller.library.length,1);assert.equal(second.library.length,1);
 assert.equal((await h.controllerApi('task-2')).library[0].id,'new-template');
});

test('card builder duplicates occurrences independently, removes cards and retains explicit rounds',async()=>{
 const h=await harness();await h.click('duplicate-entry',{entry:'bench-entry'});
 assert.equal(h.controller.v.plan.exercises.length,2);const duplicate=h.controller.v.plan.exercises[1];assert.notEqual(duplicate.id,'bench-entry');assert.notEqual(duplicate.sets[0].id,'target-1');
 await h.click('remove-entry',{entry:duplicate.id});assert.equal(h.controller.v.plan.exercises.length,1);assert.equal(h.controller.v.plan.groups.length,1);
 await h.click('group',{kind:'superset'});assert.equal(h.controller.v.plan.groups[1].rounds,1);assert.match(h.host.html,/Draft group/);await h.click('save');assert.match(h.controller.error,/supersets/);assert.equal(h.puts().length,0);
});
test('prompted guidance uses revision-safe saves, preserves side order and recovers paused position',async()=>{
 const v=W.empty();v.plan=W.gentleReset(()=>crypto.randomUUID());const h=await harness(v);
 await h.click('guide-begin');assert.equal(h.state.row.record.guidance.stepIndex,0);assert.ok(h.state.row.record.baseline);
 await h.click('guide-next');assert.equal(h.controller.v.guidance.stepIndex,1);assert.match(h.host.html,/Seated side bend · RIGHT/);
 await h.click('guide-next');assert.match(h.host.html,/Seated side bend · LEFT/);
 await h.click('guide-exit');await h.click('reload');assert.equal(h.controller.v.guidance.status,'paused');assert.equal(h.controller.v.guidance.stepIndex,2);
 await h.click('guide-resume');await h.click('guide-back');assert.equal(h.controller.v.guidance.stepIndex,1);
 h.state.uncertainNext=true;await h.click('guide-next');const payload=clone(h.controller.pending);await h.click('retry');assert.deepEqual(h.puts().at(-1).body,payload);assert.equal(h.controller.v.guidance.stepIndex,2);
 assert.equal(h.controller.v.actual.sets.length,0);assert.equal(h.controller.v.occurredOn,null);assert.equal(h.controller.v.session.events.length,0);
});
test('card actions cannot alter a frozen plan, even through a stale DOM button',async()=>{
 const h=await harness();const old=h.host.button('duplicate-entry',{entry:'bench-entry'});await h.click('guide-begin');const baseline=clone(h.controller.v.plan);await h.host.emit('click',old);assert.deepEqual(h.controller.v.plan,baseline);
});


const templateStatus = host => host.querySelector('.wp-status').textContent;
const saveTemplate = host => host.emit('click', host.button('save'));

test('new blank and example templates remain drafts until an acknowledged save', async () => {
  const h = await harness();
  assert.equal(templateStatus(h.editTemplate(null)), 'Draft · not saved');
  const host = h.editTemplate({ title: 'Gentle Reset', plan: W.gentleReset(crypto.randomUUID) });
  assert.equal(templateStatus(host), 'Draft · not saved');
  await host.fill('templateName', 'My reset');
  assert.equal(templateStatus(host), 'Draft · not saved');
  const gate = deferred(); h.state.templateGate = gate;
  const saving = saveTemplate(host);
  for (let i = 0; i < 20 && !h.requests.some(r => r.method === 'POST'); i++) await Promise.resolve();
  assert.equal(templateStatus(host), 'Saving…');
  assert.match(host.innerHTML, /<fieldset disabled>/);
  await saveTemplate(host);
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  gate.resolve(); await saving;
  assert.equal(templateStatus(host), 'Saved');
  assert.equal(h.state.templates[0].title, 'My reset');
  assert.equal(h.state.templates[0].revision, 1);
});

test('saved template metadata, goals and card actions show unsaved changes across redraws', async () => {
  const h = await harness();
  h.state.templates.push({ id: 'saved-template', revision: 4, title: 'Saved reset', plan: W.gentleReset(crypto.randomUUID) });
  const host = h.editTemplate(clone(h.state.templates[0]));
  assert.equal(templateStatus(host), 'Saved');
  for (const [field, value] of [['templateName', 'Renamed'], ['collection', 'Recovery'], ['variant', 'Easy'], ['plan.exercises.0.suggestedSeconds', '75']]) {
    await host.fill(field, value);
    assert.equal(templateStatus(host), 'Unsaved changes', field);
    await saveTemplate(host); assert.equal(templateStatus(host), 'Saved');
  }
  await host.emit('click', host.button('duplicate-entry'));
  assert.equal(templateStatus(host), 'Unsaved changes');
  await saveTemplate(host);
  assert.equal(templateStatus(host), 'Saved');
  assert.equal(h.state.templates.length, 1);
  assert.equal(h.state.templates[0].revision, 9);
  assert.ok(h.requests.filter(r => r.method === 'PUT').every(r => r.url.endsWith('/saved-template')));
});

test('template validation or server failure shows not saved and keeps the draft for retry', async () => {
  const h = await harness();
  const host = h.editTemplate({ title: 'Draft reset', plan: W.gentleReset(crypto.randomUUID) });
  await host.fill('plan.groups.0.rounds', '0'); await saveTemplate(host);
  assert.equal(templateStatus(host), 'Not saved');
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 0);
  await host.fill('plan.groups.0.rounds', '1');
  h.state.templateFailNext = new Error('Save rejected'); await saveTemplate(host);
  assert.equal(templateStatus(host), 'Not saved');
  assert.match(host.querySelector('[role=alert]').textContent, /Save rejected/);
  assert.equal(host.querySelector('[data-w-path="templateName"]').value, 'Draft reset');
  assert.equal(h.state.templates.length, 0);
  await saveTemplate(host);
  assert.equal(templateStatus(host), 'Saved');
  assert.equal(h.state.templates.length, 1);
});

test('stale template revision keeps unsaved edits and does not overwrite the stored template', async () => {
  const h = await harness();
  h.state.templates.push({ id: 'saved-template', revision: 1, title: 'Original', plan: record().plan });
  const host = h.editTemplate(clone(h.state.templates[0]));
  await host.fill('templateName', 'Local edit'); h.state.templates[0].revision = 2;
  await saveTemplate(host);
  assert.equal(templateStatus(host), 'Not saved');
  assert.equal(h.state.templates[0].title, 'Original');
  assert.equal(host.querySelector('[data-w-path="templateName"]').value, 'Local edit');
});

test('library refresh failure after an acknowledged save keeps saved status and identity', async () => {
  const h = await harness();
  const host = h.editTemplate({ title: 'Draft reset', plan: W.gentleReset(crypto.randomUUID) });
  h.state.templateRefreshFailNext = true; await saveTemplate(host);
  assert.equal(templateStatus(host), 'Saved');
  assert.match(host.querySelector('[role=alert]').textContent, /Template saved, but the library could not refresh/);
  await host.fill('templateName', 'Updated reset'); await saveTemplate(host);
  assert.equal(templateStatus(host), 'Saved');
  assert.equal(h.state.templates.length, 1);
  assert.equal(h.state.templates[0].revision, 2);
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
});
