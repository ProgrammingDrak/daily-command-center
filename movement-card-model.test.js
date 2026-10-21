const test=require('node:test');
const assert=require('node:assert/strict');
const W=require('./public/js/workout-model');
const A=require('./public/js/activity-model');
const P=require('./public/js/prompted-sequence');
const crypto=require('node:crypto');
const seed=()=>{const v=W.empty();v.plan=W.gentleReset(()=>crypto.randomUUID());return W.validate(v);};
test('Gentle Reset contains granular reusable definitions, distinct sides and exactly nine suggested minutes',()=>{
  const v=seed(),p=v.plan;
  assert.equal(p.groups.length,9);assert.equal(p.exercises.length,10);
  assert.equal(p.exercises.reduce((n,e)=>n+(e.suggestedSeconds||0),0)+p.groups.reduce((n,g)=>n+(g.suggestedSeconds||0),0),540);
  const sides=p.exercises.filter(e=>e.catalogExerciseId==='reset-side-bend');
  assert.deepEqual(sides.map(e=>e.side),['right','left']);assert.notEqual(sides[0].id,sides[1].id);assert.notEqual(sides[0].sets[0].id,sides[1].sets[0].id);
  assert.equal(p.groups[4].pacing,'natural-breath');assert.equal(p.groups[4].suggestedSeconds,90);
  assert.deepEqual(p.groups[4].exerciseIds.map(id=>p.exercises.find(e=>e.id===id).movement.breath),['inhale','exhale']);
  assert.ok(p.exercises.every(e=>e.movement.visualInstructions&&e.movement.spokenCue&&e.movement.visualInstructions!==e.movement.spokenCue));
  assert.ok(p.exercises.every(e=>e.sets.every(s=>s.reps===null&&s.seconds===null&&s.weight===null)));
  assert.equal(W.hasActual(v),false);assert.deepEqual(v.actual,{sets:[],runs:[]});
});
test('additive metadata roundtrips through validation, exports and plan-only copies without sharing definitions',()=>{
  const v=seed(),copy=A.planOnly(JSON.parse(JSON.stringify(v)));
  assert.deepEqual(copy.plan,v.plan);copy.plan.exercises[0].movement.spokenCue='Changed';assert.notEqual(copy.plan.exercises[0].movement.spokenCue,v.plan.exercises[0].movement.spokenCue);
  assert.notEqual(W.CATALOG.find(x=>x.id==='reset-seat').movement.spokenCue,'Changed');
  for(const patch of [{side:'both'},{suggestedSeconds:-1},{definitionRevision:0},{movement:{goalKind:'bogus'}},{movement:{visualInstructions:'x'.repeat(2401)}}]){const bad=seed();Object.assign(bad.plan.exercises[0],patch);assert.throws(()=>W.validate(bad));}
});
test('one mover handles intra-group cards, cross-group capacity, stable IDs and group order',()=>{
  const p=seed().plan,g=p.groups[4],before=structuredClone(p),[cow,cat]=g.exerciseIds;
  assert.equal(W.moveEntry(p,cat,g.id,cow),true);assert.deepEqual(g.exerciseIds,[cat,cow]);assert.deepEqual(p.exercises,before.exercises);
  assert.equal(W.moveEntry(p,cat,g.id,cat),false);
  assert.throws(()=>W.moveEntry(p,cat,p.groups[0].id),/full/);
  assert.equal(W.moveGroup(p,g.id,0),true);assert.equal(p.groups[0].id,g.id);
  const draft={id:'new',kind:'circuit',rounds:1,exerciseIds:[]};p.groups.push(draft);
  W.moveEntry(p,cat,draft.id);assert.deepEqual(draft.exerciseIds,[cat]);assert.throws(()=>W.normalizePlan(p),/supersets/);
  draft.rounds=2;assert.throws(()=>W.moveEntry(p,cow,draft.id),/rounds/);
});
test('prompted progression persists order, never advances without a command, and never logs actuals or timers',()=>{
  const original=seed();let v=W.guide(original,'begin');assert.equal(original.baseline,null);assert.deepEqual(v.baseline,original.plan);
  const steps=W.guidanceSteps(v.plan);assert.equal(steps.length,10);assert.equal(v.guidance.stepIndex,0);
  assert.throws(()=>W.guide(v,'back'),/first/);assert.throws(()=>W.guide(v,'finish'),/final/);
  v=W.guide(v,'next');assert.equal(v.plan.exercises.find(e=>e.id===steps[v.guidance.stepIndex].exerciseId).side,'right');
  v=W.guide(v,'next');assert.equal(v.plan.exercises.find(e=>e.id===steps[v.guidance.stepIndex].exerciseId).side,'left');
  v=W.guide(v,'exit');const recovered=W.validate(JSON.parse(JSON.stringify(v)));assert.equal(recovered.guidance.stepIndex,2);assert.equal(recovered.guidance.status,'paused');assert.throws(()=>W.guide(recovered,'next'),/Resume/);
  v=W.guide(recovered,'resume');v=W.guide(v,'back');assert.equal(v.guidance.stepIndex,1);
  while(v.guidance.stepIndex<steps.length-1)v=W.guide(v,'next');
  v=W.guide(v,'finish');assert.equal(v.guidance.status,'finished');assert.throws(()=>W.guide(v,'next'),/Resume/);
  assert.equal(W.hasActual(v),false);assert.equal(v.occurredOn,null);assert.deepEqual(v.actual,{sets:[],runs:[]});assert.deepEqual(v.session.events,[]);
  assert.deepEqual(v.baseline,original.plan);assert.equal(W.planOnly(v).guidance,undefined);
  const bad=structuredClone(v);bad.guidance.stepIndex=100;assert.throws(()=>W.validate(bad),/position/);
});
test('domain-neutral prompted navigator has no workout-specific state',()=>{
  let state=P.transition(2,null,'begin');state=P.transition(2,state,'next');assert.deepEqual(P.transition(2,state,'finish'),{status:'finished',stepIndex:1});assert.deepEqual(state,{status:'active',stepIndex:1});
});
test('previous results cannot leak left-side measurements into right-side cards',()=>{
  const v=seed(),left=v.plan.exercises.find(e=>e.side==='left'),right=v.plan.exercises.find(e=>e.side==='right');
  v.actual.sets.push({id:'actual',exerciseId:left.id,planSetId:left.sets[0].id,round:1,status:'logged',loggedAt:null,...W.measurement({seconds:12,loadMode:'bodyweight'})});v.occurredOn='2026-10-20';
  assert.equal(W.previous([{taskId:'past',record:W.validate(v)}],right,'current').length,0);
  assert.equal(W.previous([{taskId:'past',record:W.validate(v)}],left,'current')[0].seconds,12);
});
