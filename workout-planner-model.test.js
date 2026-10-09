const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./public/js/workout-model');
const A = require('./public/js/activity-model');
const copy = x => structuredClone(x);
const at = seconds => new Date(Date.UTC(2026, 9, 13, 10, 45, seconds)).toISOString();
function target(id, round = 1, extra = {}) {
  return {id, round, reps:8, weight:100, unit:'lb', seconds:null, loadMode:'total', repsMode:'total', ...extra};
}
function workout() {
  const v = W.empty();
  v.plan.exercises = [
    {id:'entry-bench-a',catalogExerciseId:'bench-press',name:'Bench Press',sets:[target('a-1'),target('a-2',2,{reps:6,weight:110})]},
    {id:'entry-bench-b',catalogExerciseId:'bench-press',name:'Bench Press',sets:[target('b-1'),target('b-2',2)]}
  ];
  v.plan.groups = [
    {id:'group-a',kind:'single',rounds:2,exerciseIds:['entry-bench-a']},
    {id:'group-b',kind:'single',rounds:2,exerciseIds:['entry-bench-b']}
  ];
  return v;
}
function actual(id='actual-1', extra={}) {
  return {id, exerciseId:'entry-bench-a',planSetId:'a-1',round:1,status:'logged',loggedAt:at(20),reps:8,weight:100,unit:'lb',seconds:null,loadMode:'total',repsMode:'total',...extra};
}
function logged(extra={}) {
  const v=workout();v.occurredOn='2026-10-13';v.actual.sets=[actual('actual-1',extra)];return v;
}
function event(id,type,seconds,extra={}) {return {id,type,at:at(seconds),...extra};}
function start(v=workout()) {return W.action(v,event('start','start',0));}
function row(record,extra={}) {return {taskId:'task-1',title:'Strength Training',date:'2026-10-13',completed:false,removed:false,archived:false,record,...extra};}
function parseCSV(text) {
  const lines=text.split('\r\n').map(line=>{
    const values=[];let value='',quoted=false;
    for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){values.push(value);value='';}else value+=c;}
    values.push(value);return values;
  });
  const header=lines.shift();return lines.map(values=>Object.fromEntries(header.map((k,i)=>[k,values[i]])));
}

