// Private workout v2: immutable plan snapshots, stable entry IDs and explicit logs.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./prompted-sequence'));else root.WorkoutModel=factory(root.PromptedSequence);})(typeof self!=='undefined'?self:this,function(Prompted){
  'use strict';
  const CATALOG = Object.freeze([
    {id:'bench-press',name:'Bench Press',loadMode:'total'},
    {id:'dumbbell-curls',name:'Dumbbell Curls',loadMode:'per-dumbbell'},
    {id:'overhead-barbell-press',name:'Overhead Barbell Press',loadMode:'total'},
    ...[
      ['reset-seat','Comfortable seat','Sit on a cushion or chair with your feet or legs supported. Let your shoulders settle; keep breathing easy.','Find a comfortable seat. Let your shoulders soften.','none'],
      ['reset-side-bend','Seated side bend','Bend toward the selected side, supporting that hand beside you. Reach the opposite arm overhead only as far as comfortable. Keep both sitting bones supported; a small bend is enough.','Grow tall, then ease toward your chosen side. Keep the breath comfortable.','none'],
      ['reset-tabletop','Tabletop','Place hands below shoulders and knees below hips. Pad your knees. If wrists dislike loading, stay seated with hands on thighs.','Settle onto hands and knees, or remain seated. Find an easy, neutral back.','none'],
      ['reset-cow','Cow','On a comfortable inhale, ease your chest forward and let your belly soften. Keep the neck long and the motion small. Seated option: gently lift the chest.','Inhale gently. Bring the chest forward and let the belly soften.','inhale'],
      ['reset-cat','Cat','On a comfortable exhale, gently round your back and let your head follow. Avoid pushing to your end range. Seated option: round softly with hands on thighs.','Exhale slowly. Round the back, allowing the head to follow.','exhale'],
      ['reset-child-rest',"Supported child’s rest",'Ease hips toward heels with a cushion supporting your chest or forehead. Keep knees comfortable. If kneeling is uncomfortable, sit supported and rest your hands on your thighs.','Choose a supported rest. You can stay seated and let your hands relax.','none'],
      ['reset-supine','Transition to rest','Take your time moving onto your back, supporting your knees if helpful. Stay seated or lie on your side if that feels better.','Move into a restful position at your own pace. Seated or side lying is fine.','none'],
      ['reset-final-rest','Final rest','Rest on your back with support under your knees, or choose side lying or a supported seat. Let your breath find its own rhythm.','Let the body be supported. There is nothing to count or achieve.','none'],
      ['reset-exit','Unhurried exit','Begin with small movements. If lying down, roll to your side and use your hands to rise when ready. Pause before standing.','Take your time returning. Move gently and pause before you stand.','none']
    ].map(([id,name,visualInstructions,spokenCue,breath])=>({id,name,loadMode:'bodyweight',movement:{visualInstructions,spokenCue,goalKind:'window',supportsSide:id==='reset-side-bend',breath}}))
  ]);
  const clone=x=>JSON.parse(JSON.stringify(x));
  function fail(s){throw Object.assign(new Error(s),{statusCode:400});}
  function ident(x){if(typeof x!=='string'||!/^[-\w]{1,80}$/.test(x))fail('Invalid workout ID');return x;}
  function name(x,max=160){if(typeof x!=='string'||!x.trim()||x.length>max)fail('A name is required');return x.trim();}
  function opt(x,choices){if(!choices.includes(x))fail('Invalid workout convention');return x;}
  function num(x,max=100000,integer=false){if(x==null||x==='')return null;if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>max||(integer&&!Number.isInteger(x)))fail('Invalid workout measurement');return x;}
  // Optional additive metadata: old v2 records keep their exact normalized shape.
  function text(x,max=2400){if(typeof x!=='string'||x.length>max)fail('Invalid movement instructions');return x.trim();}
  function movement(x){if(!x||typeof x!=='object'||(x.supportsSide!=null&&typeof x.supportsSide!=='boolean'))fail('Movement definition required');return {visualInstructions:text(x.visualInstructions??''),spokenCue:text(x.spokenCue??''),goalKind:opt(x.goalKind||'strength',['strength','hold','window']),supportsSide:!!x.supportsSide,breath:opt(x.breath||'none',['none','inhale','exhale'])};}
  function entryMetadata(e){const out={};if(e.definitionRevision!=null){out.definitionRevision=num(e.definitionRevision,1000000,true);if(!out.definitionRevision)fail('Definition revision must be positive');}if(e.movement!=null)out.movement=movement(e.movement);if(e.side!=null)out.side=opt(e.side,['none','right','left']);if(e.suggestedSeconds!=null)out.suggestedSeconds=num(e.suggestedSeconds,86400);return out;}
  function groupMetadata(g){const out={};if(g.label!=null)out.label=text(g.label,160);if(g.suggestedSeconds!=null)out.suggestedSeconds=num(g.suggestedSeconds,86400);if(g.pacing!=null)out.pacing=opt(g.pacing,['rounds','natural-breath']);return out;}
  function makeEntry(def,idFactory){return {id:idFactory(),catalogExerciseId:def.id,name:def.name,definitionRevision:def.revision||1,...(def.movement?{movement:movement(def.movement),side:'none'}:{}),sets:[{id:idFactory(),round:1,...measurement({loadMode:def.loadMode})}]};}
  // All card movement controls use this same ordered-ID operation. Source groups
  // can become incomplete drafts; normalization still rejects them at save/start.
  function moveEntry(plan,entryId,toGroupId,beforeId=null){
    const source=plan.groups.find(g=>g.exerciseIds.includes(entryId)),dest=plan.groups.find(g=>g.id===toGroupId);
    if(!source||!dest||entryId===beforeId)return false;
    if(beforeId!=null&&!dest.exerciseIds.includes(beforeId))fail('Drop target is missing');
    if(source!==dest&&((dest.kind==='single'&&dest.exerciseIds.length>=1)||(dest.kind==='superset'&&dest.exerciseIds.length>=2)))fail('Destination group is full. Choose a circuit or an empty group.');
    // Moving across round counts must never silently discard or invent targets.
    if(source.rounds!==dest.rounds)fail('Match group rounds before moving this card.');
    source.exerciseIds.splice(source.exerciseIds.indexOf(entryId),1);
    dest.exerciseIds.splice(beforeId==null?dest.exerciseIds.length:dest.exerciseIds.indexOf(beforeId),0,entryId);
    plan.groups=plan.groups.filter(g=>g.exerciseIds.length||g.id!==source.id);return true;
  }
  function moveGroup(plan,id,to){const from=plan.groups.findIndex(g=>g.id===id);if(from<0||to<0||to>=plan.groups.length||from===to)return false;const [g]=plan.groups.splice(from,1);plan.groups.splice(to,0,g);return true;}
  function gentleReset(idFactory){
    const p={exercises:[],groups:[],runs:[]};
    function add(ids,seconds,side='none',label){const entries=ids.map(id=>makeEntry(CATALOG.find(e=>e.id===id),idFactory));entries.forEach(e=>e.side=side);if(entries.length===1)entries[0].suggestedSeconds=seconds;
      p.exercises.push(...entries);p.groups.push({id:idFactory(),kind:entries.length===1?'single':'superset',rounds:1,exerciseIds:entries.map(e=>e.id),...(label?{label,pacing:'natural-breath',suggestedSeconds:seconds}:{})});}
    add(['reset-seat'],60);add(['reset-side-bend'],60,'right');add(['reset-side-bend'],60,'left');add(['reset-tabletop'],30);
    add(['reset-cow','reset-cat'],90,'none','Cat / Cow · natural breath');add(['reset-child-rest'],60);add(['reset-supine'],30);add(['reset-final-rest'],120);add(['reset-exit'],30);
    return normalizePlan(p);
  }
  const MAX_EVENTS=1000;
  function rows(x,fn,max=200){if(!Array.isArray(x)||x.length>max)fail('Workout lists allow at most '+max+' rows');const a=x.map(fn);if(new Set(a.map(v=>v.id)).size!==a.length)fail('Duplicate workout row IDs');return a;}
  function round(x){const n=num(x,200,true);if(!n)fail("Round must be positive");return n;}
  function timestamp(x){if(x==null)return null;if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT/.test(x)||!Number.isFinite(Date.parse(x)))fail('Invalid workout timestamp');return new Date(x).toISOString();}
  function measurement(x){return {reps:num(x.reps,100000,true),weight:num(x.weight),unit:opt(x.unit||'lb',['lb','kg']),seconds:num(x.seconds,31536000),loadMode:opt(x.loadMode||'total',['total','per-dumbbell','bodyweight','added','assistance']),repsMode:opt(x.repsMode||'total',['total','per-side'])};}
  function meaningful(x){return ['reps','weight','seconds'].some(k=>x[k]!=null&&x[k]!=='');}
  function empty(){return {schemaVersion:2,taskType:'workout',plan:{exercises:[],groups:[],runs:[]},actual:{sets:[],runs:[]},occurredOn:null,baseline:null,provenance:null,session:{events:[]}};}
  function normalizePlan(p){
    if(!p||typeof p!=='object')fail('Workout plan is required');
    const exercises=rows(p.exercises,e=>({id:ident(e.id),catalogExerciseId:e.catalogExerciseId==null?null:ident(e.catalogExerciseId),name:name(e.name),...entryMetadata(e),sets:rows(e.sets,s=>({id:ident(s.id),round:round(s.round),...measurement(s)}))}));
    const groups=rows(p.groups,g=>({id:ident(g.id),kind:opt(g.kind,['single','superset','circuit']),rounds:num(g.rounds,200,true),...groupMetadata(g),exerciseIds:Array.isArray(g.exerciseIds)?g.exerciseIds.map(ident):fail('Exercise entries required')}));
    const used=[];
    for(const g of groups){if(!g.rounds||g.exerciseIds.length>200||g.exerciseIds.length<(g.kind==='circuit'?3:g.kind==='superset'?2:1)||(g.kind==='single'&&g.exerciseIds.length!==1)||(g.kind==='superset'&&g.exerciseIds.length!==2))fail('Single groups need one exercise, supersets two, circuits at least three');for(const id of g.exerciseIds){const e=exercises.find(e=>e.id===id);if(!e)fail('Group references a missing exercise entry');if(e.sets.some(s=>s.round>g.rounds))fail('Planned round exceeds group rounds');used.push(id);}}
    if(used.length!==exercises.length||new Set(used).size!==used.length)fail('Every exercise entry must belong to exactly one ordered group');
    const runs=rows(p.runs||[],r=>({id:ident(r.id),name:name(r.name),distance:num(r.distance,1000000),unit:opt(r.unit,['mi','km','m']),seconds:num(r.seconds,31536000)}));
    return {exercises,groups,runs};
  }
  function validate(v){
    if(v.schemaVersion!==2||v.taskType!=='workout')fail('Unsupported workout version');
    const out=empty();out.plan=normalizePlan(v.plan);
    out.actual.sets=rows(v.actual.sets,s=>{
      const e=out.plan.exercises.find(e=>e.id===s.exerciseId);if(!e)fail('Logged set references a missing exercise entry');
      if(s.planSetId!=null&&!e.sets.some(p=>p.id===s.planSetId))fail('Logged set references a missing planned target');
      const group=out.plan.groups.find(g=>g.exerciseIds.includes(e.id));
      const actualRound=round(s.round); if(actualRound>group.rounds)fail('Actual round exceeds group rounds');
      const target=e.sets.find(p=>p.id===s.planSetId);if(target&&target.round!==actualRound)fail('Actual round must match its planned target');
      const m=measurement(s);const status=opt(s.status,['logged','skipped']);if(status==='logged'&&!meaningful(m))fail('Enter reps, load or duration before confirming a set');
      return {id:ident(s.id),exerciseId:e.id,planSetId:s.planSetId==null?null:ident(s.planSetId),round:round(s.round),status,loggedAt:timestamp(s.loggedAt),...m};
    });
    out.actual.runs=rows(v.actual.runs||[],r=>{if(r.planRunId!=null&&!out.plan.runs.some(p=>p.id===r.planRunId))fail('Missing planned run');return {id:ident(r.id),planRunId:r.planRunId==null?null:ident(r.planRunId),name:name(r.name),distance:num(r.distance,1000000),unit:opt(r.unit,['mi','km','m']),seconds:num(r.seconds,31536000)};});
    out.session.events=rows(v.session?.events||[],e=>({id:ident(e.id),type:opt(e.type,['start','start-round','finish-round','pause','resume','stop','skip']),at:timestamp(e.at)||fail('Timestamp required'),groupId:e.groupId==null?null:ident(e.groupId),round:e.round==null?null:num(e.round,200,true),outcome:e.outcome==null?null:opt(e.outcome,['completed','partial']),clockUncertain:!!e.clockUncertain}),MAX_EVENTS);
    for(const e of out.session.events){if(e.groupId!=null&&!out.plan.groups.some(g=>g.id===e.groupId&&e.round>=1&&e.round<=g.rounds))fail('Timing references a missing round');}
    const state=replay(out);
    const active=["running","paused"].includes(state.status);
    if(active&&out.session.events.length>=MAX_EVENTS)fail("Timing history is full. Stop the workout before another timing action.");
    out.baseline=v.baseline==null?null:normalizePlan(v.baseline);
    if(v.guidance!=null){const steps=guidanceSteps(out.plan),index=num(v.guidance.stepIndex,40000,true);if(!out.baseline||index==null||index>=steps.length)fail('Guidance requires a frozen plan and a valid card position');out.guidance={status:opt(v.guidance.status,['active','paused','finished']),stepIndex:index};if(out.guidance.status==='finished'&&index!==steps.length-1)fail('Finish guidance at the final card');}
    if(out.session.events.length&&!out.baseline)fail('Started workouts require a plan baseline');
    if(v.provenance!=null){const p=v.provenance;out.provenance={templateId:ident(p.templateId),templateRevision:num(p.templateRevision,1000000,true),templateName:name(p.templateName),collection:p.collection==null?'':String(p.collection).slice(0,160),variant:p.variant==null?'':String(p.variant).slice(0,160)};}
    if(v.occurredOn!=null&&(!/^\d{4}-\d\d-\d\d$/.test(v.occurredOn)||!Number.isFinite(Date.parse(v.occurredOn+'T12:00:00Z'))||new Date(v.occurredOn+'T12:00:00Z').toISOString().slice(0,10)!==v.occurredOn))fail('Invalid results date');out.occurredOn=v.occurredOn||null;
    if(hasActual(out)&&!out.occurredOn)fail('Results date required');const size=JSON.stringify(out).length;if(size>200000)fail('Workout record too large');if(active&&size>199500)fail('Timing history is full. Stop the workout before another edit.');return out;
  }
  function hasActual(v){return v.actual.sets.some(s=>s.status==='logged'&&meaningful(s))||v.actual.runs.some(r=>r.distance!=null||r.seconds!=null);}
  function upgrade(v){
    if(v.schemaVersion===2)return validate(v);
    const out=empty();out.plan.runs=clone(v.plan.runs);out.actual.runs=clone(v.actual.runs);out.occurredOn=v.occurredOn;
    out.plan.exercises=v.plan.exercises.map(e=>({...clone(e),catalogExerciseId:null,sets:e.sets.map((s,i)=>({...s,round:i+1,seconds:null,loadMode:'total',repsMode:'total'}))}));
    out.plan.groups=out.plan.exercises.map((e,i)=>({id:'legacy-group-'+i,kind:'single',rounds:Math.max(1,e.sets.length),exerciseIds:[e.id]}));
    out.actual.sets=v.actual.sets.filter(meaningful).map(s=>({...clone(s),status:'logged',loggedAt:null,round:out.plan.exercises.find(e=>e.id===s.exerciseId)?.sets.find(p=>p.id===s.planSetId)?.round||1,seconds:null,loadMode:'total',repsMode:'total'}));
    return validate(out);
  }
  function replay(v,now=new Date().toISOString()){
    let status='planned',start=null,end=null,current=null,rest=null,pause=null,paused=0,uncertain=false,last=null;const rounds=[],rests=[];
    const elapsed=(a,b)=>{if(!a||!b||Date.parse(b)<Date.parse(a))return null;return (Date.parse(b)-Date.parse(a))/1000;};
    for(const e of v.session.events){if(last&&Date.parse(e.at)<Date.parse(last))uncertain=true;if(e.clockUncertain)uncertain=true;last=e.at;
      if(e.type==='start'){if(status!=='planned')fail('Workout already started');start=e.at;status='running';}
      else if(e.type==='skip'){if(status!=='planned'||hasActual(v))fail('Only an unlogged planned workout can be skipped');status='skipped';end=e.at;}
      else if(e.type==='start-round'){if(status!=='running'||current||!e.groupId||!e.round)fail('Start a workout before its next round');if(rounds.some(r=>r.groupId===e.groupId&&r.round===e.round))fail('Round already finished');const sequence=v.plan.groups.flatMap(g=>Array.from({length:g.rounds},(_,i)=>({groupId:g.id,round:i+1})));const expected=sequence[rounds.length];if(!expected||expected.groupId!==e.groupId||expected.round!==e.round)fail('Follow group and round order');if(rest){rests.push({start:rest,end:e.at,seconds:elapsed(rest,e.at)});rest=null;}current={groupId:e.groupId,round:e.round,start:e.at};}
      else if(e.type==='finish-round'){if(status!=='running')fail('Workout is not running');if(rest)fail('Round already finished');if(!e.groupId||!e.round)fail('Round is required');if(current&&(e.groupId!==current.groupId||e.round!==current.round))fail('Finish the active round');if(!current){const sequence=v.plan.groups.flatMap(g=>Array.from({length:g.rounds},(_,i)=>({groupId:g.id,round:i+1})));const expected=sequence[rounds.length];if(!expected||expected.groupId!==e.groupId||expected.round!==e.round)fail('Follow group and round order');}if(current){rounds.push({...current,end:e.at,seconds:elapsed(current.start,e.at),partial:false});current=null;}else{rounds.push({groupId:e.groupId,round:e.round,start:null,end:e.at,seconds:null,partial:false});}rest=e.at;}
      else if(e.type==='pause'){if(status!=='running')fail('Workout is not running');pause=e.at;status='paused';}
      else if(e.type==='resume'){if(status!=='paused')fail('Workout is not paused');const n=elapsed(pause,e.at);if(n==null)uncertain=true;else paused+=n;pause=null;status='running';}
      else if(e.type==='stop'){if(!['running','paused'].includes(status))fail('Start before stopping');if(current){rounds.push({...current,end:e.at,seconds:elapsed(current.start,e.at),partial:true});current=null;}if(rest){rests.push({start:rest,end:e.at,seconds:elapsed(rest,e.at)});rest=null;}if(pause){const n=elapsed(pause,e.at);if(n==null)uncertain=true;else paused+=n;}end=e.at;status=e.outcome||'partial';}
    }
    const boundary=end||now; if(start&&elapsed(start,boundary)==null)uncertain=true;
    return {status,start,end,current,restStart:rest,totalSeconds:uncertain?null:elapsed(start,boundary),pausedSeconds:uncertain?null:paused+(pause&&status==='paused'?(elapsed(pause,now)||0):0),rounds:rounds.map(r=>({...r,seconds:uncertain?null:r.seconds})),rests:rests.map(r=>({...r,seconds:uncertain?null:r.seconds})),uncertain};
  }
  function action(v,event){const out=clone(v),old=out.session.events.find(e=>e.id===event.id);if(old){const canonical={id:ident(event.id),type:event.type,at:timestamp(event.at),groupId:event.groupId??null,round:event.round??null,outcome:event.outcome??null,clockUncertain:!!event.clockUncertain};if(JSON.stringify(old)!==JSON.stringify(canonical))fail('Timing action ID was reused');return out;}if(!out.baseline)out.baseline=clone(out.plan);out.session.events.push(event);return validate(out);}
  function guidanceSteps(plan){return plan.groups.flatMap(g=>Array.from({length:g.rounds},(_,i)=>g.exerciseIds.map(exerciseId=>({groupId:g.id,round:i+1,exerciseId}))).flat());}
  function guide(v,command){const out=validate(v),steps=guidanceSteps(out.plan);out.guidance=Prompted.transition(steps.length,out.guidance,command);if(!out.baseline)out.baseline=clone(out.plan);return validate(out);}
  function planOnly(v){const out=empty();out.plan=clone(validate(v).plan);out.provenance=v.provenance?clone(v.provenance):null;return out;}
  function previous(records,entry,excludeId){if(!entry.catalogExerciseId)return [];for(const row of records.filter(r=>r.taskId!==excludeId&&!r.archived).sort((a,b)=>(b.record.occurredOn||'').localeCompare(a.record.occurredOn||''))){const v=row.record;if(v.schemaVersion!==2)continue;const ids=v.plan.exercises.filter(e=>e.catalogExerciseId===entry.catalogExerciseId&&(e.side||'none')===(entry.side||'none')).map(e=>e.id);const sets=v.actual.sets.filter(s=>ids.includes(s.exerciseId)&&s.status==='logged'&&meaningful(s)&&s.loadMode===(entry.sets[0]?.loadMode||'total')&&s.repsMode===(entry.sets[0]?.repsMode||'total'));if(sets.length)return sets.map(s=>({...s,occurredOn:v.occurredOn}));}return [];}
  return {CATALOG,movement,makeEntry,moveEntry,moveGroup,gentleReset,guidanceSteps,guide,MAX_EVENTS,empty,validate,upgrade,normalizePlan,measurement,meaningful,hasActual,replay,action,planOnly,previous};
});
