const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./public/js/glasses-model');
const Q = require('./public/js/task-queues');
const date = '2026-10-24';
const task = (id, properties = {}, extra = {}) => ({ id, type: 'block', date, sort_order: 1000, properties: { kind: 'task', title: id, start: '09:00', end: '10:00', ...properties }, ...extra });
const root = properties => ({ id: 'day', type: 'day_root', date, properties });
const options = { timeZone: 'America/Los_Angeles', now: new Date('2026-10-24T19:00:00Z') };
const snapshot = blocks => ({ date, blocks, dayState: { schedule: { timeBlocks: [{ id: 'morning', name: 'Morning', start: '06:00', end: '12:00', activeDays: ['sat'] }, { id: 'afternoon', name: 'Afternoon', start: '12:00', end: '18:00', activeDays: ['sat'] }] } } });
const ids = rows => rows.map(r => r.taskId);
test('full itinerary retains nested done/open steps and files untimed completions in the app timezone', () => {
  const s = snapshot([task('parent'), task('done-step', { subtaskOf: 'parent', start: null, done: true }), task('open-step', { subtaskOf: 'parent', start: null }), task('afternoon', { start: '13:00' }), task('done-untimed', { start: null, done: true, completedAt: '2026-10-24T17:30:00Z' }), task('another-day', { start: null, done: true, completedAt: '2026-10-25T17:30:00Z' })]);
  const v = M.project(s, undefined, options);
  assert.deepEqual(v.itinerary.filter(t => t.depth).map(t => [t.taskId, t.completed, t.depth]), [['done-step', true, 1], ['open-step', false, 1]]);
  assert.ok(ids(v.sections.find(g => g.block.id === 'morning').rows).includes('done-untimed'));
  assert.deepEqual(ids(v.sections.find(g => g.block.id === null).rows), ['another-day']);
  assert.equal(v.unplanned.length, 0);
  assert.equal(new Set(ids(v.itinerary)).size, 6);
});
test('pills preserve desktop order, root counts, source-review distinction and saved unscheduled ordering', () => {
  const s = snapshot([root({ _unscheduledOrder: ['u2', 'u1'] }), task('u1', { start: null }), task('u2', { start: null }), task('child', { start: null, subtaskOf: 'u1' }), task('triage', { start: null, triageBlock: true, triageId: 'message' }), task('repeat', { start: null, triageBlock: true, triageId: 'repeat', responsibilityId: 'r1' }), task('done', { start: null, done: true })]);
  const v = M.project(s, undefined, options);
  assert.deepEqual(v.queues.map(q => q.label), ['Triage', 'Loose Ends', 'Waiting', 'Unscheduled', 'Whenever']);
  assert.deepEqual(ids(v.triage), ['triage']);
  assert.deepEqual(ids(v.unplanned), ['u2', 'u1', 'child', 'repeat']);
  assert.equal(v.queues.find(q => q.id === 'unscheduled').count, 3);
  assert.equal(v.queues.find(q => q.id === 'triage').count, 1);
});
test('Whenever uses the same quick-win order as desktop and retains parent nesting', () => {
  const s = snapshot([]);
  s.globals = [task('long', { kind: 'backlog', stage: 'Whenever', duration: 60 }, { date: null }), task('short', { kind: 'backlog', stage: 'Whenever', duration: 5 }, { date: null }), task('child', { kind: 'backlog', stage: 'Whenever', duration: 1, subtaskOf: 'blk-long' }, { date: null }), task('finished', { kind: 'backlog', stage: 'Whenever', done: true }, { date: null })];
  const v = M.project(s, undefined, options);
  assert.deepEqual(ids(v.anytime), ['short', 'long', 'child']);
  assert.equal(v.anytime[2].depth, 1);
  assert.equal(v.queues.find(q => q.id === 'whenever').count, 2);
});
test('Waiting badge counts overdue check-ins, while its list includes open snoozed and dependency rows', () => {
  const waiting = (id, p) => task(id, { kind: 'delegated_item', title: id, ...p }, { date: null });
  const s = snapshot([]);
  s.globals = [waiting('overdue', { checkInDate: '2026-10-23' }), waiting('snoozed', { checkInDate: '2026-10-22', snoozedUntil: '2026-10-25' }), waiting('dependency', { blockerType: 'task', blockerBlockId: 'x', linkedBlockId: 'y' }), waiting('finished', { status: 'done' }), waiting('booked', { checkInDate: '2026-10-23', checkInTaskId: 't', checkInScheduledFor: date })];
  const v = M.project(s, undefined, options);
  const q = v.queues.find(q => q.id === 'waiting');
  assert.equal(q.count, 1); assert.equal(q.rows.length, 4);
  assert.deepEqual(ids(v.queues.find(q => q.id === 'loose').rows), ['waiting:overdue']);
});
test('Loose Ends preserves origin-day completion overlays and deduplicates Waiting review entries', () => {
  const s = snapshot([root({ _dismissed: { dismissed: true }, _triageDeleted: ['deleted'] })]);
  s.globals = [task('wait', { kind: 'delegated_item', checkInDate: '2026-10-22' }, { date: null })];
  s.dayState.triage = { open_items: ['review', 'dismissed', 'deleted', 'suppressed'].map(id => ({ id, title: id })).concat({ id: 'waiting-review', waiting_item_id: 'wait' }), suppressed_items: [{triage_id:'suppressed',reason:'done'}] };
  const carry = { rows: [task('old', { local_id: 'alias' }, { date:'2026-10-20' }), task('open', {}, {date:'2026-10-23'})], overlays: { '2026-10-20': {done:['alias']} } };
  const v = M.project(s, carry, options), q=v.queues.find(q=>q.id==='loose');
  assert.deepEqual(ids(q.rows), ['open','waiting:wait','triage:review']); assert.equal(q.count,3); assert.equal(v.unpreparedSources,1);
});
test('all-day events spanning the viewed day remain visible, empty queues remain explicit', () => {
  const v=M.project(snapshot([task('trip',{all_day:true,all_day_end:'2026-10-26'},{date:'2026-10-23'})]),undefined,options);
  assert.ok(ids(v.itinerary).includes('trip'));
  const empty=M.project(snapshot([]),undefined,options);
  assert.equal(empty.sections.length,2); assert.ok(empty.queues.every(q=>q.count===0&&q.rows.length===0));
});
test('queue filtering is shared with desktop and does not resurrect suppressed source work',()=>{
  assert.deepEqual(Q.activeTriage([{id:'a'},{id:'b'}],{suppressed:{a:{reason:'done'}}}),[{id:'b'}]);
});
test('completion placement converts each timestamp once, even in a large completed day',()=>{
  const original=Intl.DateTimeFormat; let calls=0;
  Intl.DateTimeFormat=new Proxy(original,{construct(target,args){calls++;return Reflect.construct(target,args);}});
  try {
    const rows=Array.from({length:200},(_,i)=>task('done-'+i,{start:null,done:true,completedAt:'2026-10-24T17:00:00Z'}));
    const view=M.project(snapshot(rows),undefined,options);
    assert.equal(view.itinerary.length,200);
    assert.ok(calls<=201,'timezone conversions must remain linear in completed rows');
  } finally {Intl.DateTimeFormat=original;}
});