test('v1 validation preserves freeform identity and history without catalog remapping',()=>{
  const v=A.empty('workout');v.plan.exercises=[{id:'legacy-id',name:'  Bench press (my variation)  ',sets:[{id:'legacy-set',reps:7,weight:42,unit:'kg'}]}];
  v.actual.sets=[{id:'legacy-result',exerciseId:'legacy-id',planSetId:'legacy-set',reps:6,weight:42,unit:'kg'}];v.occurredOn='2026-10-08';
  const before=copy(v);const validated=A.validate(v);const upgraded=W.upgrade(validated);
  assert.deepEqual(v,before);assert.equal(validated.schemaVersion,1);assert.equal(upgraded.schemaVersion,2);
  assert.equal(upgraded.plan.exercises[0].id,'legacy-id');assert.equal(upgraded.plan.exercises[0].catalogExerciseId,null);
  assert.equal(upgraded.plan.exercises[0].name,'Bench press (my variation)');assert.equal(upgraded.actual.sets[0].loggedAt,null);
  assert.equal(upgraded.actual.sets[0].reps,6);assert.equal(upgraded.actual.sets[0].weight,42);assert.equal(upgraded.session.events.length,0);
});
test('v1 empty actual rows do not count; explicit zero still counts',()=>{
  const v=A.empty('workout');v.plan.exercises=[{id:'old',name:'Bench Press',sets:[]}];
  v.actual.sets=[{id:'blank',exerciseId:'old',planSetId:null,reps:null,weight:null,unit:'lb'}];
  assert.equal(A.hasActual(A.validate(v)),false);assert.equal(W.upgrade(A.validate(v)).actual.sets.length,0);
  v.actual.sets[0].reps=0;v.occurredOn='2026-10-08';assert.equal(A.hasActual(A.validate(v)),true);
});
test('catalog seed has friendly names, canonical IDs, and dumbbell load convention',()=>{
  assert.deepEqual(W.CATALOG.map(e=>e.name),['Bench Press','Dumbbell Curls','Overhead Barbell Press']);
  assert.equal(new Set(W.CATALOG.map(e=>e.id)).size,3);assert.equal(W.CATALOG.find(e=>e.id==='dumbbell-curls').loadMode,'per-dumbbell');
});
test('repeated canonical exercise keeps two distinct local entries and independent targets',()=>{
  const v=W.validate(workout());assert.equal(v.plan.exercises[0].catalogExerciseId,v.plan.exercises[1].catalogExerciseId);
  assert.notEqual(v.plan.exercises[0].id,v.plan.exercises[1].id);assert.deepEqual(v.plan.groups.map(g=>g.exerciseIds[0]),['entry-bench-a','entry-bench-b']);
  const bad=workout();bad.actual.sets=[actual('wrong',{exerciseId:'entry-bench-b'})];bad.occurredOn='2026-10-13';assert.throws(()=>W.validate(bad),/target/i);
});
test('ordered groups and explicit per-round overrides survive validation and detached copies',()=>{
  const v=W.validate(workout());assert.deepEqual(v.plan.groups.map(g=>g.id),['group-a','group-b']);
  assert.equal(v.plan.exercises[0].sets[1].reps,6);assert.equal(v.plan.exercises[0].sets[1].weight,110);
  const detached=W.planOnly(v);detached.plan.exercises[0].sets[1].weight=120;assert.equal(v.plan.exercises[0].sets[1].weight,110);
});
test('single, superset, and circuit enforce membership and target identity',()=>{
  const base=workout();base.plan.groups=[{id:'super',kind:'superset',rounds:2,exerciseIds:base.plan.exercises.map(e=>e.id)}];assert.doesNotThrow(()=>W.validate(base));
  const third={id:'entry-c',catalogExerciseId:'overhead-barbell-press',name:'Overhead Barbell Press',sets:[target('c-1')]};
  base.plan.exercises.push(third);base.plan.groups=[{id:'circuit',kind:'circuit',rounds:2,exerciseIds:base.plan.exercises.map(e=>e.id)}];assert.doesNotThrow(()=>W.validate(base));
  for(const change of [v=>v.plan.groups[0].exerciseIds.push('entry-c'),v=>v.plan.groups[0].exerciseIds[0]='missing',v=>v.plan.exercises[0].sets[1].id='a-1',v=>v.plan.groups[0].rounds=0]){const v=copy(base);change(v);assert.throws(()=>W.validate(v));}
});
test('planned round zero is invalid rather than silently changed into round one',()=>{const v=workout();v.plan.exercises[0].sets[0].round=0;assert.throws(()=>W.validate(v));});
test('logged actual must be explicitly confirmed and meaningful; zero and timed values survive',()=>{
  const blank=logged({reps:null,weight:null});assert.throws(()=>W.validate(blank),/before confirming/i);
  assert.equal(W.hasActual(W.validate(logged({reps:0,weight:0}))),true);
  const timed=W.validate(logged({reps:null,weight:null,seconds:30,loadMode:'bodyweight'}));assert.equal(timed.actual.sets[0].seconds,30);
  const draft=logged({status:'draft'});assert.throws(()=>W.validate(draft));
});
test('skipped and timing-only workouts do not count as actual activity',()=>{
  const skip=logged({status:'skipped',reps:null,weight:null});assert.equal(W.hasActual(W.validate(skip)),false);
  const timing=W.action(start(),event('stop','stop',40,{outcome:'partial'}));assert.equal(W.hasActual(timing),false);
  const skipped=W.action(workout(),event('skip','skip',0));assert.equal(W.replay(skipped).status,'skipped');assert.equal(W.hasActual(skipped),false);
  assert.throws(()=>W.action(logged(),event('skip','skip',0)),/unlogged/i);
});
test('many actuals may reference the same target and extra sets leave baseline target unchanged',()=>{
  const v=logged();v.actual.sets.push(actual('actual-2',{reps:7}),actual('extra',{planSetId:null,reps:3}));
  const out=W.validate(v);assert.equal(out.actual.sets.length,3);assert.equal(out.plan.exercises[0].sets[0].reps,8);
});
test('actual round must be positive, belong to group, and match referenced planned target',()=>{
  for(const round of [0,3])assert.throws(()=>W.validate(logged({round})));
  assert.throws(()=>W.validate(logged({round:2,planSetId:'a-1'})));
});
test('results dates are calendar-valid at both shared and direct workout validation boundaries',()=>{
  const v=logged();v.occurredOn='2026-02-30';assert.throws(()=>A.validate(v));assert.throws(()=>W.validate(v));
});
test('start/round/rest/stop derives elapsed timing from persisted timestamps including transitions',()=>{
  let v=start();v=W.action(v,event('round-1','start-round',5,{groupId:'group-a',round:1}));
  v=W.action(v,event('round-1-end','finish-round',65,{groupId:'group-a',round:1}));
  v=W.action(v,event('round-2','start-round',95,{groupId:'group-a',round:2}));
  v=W.action(v,event('round-2-end','finish-round',125,{groupId:'group-a',round:2}));
  v=W.action(v,event('stop','stop',135,{outcome:'partial'}));const summary=W.replay(v,at(999));
  assert.equal(summary.totalSeconds,135);assert.deepEqual(summary.rounds.map(r=>r.seconds),[60,30]);assert.deepEqual(summary.rests.map(r=>r.seconds),[30,10]);
  assert.equal(summary.status,'partial');assert.equal(summary.end,at(135));assert.equal(W.replay(copy(v)).totalSeconds,135);
});
test('pause/resume persists paused seconds and rejects invalid transitions',()=>{
  let v=start();v=W.action(v,event('pause','pause',10));assert.equal(W.replay(v,at(30)).pausedSeconds,20);
  v=W.action(v,event('resume','resume',40));v=W.action(v,event('stop','stop',70,{outcome:'partial'}));const s=W.replay(v);
  assert.equal(s.totalSeconds,70);assert.equal(s.pausedSeconds,30);
  assert.throws(()=>W.action(v,event('later-start','start',80)));assert.throws(()=>W.action(start(),event('resume','resume',2)));
});
test('partial stop retains open round boundary and avoids fabricated set timestamps',()=>{
  let v=start(logged({loggedAt:null}));v=W.action(v,event('round','start-round',10,{groupId:'group-a',round:1}));
  v=W.action(v,event('stop','stop',50,{outcome:'partial'}));const s=W.replay(v);
  assert.equal(s.rounds[0].partial,true);assert.equal(s.rounds[0].seconds,40);assert.equal(v.actual.sets[0].loggedAt,null);
});
test('missing round-start boundary has unknown duration rather than guessed precision',()=>{
  let v=start();v=W.action(v,event('end-only','finish-round',20,{groupId:'group-a',round:1}));
  v=W.action(v,event('stop','stop',40,{outcome:'partial'}));const s=W.replay(v);assert.equal(s.rounds[0].start,null);assert.equal(s.rounds[0].seconds,null);
});
test('clock reversal and explicit clock uncertainty do not produce precise durations',()=>{
  for(const clockUncertain of [false,true]){let v=start();v=W.action(v,event('round','start-round',20,{groupId:'group-a',round:1}));v=W.action(v,event('stop','stop',clockUncertain?40:10,{outcome:'partial',clockUncertain}));const s=W.replay(v);assert.equal(s.uncertain,true);assert.equal(s.totalSeconds,null);assert.equal(s.rounds[0].seconds,null);}
});
test('same raw timing command can be retried without duplicate events or false conflict',()=>{
  const command=event('same-start','start',0);const once=W.action(workout(),command);const twice=W.action(once,command);
  assert.deepEqual(twice,once);assert.equal(twice.session.events.length,1);assert.throws(()=>W.action(once,{...command,at:at(1)}),/reused/i);
});
test('ordered next-round actions cannot jump round or group without an explicit skip',()=>{
  assert.throws(()=>W.action(start(),event('jump','start-round',1,{groupId:'group-a',round:2})));
  assert.throws(()=>W.action(start(),event('jump-group','start-round',1,{groupId:'group-b',round:1})));
});
test('finish-round cannot silently finish a different round or duplicate an already finished round',()=>{
  const running=W.action(start(),event('round','start-round',1,{groupId:'group-a',round:1}));
  assert.throws(()=>W.action(running,event('wrong-end','finish-round',10,{groupId:'group-b',round:1})));
  const resting=W.action(running,event('end','finish-round',10,{groupId:'group-a',round:1}));
  assert.throws(()=>W.action(resting,event('end-again','finish-round',12,{groupId:'group-a',round:1})));
});
test('plan-only recurrence clears all actuals, dates, timing, and baseline with no reference sharing',()=>{
  let v=start(logged());v.provenance={templateId:'tpl-1',templateRevision:3,templateName:'Push day',collection:'Upper body',variant:'A'};
  v=W.action(v,event('stop','stop',30,{outcome:'partial'}));const p=A.planOnly(v);
  assert.deepEqual(p.plan,v.plan);assert.deepEqual(p.actual,{sets:[],runs:[]});assert.equal(p.occurredOn,null);assert.deepEqual(p.session.events,[]);assert.equal(p.baseline,null);
  p.plan.exercises[0].name='New name';assert.equal(v.plan.exercises[0].name,'Bench Press');assert.equal(p.provenance.templateRevision,3);
});
test('started baseline remains a detached snapshot while live planned overrides change',()=>{
  const v=start();const baseline=copy(v.baseline);v.plan.exercises[0].sets[0].weight=150;v.plan.exercises[0].name='Session display name';
  const out=W.validate(v);assert.deepEqual(out.baseline,baseline);assert.equal(out.plan.exercises[0].sets[0].weight,150);
});
test('previous performance uses canonical identity with no legacy/name remapping and excludes self/archive',()=>{
  const record=W.validate(logged());const entry=workout().plan.exercises[1];
  assert.equal(W.previous([row(record)],entry,'other').length,1);assert.deepEqual(W.previous([row(record)],entry,'task-1'),[]);
  assert.deepEqual(W.previous([row(record,{archived:true})],entry,'other'),[]);
  assert.deepEqual(W.previous([row(record)],{...entry,catalogExerciseId:null},'other'),[]);
  assert.deepEqual(W.previous([row(record)],{...entry,catalogExerciseId:'dumbbell-curls'},'other'),[]);
});
test('previous performance filters incompatible load and reps conventions',()=>{
  const incompatible=W.validate(logged({loadMode:'assistance',repsMode:'per-side'}));const entry=workout().plan.exercises[0];
  assert.deepEqual(W.previous([row(incompatible)],entry,'other'),[]);
});
test('summary keeps incompatible conventions separate even in the same repeated entry',()=>{
  const v=logged();v.actual.sets.push(actual('assist',{reps:5,weight:20,loadMode:'assistance'}));
  const [day]=A.summarize([row(W.validate(v))],'2026-10-13','2026-10-13');
  assert.equal(Object.keys(day.exercises).length,2);assert.equal(day.exercises['catalog:bench-press:total:total'].sets,1);
});
test('blank legacy runs do not inflate logged-run counts when another real row is logged',()=>{
  const v=A.empty('workout');v.actual.runs=[{id:'blank',planRunId:null,name:'Run',distance:null,unit:'mi',seconds:null},{id:'real',planRunId:null,name:'Run',distance:1,unit:'mi',seconds:600}];v.occurredOn='2026-10-13';
  const [day]=A.summarize([row(A.validate(v))],'2026-10-13','2026-10-13');assert.equal(day.actualRuns.count,1);assert.equal(day.actualRuns.paired,1);
});
test('CSV retains individual confirmed rows, canonical/local relations, conventions, nulls and provenance',()=>{
  const v=logged({weight:null,reps:0,loadMode:'bodyweight',repsMode:'per-side'});v.provenance={templateId:'tpl-1',templateRevision:2,templateName:'Original',collection:'Upper',variant:'Light'};
  const rows=parseCSV(A.csv([row(W.validate(v),{title:'=Private fixture'})]));const actualRow=rows.find(r=>r.phase==='actual'&&r.id==='actual-1');
  assert.equal(actualRow.catalogExerciseId,'bench-press');assert.equal(actualRow.exerciseId,'entry-bench-a');assert.equal(actualRow.planId,'a-1');assert.equal(actualRow.weight,'');assert.equal(actualRow.reps,'0');
  assert.equal(actualRow.loadMode,'bodyweight');assert.equal(actualRow.repsMode,'per-side');assert.equal(actualRow.status,'logged');assert.equal(actualRow.loggedAt,at(20));assert.equal(actualRow.templateId,'tpl-1');assert.equal(actualRow.templateRevision,'2');assert.equal(actualRow.title,"'=Private fixture");
});

