const test=require('node:test');
const assert=require('node:assert/strict');
const N=require('./lib/task-notes');
// One fixture for the whole file: createSharedQueueFixture binds the cached db/pg-schema
// modules to its pool, so a second fixture in this process would reuse an ended pool.
test('owner task notes: glasses, desktop and generic writers share one guarded contract',{skip:!process.env.DCC_TEST_DATABASE_URL},async t=>{
 const f=await require('./test-support/shared-queue-fixture').createSharedQueueFixture();t.after(()=>f.close());
 const note=text=>({text,html:'<p>'+text+'</p>',blocks:[{id:'paragraph',type:'paragraph',content:text}]});

 await t.test('owner task notes preserve storage identity, reject conflicts and never modify timing',async()=>{
  const url='/api/working-queue/tasks/focus/notes',read=()=>f.request(url,{user:1});
  assert.equal((await f.request(url)).status,401);assert.equal((await f.request(url,{user:3})).status,403);
  await f.blockDB.createBlock({id:'foreign-notes-task',type:'block',user_id:2,workspace_id:'ws-2',properties:{type:'task',title:'Foreign'}});
  assert.equal((await f.request('/api/working-queue/tasks/foreign-notes-task/notes',{user:1})).status,404);
  const initial=await read(),before=await f.blockDB.getBlock('focus');
  const write=(value,expectedRevision=initial.body.revision)=>f.request(url,{user:1,method:'PUT',body:{note:note(value),expectedRevision}});
  assert.equal((await write('first')).status,200);
  const first=await read();assert.equal(first.body.note.text,'first');
  const after=await f.blockDB.getBlock('focus');assert.deepEqual({...after.properties,_taskNotes:undefined},{...before.properties,_taskNotes:undefined});
  assert.equal((await write('first')).status,200,'lost acknowledgement exact replay succeeds');
  assert.equal((await write('stale other text')).status,409);assert.equal((await read()).body.note.text,'first');
  const results=await Promise.all([write('writer one',first.body.revision),write('writer two',first.body.revision)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  const latest=await read();assert.equal((await f.request(url,{user:1,method:'PUT',body:{note:note('')}})).status,400);
  assert.throws(()=>N.validate(note('x'.repeat(200001))),/200 KB/);
  assert.equal((await write('',latest.body.revision)).status,200);assert.equal((await read()).body.note.text,'','explicit empty survives');
  // Existing daily-note identity stays authoritative; the task row is not migrated.
  await f.blockDB.createBlock({id:'legacy-note',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{_sourceTaskId:'local-review',html:'<p>Legacy</p>',text:'Legacy'}});
  const legacyUrl='/api/working-queue/tasks/review/notes',old=await f.request(legacyUrl,{user:1});assert.equal(old.body.noteBlockId,'legacy-note');assert.equal(old.body.note.text,'Legacy');
  const saved=await f.request(legacyUrl,{user:1,method:'PUT',body:{note:note('Updated legacy'),expectedRevision:old.body.revision}});assert.equal(saved.status,200);
  assert.equal((await f.blockDB.getBlock('legacy-note')).properties.text,'Updated legacy');assert.equal((await f.blockDB.getBlock('review')).properties._taskNotes,undefined);
  assert.deepEqual(f.broadcasts.at(-1)[1].blockIds,['review','legacy-note']);
  for(const id of ['alias-one','alias-two'])await f.blockDB.createBlock({id,type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:id,local_id:'ambiguous'}});
  await f.blockDB.createBlock({id:'ambiguous-note',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{_sourceTaskId:'ambiguous',html:'<p>Ambiguous legacy note</p>',text:'Ambiguous legacy note'}});
  const ambiguous=await f.request('/api/working-queue/tasks/alias-one/notes',{user:1});assert.equal(ambiguous.body.noteBlockId,null);assert.equal(ambiguous.body.note.html,'');
  assert.equal((await f.request('/api/working-queue/tasks/alias-one/notes',{user:1,method:'PUT',body:{note:note('One task only'),expectedRevision:ambiguous.body.revision}})).status,200);
  assert.equal((await f.blockDB.getBlock('ambiguous-note')).properties.text,'Ambiguous legacy note');assert.equal((await f.blockDB.getBlock('alias-two')).properties._taskNotes,undefined);
  const state=await f.request('/api/working-queue',{user:1});assert.equal(state.body.revision,0);assert.equal(state.body.queue.items.find(i=>i.task.id==='focus').status,'foreground');
 });

 await t.test('generic stale property writes cannot erase newer task notes; desktop notes use the same revision conflict',async()=>{
  await f.blockDB.createBlock({id:'notes-race',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:'Notes race'}});
  const url='/api/working-queue/tasks/notes-race/notes',read=()=>f.request(url,{user:1});
  const stored=async()=>(await f.blockDB.getBlock('notes-race')).properties._taskNotes;
  const stale=await f.blockDB.getBlock('notes-race');assert.equal(stale.properties._taskNotes,undefined);
  const glasses=async(text,revision)=>f.request(url,{user:1,method:'PUT',body:{note:note(text),expectedRevision:revision??(await read()).body.revision}});
  assert.equal((await glasses('glasses one')).status,200);
  // A stale bag that never saw the note (title rename) and one carrying an older note (duration).
  const renamed=await f.blockDB.updateBlock('notes-race',{properties:{...stale.properties,title:'Renamed offline'}});
  assert.equal(renamed.properties.title,'Renamed offline');assert.equal(renamed.properties._taskNotes.text,'glasses one');
  const older=await f.blockDB.getBlock('notes-race');
  assert.equal((await glasses('glasses two')).status,200);
  const resized=await f.blockDB.updateBlock('notes-race',{properties:{...older.properties,duration:45}});
  assert.equal(resized.properties.duration,45);assert.equal(resized.properties._taskNotes.text,'glasses two');
  await f.blockDB.rescheduleBlocks([{id:'notes-race',date:f.date,properties:{...stale.properties,title:'Moved'}}],[]);
  assert.equal((await read()).body.note.text,'glasses two','a stale move keeps the note too');
  // Desktop: the explicit field-only write, against the revision id its editor opened with.
  const desktop=(text,bases)=>f.blockDB.updateBlock('notes-race',{properties:{...stale.properties,title:'ignored stale title'},taskNotes:note(text),taskNotesTarget:'task',taskNotesBaseRevisions:bases});
  const opened=N.revision(await stored());
  assert.equal(opened,(await read()).body.revision,'desktop and glasses compute the same revision id');
  const saved=await desktop('desktop edit',[opened]);
  assert.equal(saved.properties._taskNotes.text,'desktop edit');assert.equal(saved.properties.title,'Moved','a notes write ignores its stale properties bag');
  assert.equal((await read()).body.note.text,'desktop edit','glasses reads the desktop note');
  assert.equal((await desktop('desktop edit',[opened])).properties._taskNotes.text,'desktop edit','lost-ack replay succeeds');
  // Glasses saves while the desktop editor is still open on the older note: conflict, nothing lost.
  const editorBase=N.revision(await stored());
  assert.equal((await glasses('glasses three')).status,200);
  await assert.rejects(desktop('desktop draft',[editorBase]),{statusCode:409,publicCode:'TASK_NOTES_CONFLICT',message:/draft is retained/});
  assert.equal((await read()).body.note.text,'glasses three');
  // The reverse: glasses on an older revision cannot replace a newer desktop note.
  const glassesView=await read();
  assert.equal((await desktop('desktop newer',[glassesView.body.revision])).properties._taskNotes.text,'desktop newer');
  assert.equal((await glasses('glasses stale',glassesView.body.revision)).status,409);assert.equal((await read()).body.note.text,'desktop newer');
  // Offline chain: a superseded draft may or may not have landed, so either id is accepted,
  // but a remote edit made since is in neither and still conflicts.
  const chainBase=N.revision(await stored());
  assert.equal((await desktop('offline second',[N.revision(note('offline first')),chainBase])).properties._taskNotes.text,'offline second');
  assert.equal((await glasses('remote after chain')).status,200);
  await assert.rejects(desktop('offline third',[N.revision(note('offline second')),chainBase]),{statusCode:409,publicCode:'TASK_NOTES_CONFLICT'});
  assert.equal((await read()).body.note.text,'remote after chain');
  // Explicit clear persists.
  assert.equal((await desktop('',[N.revision(await stored())])).properties._taskNotes.text,'');assert.equal((await read()).body.note.text,'');
  // One validator for every writer: lib/task-notes.validate, mapped to 400 TASK_NOTES_INVALID.
  const current=N.revision(await stored());
  const invalid={statusCode:400,publicCode:'TASK_NOTES_INVALID'};
  const blocks=n=>Array.from({length:n},(_,i)=>({id:'b'+i,type:'paragraph',content:''}));
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:{html:'',text:'',blocks:blocks(1001)},taskNotesTarget:'task',taskNotesBaseRevisions:[current]}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:{html:'',text:'',blocks:[{id:'x',type:'script',content:''}]},taskNotesTarget:'task',taskNotesBaseRevisions:[current]}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:{html:'',text:'',blocks:[{type:'paragraph',content:''}]},taskNotesTarget:'task',taskNotesBaseRevisions:[current]}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'.repeat(200001)),taskNotesTarget:'task',taskNotesBaseRevisions:[current]}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:{text:'x'},taskNotesTarget:'task',taskNotesBaseRevisions:[current]}),invalid);
  // Bases are bounded revision ids, never note snapshots.
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'),taskNotesTarget:'task',taskNotesBaseRevisions:[await stored()]}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'),taskNotesTarget:'task',taskNotesBaseRevisions:Array(21).fill(current)}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'),taskNotesTarget:'task'}),invalid);
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'),taskNotesBaseRevisions:[current]}),invalid,'target is required');
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'),taskNotesTarget:'legacy',taskNotesBaseRevisions:[current]}),invalid,'a task row is not a legacy note');
  await assert.rejects(f.blockDB.updateBlock('notes-race',{taskNotes:note('x'),taskNotesTarget:'task',taskNotesBaseRevisions:[current],date:'2026-10-30'}),{statusCode:400});
  assert.equal((await read()).body.note.text,'','no rejected write changed the note');
  // A row with no task note yet still accepts one from a generic write (copies, older clients).
  await f.blockDB.createBlock({id:'copy-target',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:'Copy target'}});
  const copied=await f.blockDB.updateBlock('copy-target',{properties:{type:'task',title:'Copy target',_taskNotes:note('copied')}});
  assert.equal(copied.properties._taskNotes.text,'copied');
  const state=await f.request('/api/working-queue',{user:1});assert.equal(state.body.queue.items.find(i=>i.task.id==='focus').status,'foreground');
 });

 await t.test('legacy daily note blocks: glasses and desktop share the guarded write; stale writers cannot erase them',async()=>{
  await f.blockDB.createBlock({id:'legacy-race',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:'Legacy race'}});
  await f.blockDB.createBlock({id:'legacy-race-note',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{_sourceTaskId:'legacy-race',html:'<p>Old</p>',text:'Old'}});
  await f.blockDB.createBlock({id:'legacy-race-action',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{_sourceTaskId:'legacy-race',text:'Call supplier',tags:['action-item']}});
  const url='/api/working-queue/tasks/legacy-race/notes',read=()=>f.request(url,{user:1});
  const legacy=async()=>(await f.blockDB.getBlock('legacy-race-note')).properties;
  // Desktop opens the existing legacy note; its revision id matches the glasses view.
  const staleNote=await legacy();
  const desktopOpened=N.revision(N.legacyNote(staleNote));
  const opened=await read();assert.equal(opened.body.noteBlockId,'legacy-race-note');assert.equal(opened.body.revision,desktopOpened);
  const desktop=(text,base)=>f.blockDB.updateBlock('legacy-race-note',{taskNotes:note(text),taskNotesTarget:'legacy',taskNotesBaseRevisions:[base]});
  // Glasses saves newer text; the old desktop save must conflict, not overwrite.
  assert.equal((await f.request(url,{user:1,method:'PUT',body:{note:note('Glasses newer'),expectedRevision:opened.body.revision}})).status,200);
  await assert.rejects(desktop('Old desktop draft',desktopOpened),{statusCode:409,publicCode:'TASK_NOTES_CONFLICT',message:/draft is retained/});
  assert.equal((await legacy()).text,'Glasses newer');assert.equal((await legacy())._sourceTaskId,'legacy-race','identity preserved');
  // Unrelated full-properties updates and moves keep the legacy note content.
  const updated=await f.blockDB.updateBlock('legacy-race-note',{properties:{...staleNote,pinned:true}});
  assert.equal(updated.properties.text,'Glasses newer');assert.equal(updated.properties.pinned,true);
  await f.blockDB.updateBlock('legacy-race-note',{properties:{_sourceTaskId:'legacy-race'}});
  assert.equal((await legacy()).text,'Glasses newer','a bag missing the note keeps it');
  await f.blockDB.rescheduleBlocks([{id:'legacy-race-note',date:f.date,properties:{...staleNote}}],[]);
  assert.equal((await legacy()).html,'<p>Glasses newer</p>','a stale move keeps it');
  // Desktop, opened on the current note, saves through the same guarded write.
  const current=(await read()).body.revision;
  assert.equal(N.revision(N.legacyNote(await legacy())),current);
  assert.equal((await desktop('Desktop newer',current)).properties.text,'Desktop newer');
  const afterDesktop=await read();assert.equal(afterDesktop.body.noteBlockId,'legacy-race-note');assert.equal(afterDesktop.body.note.text,'Desktop newer');
  assert.equal((await f.blockDB.getBlock('legacy-race')).properties._taskNotes,undefined,'the task row is not migrated');
  // Glasses holding the pre-desktop revision now conflicts in turn.
  assert.equal((await f.request(url,{user:1,method:'PUT',body:{note:note('Glasses stale'),expectedRevision:current}})).status,409);
  // Intentional clear persists on the legacy row.
  assert.equal((await desktop('',afterDesktop.body.revision)).properties.text,'');assert.equal((await read()).body.note.text,'');
  // Action items linked to the same task (no html) are unaffected by note pinning.
  const action=await f.blockDB.updateBlock('legacy-race-action',{properties:{_sourceTaskId:'legacy-race',text:'Call supplier back',tags:['action-item']}});
  assert.equal(action.properties.text,'Call supplier back');
  // A legacy note write cannot target a task row's id with the legacy shape, or vice versa.
  await assert.rejects(f.blockDB.updateBlock('legacy-race-action',{taskNotes:note('x'),taskNotesTarget:'legacy',taskNotesBaseRevisions:[null]}),{statusCode:400,publicCode:'TASK_NOTES_INVALID'});
  await assert.rejects(f.blockDB.updateBlock('legacy-race-note',{taskNotes:note('x'),taskNotesTarget:'task',taskNotesBaseRevisions:[null]}),{statusCode:400,publicCode:'TASK_NOTES_INVALID'});
  assert.equal((await legacy())._taskNotes,undefined);
 });

 await t.test('first notes on a canonical task race on the task row: desktop against glasses, and two desktops',async()=>{
  for(const id of ['first-glasses','first-desktops','first-then-glasses','first-legacy'])
   await f.blockDB.createBlock({id,type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:id}});
  const desktopFirst=(id,text)=>f.blockDB.updateBlock(id,{taskNotes:note(text),taskNotesTarget:'task',taskNotesBaseRevisions:[null]});
  const view=id=>f.request('/api/working-queue/tasks/'+id+'/notes',{user:1});
  // Glasses saves first; the desktop first save then conflicts instead of becoming a hidden note block.
  const opened=await view('first-glasses');assert.equal(opened.body.noteBlockId,null);
  assert.equal((await f.request('/api/working-queue/tasks/first-glasses/notes',{user:1,method:'PUT',body:{note:note('Glasses first'),expectedRevision:opened.body.revision}})).status,200);
  await assert.rejects(desktopFirst('first-glasses','Desktop first'),{statusCode:409,publicCode:'TASK_NOTES_CONFLICT'});
  assert.equal((await view('first-glasses')).body.note.text,'Glasses first');
  // Two desktops: exactly one first save wins and the other conflicts.
  const results=await Promise.allSettled([desktopFirst('first-desktops','Desktop A'),desktopFirst('first-desktops','Desktop B')]);
  assert.deepEqual(results.map(r=>r.status).sort(),['fulfilled','rejected']);
  assert.equal(results.find(r=>r.status==='rejected').reason.publicCode,'TASK_NOTES_CONFLICT');
  const winner=results.find(r=>r.status==='fulfilled').value.properties._taskNotes.text;
  const both=await view('first-desktops');assert.equal(both.body.note.text,winner);assert.equal(both.body.noteBlockId,null);
  // Desktop first: glasses still holding the empty view conflicts in turn.
  const glassesEmpty=await view('first-then-glasses');
  assert.equal((await desktopFirst('first-then-glasses','Desktop wins')).properties._taskNotes.text,'Desktop wins');
  assert.equal((await f.request('/api/working-queue/tasks/first-then-glasses/notes',{user:1,method:'PUT',body:{note:note('Glasses late'),expectedRevision:glassesEmpty.body.revision}})).status,409);
  assert.equal((await view('first-then-glasses')).body.note.text,'Desktop wins');
  // An existing legacy note keeps its identity: a first task-row note cannot hide it.
  await f.blockDB.createBlock({id:'first-legacy-note',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{_sourceTaskId:'first-legacy',html:'<p>Legacy</p>',text:'Legacy'}});
  await assert.rejects(desktopFirst('first-legacy','Desktop unaware of legacy'),{statusCode:409,publicCode:'TASK_NOTES_CONFLICT'});
  assert.equal((await f.blockDB.getBlock('first-legacy')).properties._taskNotes,undefined);
  const legacyView=await view('first-legacy');assert.equal(legacyView.body.noteBlockId,'first-legacy-note');assert.equal(legacyView.body.note.text,'Legacy');
 });

 await t.test('parent-only legacy notes are protected from stale generic writes; standalone notes and action items are not',async()=>{
  // Parent-only rows are inserted directly: no _sourceTaskId, linked only by parent_id.
  const insert=(id,parent,props,date=f.date)=>f.pool.query(`INSERT INTO blocks(id,type,parent_id,date,properties,sort_order,user_id,workspace_id,created_at,updated_at)
    VALUES($1,'block',$2,$3,$4,0,1,'ws-1',NOW(),NOW())`,[id,parent,date,props]);
  await f.blockDB.createBlock({id:'parent-task',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:'Parent task'}});
  await insert('parent-note','parent-task',{html:'<p>Old</p>',text:'Old'});
  await insert('parent-action','parent-task',{text:'Call supplier',tags:['action-item']});
  await insert('standalone-note',null,{html:'<p>Standalone</p>',text:'Standalone'});
  await insert('note-under-note','standalone-note',{html:'<p>Nested</p>',text:'Nested'});
  const url='/api/working-queue/tasks/parent-task/notes',note0=await f.request(url,{user:1});
  assert.equal(note0.body.noteBlockId,'parent-note');assert.equal(note0.body.note.text,'Old');
  // Guarded glasses update, then stale generic writes and a stale move.
  assert.equal((await f.request(url,{user:1,method:'PUT',body:{note:note('Glasses parent'),expectedRevision:note0.body.revision}})).status,200);
  const pinned=await f.blockDB.updateBlock('parent-note',{properties:{html:'<p>Old</p>',text:'Old',pinned:true}});
  assert.equal(pinned.properties.text,'Glasses parent');assert.equal(pinned.properties.pinned,true);
  await f.blockDB.updateBlock('parent-note',{properties:{pinned:false}});
  assert.equal((await f.blockDB.getBlock('parent-note')).properties.html,'<p>Glasses parent</p>','a bag missing the note keeps it');
  await f.blockDB.rescheduleBlocks([{id:'parent-note',date:f.date,properties:{html:'<p>Old</p>',text:'Old'}}],[]);
  const kept=await f.request(url,{user:1});assert.equal(kept.body.noteBlockId,'parent-note','the legacy row ID is preserved');assert.equal(kept.body.note.text,'Glasses parent');
  // A first task-row note cannot hide the parent-only note, and the note row is never a task-row target.
  await assert.rejects(f.blockDB.updateBlock('parent-task',{taskNotes:note('Hidden'),taskNotesTarget:'task',taskNotesBaseRevisions:[null]}),{statusCode:409,publicCode:'TASK_NOTES_CONFLICT'});
  await assert.rejects(f.blockDB.updateBlock('parent-note',{taskNotes:note('x'),taskNotesTarget:'task',taskNotesBaseRevisions:[null]}),{statusCode:400,publicCode:'TASK_NOTES_INVALID'});
  // A carried-over task reads a note parented to its original row through the local_id alias.
  await f.blockDB.createBlock({id:'alias-origin',type:'block',user_id:1,workspace_id:'ws-1',date:'2026-10-28',properties:{type:'task',title:'Original day'}});
  await f.blockDB.createBlock({id:'alias-carried',type:'block',user_id:1,workspace_id:'ws-1',date:f.date,properties:{type:'task',title:'Carried',local_id:'alias-origin'}});
  await insert('alias-note','alias-origin',{html:'<p>Alias old</p>',text:'Alias old'});
  const aliasUrl='/api/working-queue/tasks/alias-carried/notes',aliasView=await f.request(aliasUrl,{user:1});
  assert.equal(aliasView.body.noteBlockId,'alias-note');
  assert.equal((await f.request(aliasUrl,{user:1,method:'PUT',body:{note:note('Alias glasses'),expectedRevision:aliasView.body.revision}})).status,200);
  await f.blockDB.updateBlock('alias-note',{properties:{html:'<p>Alias old</p>',text:'Alias old'}});
  assert.equal((await f.request(aliasUrl,{user:1})).body.note.text,'Alias glasses');
  // Ordinary notes and action items stay freely editable by generic writes.
  assert.equal((await f.blockDB.updateBlock('standalone-note',{properties:{html:'<p>Edited</p>',text:'Edited'}})).properties.text,'Edited');
  assert.equal((await f.blockDB.updateBlock('note-under-note',{properties:{html:'<p>Nested edit</p>',text:'Nested edit'}})).properties.text,'Nested edit');
  assert.equal((await f.blockDB.updateBlock('parent-action',{properties:{text:'Call supplier back',tags:['action-item']}})).properties.text,'Call supplier back');
 });
});