test('units convert reported loads without rewriting stored unit or per-dumbbell convention',()=>{
  const v=logged({weight:10,unit:'kg',loadMode:'per-dumbbell',repsMode:'per-side'});const saved=W.validate(v);
  const [day]=A.summarize([row(saved)],'2026-10-13','2026-10-13',{weight:'lb',distance:'mi'});
  assert.ok(Math.abs(day.exercises['catalog:bench-press:per-dumbbell:per-side'].maxLoad-10/0.45359237)<1e-9);
  assert.equal(saved.actual.sets[0].weight,10);assert.equal(saved.actual.sets[0].unit,'kg');assert.equal(saved.actual.sets[0].loadMode,'per-dumbbell');
});
test('invalid measures and ambiguous conventions are rejected rather than converted or fabricated',()=>{
  for(const patch of [{reps:-1},{reps:1.5},{weight:-1},{weight:Infinity},{weight:'10'},{seconds:-1},{unit:'stone'},{loadMode:'unspecified'},{repsMode:'each?'}])assert.throws(()=>W.validate(logged(patch)));
});
test('missing actual measurements stay null across save/export; declared load kind stays explicit',()=>{
  for(const loadMode of ['bodyweight','added','assistance']){
    const saved=W.validate(logged({loadMode,reps:10,weight:null}));assert.equal(saved.actual.sets[0].weight,null);assert.equal(saved.actual.sets[0].loadMode,loadMode);
    const actualRow=parseCSV(A.csv([row(saved)])).find(r=>r.phase==='actual');assert.equal(actualRow.weight,'');assert.equal(actualRow.loadMode,loadMode);
  }
});

test('missing round start cannot finish a later round or group to bypass planned sequence',()=>{
  for(const [groupId,round] of [['group-a',2],['group-b',1],['group-b',2]]){
    assert.throws(()=>W.action(start(),event('out-of-order-end','finish-round',20,{groupId,round})),/order|round/i);
  }
  let v=W.action(start(),event('first-end-only','finish-round',20,{groupId:'group-a',round:1}));
  assert.equal(W.replay(v).rounds[0].seconds,null,'valid next round without its start retains unknown duration');
  v=W.action(v,event('second-start','start-round',30,{groupId:'group-a',round:2}));
  v=W.action(v,event('second-end','finish-round',40,{groupId:'group-a',round:2}));
  assert.throws(()=>W.action(v,event('bypass-final','finish-round',50,{groupId:'group-b',round:2})),/order|round/i);
});
test('v1 entry-scoped target IDs and maximum 200 sets upgrade without identity loss or invented history',()=>{
  const v=A.empty('workout');
  v.plan.exercises=[
    {id:'legacy-first',name:'Bench Press',sets:Array.from({length:200},(_,i)=>({id:'target-'+i,reps:i===0?0:8,weight:i===0?null:100,unit:'lb'}))},
    {id:'legacy-second',name:'Bench Press',sets:[{id:'target-0',reps:12,weight:20,unit:'kg'}]}
  ];
  v.actual.sets=[
    {id:'first-result',exerciseId:'legacy-first',planSetId:'target-199',reps:6,weight:90,unit:'lb'},
    {id:'second-result',exerciseId:'legacy-second',planSetId:'target-0',reps:11,weight:20,unit:'kg'}
  ];
  v.occurredOn='2026-10-08';const before=copy(v);const validated=A.validate(v);const upgraded=W.upgrade(validated);
  assert.deepEqual(v,before);assert.equal(validated.schemaVersion,1);assert.equal(upgraded.schemaVersion,2);
  assert.deepEqual(upgraded.plan.exercises.map(e=>e.id),['legacy-first','legacy-second']);
  assert.deepEqual(upgraded.plan.exercises.map(e=>e.catalogExerciseId),[null,null]);
  assert.equal(upgraded.plan.exercises[0].sets.length,200);assert.equal(upgraded.plan.groups[0].rounds,200);
  assert.equal(upgraded.plan.exercises[0].sets[199].id,'target-199');assert.equal(upgraded.plan.exercises[0].sets[199].round,200);
  assert.equal(upgraded.plan.exercises[1].sets[0].id,'target-0');assert.equal(upgraded.plan.exercises[1].sets[0].round,1);
  assert.deepEqual(upgraded.actual.sets.map(s=>[s.id,s.exerciseId,s.planSetId,s.round,s.reps,s.weight,s.unit,s.loggedAt]),[
    ['first-result','legacy-first','target-199',200,6,90,'lb',null],
    ['second-result','legacy-second','target-0',1,11,20,'kg',null]
  ]);
  assert.equal(upgraded.plan.exercises[0].sets[0].reps,0);assert.equal(upgraded.plan.exercises[0].sets[0].weight,null);
  assert.equal(upgraded.occurredOn,'2026-10-08');assert.deepEqual(upgraded.session.events,[]);
  const detached=A.planOnly(upgraded);assert.equal(detached.plan.exercises[0].sets.length,200);assert.deepEqual(detached.actual.sets,[]);
  assert.doesNotThrow(()=>W.validate(detached));
});

test('all 200 planned rounds can finish and stop without exhausting timing rows',()=>{
 let v=workout();v.plan.exercises=[v.plan.exercises[0]];v.plan.groups=[{id:'long-group',kind:'single',rounds:200,exerciseIds:['entry-bench-a']}];v=start(v);
 for(let round=1;round<=200;round++){v=W.action(v,event('begin-'+round,'start-round',round*2,{groupId:'long-group',round}));v=W.action(v,event('finish-'+round,'finish-round',round*2+1,{groupId:'long-group',round}));}
 v=W.action(v,event('terminal','stop',500,{outcome:'completed'}));assert.equal(W.replay(v).status,'completed');assert.equal(W.replay(v).rounds.length,200);
});
test('timer capacity reserves the final slot for Stop and keeps rejected actions unchanged',()=>{
 let v=start();for(let i=1;i<W.MAX_EVENTS-1;i++)v.session.events.push(event('cycle-'+i,i%2?'pause':'resume',i));v=W.validate(v);const before=copy(v);
 assert.throws(()=>W.action(v,event('overflow','pause',1001)),/Stop the workout/);assert.deepEqual(v,before);
 v=W.action(v,event('terminal','stop',1002,{outcome:'partial'}));assert.equal(v.session.events.length,W.MAX_EVENTS);assert.equal(W.replay(v).status,'partial');assert.doesNotThrow(()=>W.validate(v));
});
