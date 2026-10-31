const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {setImmediate}=require('node:timers');
const N=require('./lib/task-notes');
const source=fs.readFileSync(require.resolve('./public/js/sync.js'),'utf8');
const saveSource=source.slice(source.indexOf('function saveNotes('),source.indexOf('\nfunction seedNoteForTask'));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const calls=[];
 const context=vm.createContext({window:{USE_BLOCKSTORE:{notes:true},blockStore:{
  updateBlockDebounced:(...args)=>calls.push(['debounced',...args]),
  updateBlock:(...args)=>{calls.push(['notes',...args]);return Promise.resolve({});},
  taskNotesRevision:N.revision,
  createBlock:(...args)=>{calls.push(['create',...args]);return Promise.resolve({id:'new-note'});},
  deleteBlock:id=>calls.push(['delete',id]),getDayRootId:()=> 'day-a',getCurrentDate:()=> '2026-10-06'
 }}});
 vm.runInContext(saveSource,context);return {context,calls};
}
test('saving one detail note retains identity and never rewrites another task note',()=>{
 const {context,calls}=fixture();
 context.saveNotes({a:{_blockId:'note-a',html:'<p>Edited</p>',text:'Edited'},b:{_blockId:'note-b',html:'Other',text:'Other'}},{taskId:'a'});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['notes','note-a']);
 assert.equal(calls[0][3].taskNotesTarget,'legacy');assert.equal(calls[0][3].taskNotes.text,'Edited');
 assert.ok(Object.hasOwn(calls[0][3],'taskNotesBaseRevision'),'every legacy note save carries its base revision id');
});
test('clearing notes persists an empty override with the same note identity',()=>{
 const {context,calls}=fixture();
 context.saveNotes({a:{_blockId:'note-a',blocks:[],html:'',text:''},b:{_blockId:'note-b',html:'Other',text:'Other'}},{taskId:'a'});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['notes','note-a']);
 assert.equal(calls[0][3].taskNotes.html,'');assert.equal(calls[0][3].taskNotes.text,'');
});
test('untouched empty notes do not create or delete anything',()=>{
 const {context,calls}=fixture();context.saveNotes({},{taskId:'a'});assert.deepEqual(calls,[]);
});
test('new notes keep owner-task reference and use the current canonical day root',async()=>{
 const {context,calls}=fixture(), value={html:'<p>New</p>',text:'New'};
 context.saveNotes({a:value},{taskId:'a'});await Promise.resolve();
 assert.equal(calls[0][0],'create');assert.equal(calls[0][2]._sourceTaskId,'a');
 assert.equal(calls[0][3].parentId,'day-a');assert.equal(value._blockId,'new-note');
});
test('legacy callers retain the existing local-storage fallback',()=>{
 let saved;const context=vm.createContext({window:{},localStorage:{setItem:(key,value)=>saved=[key,value]},NOTES_KEY:'notes-day',scheduleIDBSave:()=>{}});
 vm.runInContext(saveSource,context);context.saveNotes({a:'note'},{taskId:'a'});
 assert.deepEqual(saved,['notes-day','{"a":"note"}']);
});

test('cleared imported notes stay empty after saving and reopening through the block store',async()=>{
 const blocks=[];
 const context=vm.createContext({scheduled:[{id:'a',notes:'Original imported note'}],window:{USE_BLOCKSTORE:{notes:true},blockStore:{
  getByType:type=>blocks.filter(b=>b.type===type),get:id=>blocks.find(b=>b.id===id)||null,taskNotesRevision:N.revision,
  createBlock:(type,properties,options)=>{const block={id:'saved-note',type,properties,parent_id:options.parentId};blocks.push(block);return Promise.resolve(block);},
  updateBlock:(id,_props,extra)=>{const row=blocks.find(b=>b.id===id);row.properties={...row.properties,...extra.taskNotes};return Promise.resolve(row);},
  getDayRootId:()=> 'day-a',getCurrentDate:()=> '2026-10-06'
 }},migrateHtmlToBlocks:html=>[{text:html}],_addModalTaskId:'a',_addModalNotesFingerprint:()=>'',_addModalNotesSnapshot:null,loadNotes:null});
 const noteSource=source.slice(source.indexOf('function loadNotes('),source.indexOf('\nfunction loadActions'));
 vm.runInContext(noteSource,context);
 const features=fs.readFileSync(require.resolve('./public/js/features.js'),'utf8');
 vm.runInContext(features.slice(features.indexOf('function _writeAddModalNotes()'),features.indexOf('\nfunction persistAddModalEdits')),context);
 assert.equal(context.noteBlocksForTask('a',context.loadNotes().a)[0].text,'Original imported note');
 context.window._amBlockEditor={isEmpty:()=>true};
 context._writeAddModalNotes();await Promise.resolve();
 assert.equal(context.noteBlocksForTask('a',context.loadNotes().a),null);
 assert.equal(blocks.length,1);assert.equal(blocks[0].properties._sourceTaskId,'a');
 blocks.push({id:'action-a',type:'block',parent_id:'day-a',properties:{text:'Call supplier',_sourceTaskId:'a',tags:['action-item'],priority:'High'}});
 assert.equal(context.loadNotes().a._blockId,'saved-note','action items never replace a task note');
 context._writeAddModalNotes();await Promise.resolve();assert.equal(blocks.length,2,'repeated clear retains the note and action blocks');
 assert.equal(blocks[0].properties.text,'');assert.equal(blocks[1].properties.text,'Call supplier');
});


test('pool Notes and explicit clears follow the original task row through day switches and scheduling',async()=>{
 const TM=require('./public/js/task-model'),S=require('./public/js/task-serialize');
 const row={id:'api-task',type:'block',date:null,properties:{title:'Private task',kind:'backlog',stage:'Whenever',publicVisibility:'private',sourceReferences:[{kind:'link',url:'https://example.com/original',name:'Original'}]}},rows=[row];let creates=0,whenever=true;
 const writes=[];
 const ctx=vm.createContext({window:{DCC:{TaskModel:TM},USE_BLOCKSTORE:{notes:true},blockStore:{get:id=>rows.find(r=>r.id===id),getByType:type=>rows.filter(r=>r.type===type),createBlock(){creates++;},getCurrentDate:()=> '2026-10-06',taskNotesRevision:N.revision,
  updateBlock:async(id,_props,extra)=>{assert.equal(id,row.id);writes.push(plain(extra));row.properties={...row.properties,_taskNotes:extra.taskNotes};return row;}}},taskAnchorById:()=>({blockId:row.id,ev:TM.fromBacklogBlock(row),whenever})});
 vm.runInContext(source.slice(source.indexOf('function loadNotes('),source.indexOf('function seedNoteForTask')),ctx);
 ctx.saveNotes({'blk-api-task':{html:'<p>Saved note</p>',text:'Saved note',blocks:[{type:'text',content:'Saved note'}]}},{taskId:'blk-api-task'});await Promise.resolve();
 assert.equal(creates,0);assert.equal(row.date,null);assert.equal(ctx.loadNotes()['blk-api-task'].text,'Saved note');
 assert.deepEqual({target:writes[0].taskNotesTarget,base:writes[0].taskNotesBaseRevision},{target:'task',base:null},'first note on a pool row starts from no note');
 // The real task-owned row is global in the cache; no day-root note row is needed.
 row.date='2026-10-07';whenever=false;assert.equal(ctx.loadNotes()['api-task'].text,'Saved note');
 const projected=TM.fromBlock(row);assert.equal(S.taskBlockProps(projected)._taskNotes.text,'Saved note');
 ctx.saveNotes({'api-task':{html:'',text:'',blocks:[]}},{taskId:'api-task'});await Promise.resolve();assert.equal(ctx.loadNotes()['api-task'].text,'');assert.equal(row.properties.publicVisibility,'private');assert.equal(row.properties.sourceReferences[0].name,'Original');
 assert.equal(writes[1].taskNotesBaseRevision,N.revision(writes[0].taskNotes),'the clear is based on the saved note revision id');
});

function notesContext({rows,drafts=[],updateBlock,confirm=()=>true}){
 const toasts=[],discarded=[],listeners={};
 const ctx=vm.createContext({
  window:{USE_BLOCKSTORE:{notes:true},confirm,addEventListener:(name,fn)=>{listeners[name]=fn;},blockStore:{
   get:id=>rows.find(r=>r.id===id)||null,taskNotesRevision:N.revision,updateBlock,
   taskNotesDrafts:()=>drafts.filter(d=>!discarded.includes(d.draftId)),
   discardTaskNotesDraft:id=>{discarded.push(id);return true;}}},
  document:fakeDocument(),showToast:(message,kind)=>toasts.push([message,kind]),
  taskAnchorById:id=>({blockId:id==='task-b'?'task-b-row':'task-row',whenever:false}),
 });
 vm.runInContext(saveSource,ctx);
 return {ctx,toasts,discarded,listeners};
}
function fakeDocument(){
 const createElement=tag=>{const el={tag,children:[],attrs:{},className:'',textContent:'',parentNode:null,onclick:null,
  appendChild(child){child.parentNode=el;el.children.push(child);return child;},
  insertBefore(child,ref){child.parentNode=el;el.children.splice(el.children.indexOf(ref),0,child);return child;},
  setAttribute(key,value){el.attrs[key]=value;},
  remove(){if(!el.parentNode)return;const list=el.parentNode.children;list.splice(list.indexOf(el),1);el.parentNode=null;},
  querySelector(selector){const cls=selector.replace(/^\./,'');const walk=node=>{for(const c of node.children){if(c.className===cls)return c;const hit=walk(c);if(hit)return hit;}return null;};return walk(el);}};return el;};
 return {createElement};
}

test('desktop task notes save against the revision the editor opened with; a conflict is announced once',async()=>{
 const opened={html:'<p>Opened</p>',text:'Opened',blocks:[]},glasses={html:'<p>Glasses</p>',text:'Glasses',blocks:[]};
 const row={id:'task-row',type:'block',date:'2026-10-06',properties:{title:'Task',_taskNotes:opened}},writes=[];
 const conflict=Object.assign(new Error('Notes changed elsewhere. Your draft is retained; review the saved notes before replacing them.'),{status:409,code:'TASK_NOTES_CONFLICT'});
 const {ctx,toasts,listeners}=notesContext({rows:[row],updateBlock:(id,_props,extra)=>{writes.push([id,plain(extra)]);return Promise.reject(conflict);}});
 ctx.rememberTaskNotesBase('task-a');
 // Closing the editor without an edit never writes, even after another surface saved.
 row.properties={...row.properties,_taskNotes:glasses};
 ctx.saveNotes({'task-a':{...opened}},{taskId:'task-a'});assert.equal(writes.length,0);
 ctx.saveNotes({'task-a':{html:'<p>Draft</p>',text:'Draft',blocks:[]}},{taskId:'task-a'});
 await settle();
 assert.equal(writes.length,1);assert.equal(writes[0][0],'task-row');
 assert.deepEqual(writes[0][1],{taskNotes:{html:'<p>Draft</p>',text:'Draft',blocks:[]},taskNotesTarget:'task',taskNotesBaseRevision:N.revision(opened)},'base is the opened revision id, not the newer cached note');
 assert.deepEqual(toasts,[],'the save path leaves the conflict message to the retained-draft event');
 listeners['task-notes-draft-retained']();
 assert.equal(toasts.length,1);assert.match(toasts[0][0],/draft is kept; reopen these notes to recover it/);
 assert.equal(row.properties._taskNotes.text,'Glasses','the newer saved note is not replaced locally');
});

test('desktop legacy note saves use the guarded write with the legacy identity and opened revision',async()=>{
 const legacy={id:'legacy-b',type:'block',properties:{_sourceTaskId:'task-b',html:'<p>Old</p>',text:'Old'}};
 const taskRow={id:'task-b-row',type:'block',properties:{title:'Legacy task'}},writes=[];
 const {ctx,discarded}=notesContext({rows:[legacy,taskRow],updateBlock:(id,_props,extra)=>{writes.push([id,plain(extra)]);return Promise.resolve(legacy);}});
 ctx.rememberTaskNotesBase('task-b',{_blockId:'legacy-b',html:'<p>Old</p>',text:'Old'});
 const openedRevision=N.revision(N.legacyNote(legacy.properties));
 // Glasses saves newer text into the same legacy row while the desktop editor is open.
 legacy.properties={...legacy.properties,html:'<p>Glasses</p>',text:'Glasses',blocks:[]};
 ctx.saveNotes({'task-b':{_blockId:'legacy-b',html:'<p>Desktop</p>',text:'Desktop',blocks:[{id:'p',type:'paragraph',content:'Desktop'}]}},{taskId:'task-b'});
 await settle();
 assert.equal(writes.length,1);assert.equal(writes[0][0],'legacy-b','the legacy note keeps its identity');
 assert.equal(writes[0][1].taskNotesTarget,'legacy');assert.equal(writes[0][1].taskNotesBaseRevision,openedRevision,'so the server rejects the stale desktop save');
 assert.deepEqual(discarded,[]);
});

test('a first note on a resolvable task goes on the task row with no base note, never a separate note block',async()=>{
 const taskRow={id:'task-row',type:'block',date:'2026-10-06',properties:{title:'Scheduled task'}},writes=[],creates=[];
 const {ctx}=notesContext({rows:[taskRow],updateBlock:(id,_props,extra)=>{writes.push([id,plain(extra)]);return Promise.resolve(taskRow);}});
 ctx.window.blockStore.createBlock=(...args)=>{creates.push(args);return Promise.resolve({id:'unexpected'});};
 ctx.rememberTaskNotesBase('task-a',undefined);
 ctx.saveNotes({'task-a':{html:'<p>First</p>',text:'First',blocks:[{id:'p',type:'paragraph',content:'First'}]}},{taskId:'task-a'});
 await settle();
 assert.deepEqual(creates,[],'no separate legacy note block competes with the task row');
 assert.equal(writes.length,1);assert.equal(writes[0][0],'task-row');
 assert.equal(writes[0][1].taskNotesTarget,'task');assert.equal(writes[0][1].taskNotesBaseRevision,null);
 // A task that resolves but is not in this tab's cache still uses its task row.
 const uncached=notesContext({rows:[],updateBlock:(id,_props,extra)=>{writes.push([id,plain(extra)]);return Promise.resolve({});}});
 uncached.ctx.saveNotes({'task-a':{html:'<p>Other</p>',text:'Other',blocks:[]}},{taskId:'task-a'});
 await settle();
 assert.equal(writes.length,2);assert.equal(writes[1][0],'task-row');assert.equal(writes[1][1].taskNotesBaseRevision,null);
});

test('a save that could not be queued keeps the editor starting point and the recovered draft, so retrying really saves',async()=>{
 const saved={html:'<p>Saved</p>',text:'Saved',blocks:[{id:'s',type:'paragraph',content:'Saved'}]};
 const draft={html:'<p>Recovered</p>',text:'Recovered',blocks:[{id:'d',type:'paragraph',content:'Recovered'}]};
 const row={id:'task-row',type:'block',properties:{title:'Task',_taskNotes:saved}},calls=[];
 let storageFull=true;
 const {ctx,discarded,toasts}=notesContext({rows:[row],drafts:[{draftId:'draft-1',id:'task-row',target:'task',note:draft}],updateBlock:(id,_props,extra)=>{
  calls.push(plain(extra));
  // block-store contract: a synchronous throw means nothing was queued.
  if(storageFull)throw new Error('Local save failed. This change has not been queued.');
  return Promise.resolve(row);
 }});
 const parent=ctx.document.createElement('div'),container=ctx.document.createElement('div');parent.appendChild(container);
 let editorBlocks=plain(saved.blocks);
 const editor={getBlocks:()=>plain(editorBlocks),isEmpty:()=>false,setBlocks:blocks=>{editorBlocks=plain(blocks);}};
 ctx.attachTaskNotesEditor('task-a',undefined,container,editor);
 parent.children[0].children[1].onclick(); // Use retained draft
 const save=()=>ctx.saveNotes({'task-a':{html:draft.html,text:draft.text,blocks:editor.getBlocks()}},{taskId:'task-a'});
 save();
 assert.equal(calls.length,1);assert.deepEqual(discarded,[],'the recovered draft is kept while nothing is queued');
 assert.equal(toasts.length,1);assert.match(toasts[0][0],/not saved on this device/);
 // Storage recovers: the identical draft is not mistaken for an already-saved edit.
 storageFull=false;
 save();await settle();
 assert.equal(calls.length,2,'the retry is sent');
 assert.equal(calls[1].taskNotesBaseRevision,N.revision(saved),'still based on the note shown at open');
 assert.deepEqual(calls[1].taskNotes,draft);
 assert.deepEqual(discarded,['draft-1'],'discarded only after the replacement is queued');
 // Once queued, saving the same text again is a no-op rather than a duplicate write.
 save();await settle();assert.equal(calls.length,2);
});

test('a retained draft is offered on the next open and only discarded once used or explicitly deleted',async()=>{
 const saved={html:'<p>Saved</p>',text:'Saved',blocks:[{id:'s',type:'paragraph',content:'Saved'}]};
 const draft={html:'<p>My draft</p>',text:'My draft',blocks:[{id:'d',type:'paragraph',content:'My draft'}]};
 const row={id:'task-row',type:'block',properties:{title:'Task',_taskNotes:saved}},writes=[];
 const drafts=[{draftId:'draft-1',id:'task-row',target:'task',note:draft},{draftId:'other',id:'another-row',target:'task',note:draft}];
 let confirmAnswer=false;
 const {ctx,discarded}=notesContext({rows:[row],drafts,confirm:()=>confirmAnswer,updateBlock:(id,_props,extra)=>{writes.push([id,plain(extra)]);return Promise.resolve(row);}});
 const documentRef=ctx.document;
 const parent=documentRef.createElement('div'),container=documentRef.createElement('div');parent.appendChild(container);
 let editorBlocks=plain(saved.blocks);
 const editor={getBlocks:()=>plain(editorBlocks),isEmpty:()=>false,setBlocks:blocks=>{editorBlocks=plain(blocks);}};
 ctx.attachTaskNotesEditor('task-a',undefined,container,editor);
 const box=parent.children[0];
 assert.equal(box.className,'notes-draft-recovery');assert.equal(box.attrs.role,'status');
 assert.match(box.children[0].textContent,/Retained draft: My draft/);
 const [,useButton,discardButton]=box.children;
 assert.equal(useButton.textContent,'Use retained draft');assert.equal(discardButton.textContent,'Discard draft');
 // Declining the confirmation keeps the draft.
 discardButton.onclick();assert.deepEqual(discarded,[]);assert.equal(parent.children[0],box);
 // Closing without using it keeps it too.
 ctx.saveNotes({'task-a':{html:saved.html,text:saved.text,blocks:editor.getBlocks()}},{taskId:'task-a'});
 assert.equal(writes.length,0);assert.deepEqual(discarded,[]);
 // Reopen, use it: the editor gets the draft and the save replaces the saved note shown at open.
 ctx.attachTaskNotesEditor('task-a',undefined,container,editor);
 parent.children[0].children[1].onclick();
 assert.deepEqual(editorBlocks,draft.blocks);assert.equal(parent.children.length,1,'the notice is removed');
 ctx.saveNotes({'task-a':{html:draft.html,text:draft.text,blocks:editor.getBlocks()}},{taskId:'task-a'});
 await settle();
 assert.equal(writes.length,1);assert.equal(writes[0][1].taskNotesBaseRevision,N.revision(saved));assert.equal(writes[0][1].taskNotes.text,'My draft');
 assert.deepEqual(discarded,['draft-1'],'discarded only after the replacement is queued');
 // An explicit, confirmed discard removes a draft without writing anything.
 drafts.push({draftId:'draft-2',id:'task-row',target:'task',note:draft});confirmAnswer=true;
 ctx.attachTaskNotesEditor('task-a',undefined,container,editor);
 parent.children[0].children[2].onclick();
 assert.deepEqual(discarded,['draft-1','draft-2']);assert.equal(parent.children.length,1);assert.equal(writes.length,1);
});

// ── Quota on close: a notes editor never closes, switches or claims a save on text that
// could not be queued. These drive the real functions from features.js, sync.js and triage.js.
const featuresSource=fs.readFileSync(require.resolve('./public/js/features.js'),'utf8');
const triageSource=fs.readFileSync(require.resolve('./public/js/triage.js'),'utf8');
function fnSource(src,name){
 const at=src.indexOf('function '+name+'(');assert.ok(at>=0,name+' not found');
 const end=src.indexOf('\n}\n',at);assert.ok(end>at,name+' end not found');
 return src.slice(at,end+3);
}
function fakeOverlay(open){
 const state={open};
 return {state,setAttribute(){},classList:{contains:c=>c==='open'&&state.open,remove:c=>{if(c==='open')state.open=false;},add:c=>{if(c==='open')state.open=true;}}};
}
function fakeEditor(blocks){
 let current=plain(blocks);
 return {set:b=>{current=plain(b);},getBlocks:()=>plain(current),isEmpty:()=>!current.length,toHtml:()=>current.map(b=>'<p>'+b.content+'</p>').join(''),toMarkdown:()=>current.map(b=>b.content).join('\n')};
}

test('saveNotes reports whether every note was queued',()=>{
 const row={id:'task-row',type:'block',properties:{title:'Task'}};
 let full=true;
 const {ctx,toasts}=notesContext({rows:[row],updateBlock:()=>{if(full)throw new Error('Local save failed. This change has not been queued.');return Promise.resolve(row);}});
 const draft={'task-a':{html:'<p>Typed</p>',text:'Typed',blocks:[{id:'p',type:'paragraph',content:'Typed'}]}};
 assert.equal(ctx.saveNotes(draft,{taskId:'task-a'}),false);
 assert.equal(toasts.length,1);assert.match(toasts[0][0],/not saved on this device/);
 full=false;
 assert.equal(ctx.saveNotes(draft,{taskId:'task-a'}),true);
 // The no-task create path reports a synchronous enqueue failure the same way.
 const createCtx=vm.createContext({window:{USE_BLOCKSTORE:{notes:true},blockStore:{taskNotesRevision:N.revision,getDayRootId:()=> 'day-a',getCurrentDate:()=> '2026-10-06',
  createBlockQueued:()=>{throw new Error('Local save failed. This change has not been queued.');},createBlock:()=>{throw new Error('the queued create must be used');}}},showToast:()=>{}});
 vm.runInContext(saveSource,createCtx);
 assert.equal(createCtx.saveNotes({cal:{html:'<p>Meeting</p>',text:'Meeting'}},{taskId:'cal'}),false);
});

function addModalContext({saveResult}){
 const overlay=fakeOverlay(true),editor=fakeEditor([{id:'p',type:'paragraph',content:'Opened'}]),calls={saves:[],modes:[],toasts:[],released:[]};
 const ctx=vm.createContext({
  window:{_amBlockEditor:editor},document:{getElementById:id=>id==='add-modal-overlay'?overlay:null,querySelector:()=>null},
  loadNotes:()=>({}),saveNotes:(notes,options)=>{calls.saves.push(plain(notes[options.taskId]));return saveResult.value;},
  setAddModalMode:mode=>calls.modes.push(mode),showToast:(message)=>calls.toasts.push(message),render(){},_flushDeferredRender(){},_setAddModalPageInert(){},
  requestAnimationFrame(){},releaseTaskNotesEditor:id=>calls.released.push(id),persistAddModalCommute(){},
  taskAnchorById:()=>null,taskForRepeatResponsibility:()=>({title:''}),
 });
 vm.runInContext('var _addModalTaskId="task-a",_addModalNotesSnapshot=null,_addModalOpener=null,_addModalBlockId="task-row",_addModalEditing=true,_addModalDraftTitle="",_addModalDraftTags=[],_addModalTagsDirty=false,_addModalDraftRecordingReview=false;\n'
  +['_addModalNotesFingerprint','_addModalNotesUnsaved','_writeAddModalNotes','persistAddModalEdits','closeAddModal','openAddModal','saveAddModalEdits'].map(name=>fnSource(featuresSource,name)).join('\n'),ctx);
 // The editor opened on "Opened"; the user then typed.
 vm.runInContext('_addModalNotesSnapshot=_addModalNotesFingerprint();',ctx);
 editor.set([{id:'p',type:'paragraph',content:'Typed while storage was full'}]);
 return {ctx,overlay,editor,calls,state:name=>vm.runInContext(name,ctx)};
}

test('closing the task details modal with notes that could not be queued keeps it open with the text; a retry closes it',()=>{
 const saveResult={value:false};
 const {ctx,overlay,editor,calls,state}=addModalContext({saveResult});
 const snapshot=state('_addModalNotesSnapshot');
 assert.equal(ctx.closeAddModal(),false,'the close is refused');
 assert.equal(overlay.state.open,true);assert.equal(state('_addModalTaskId'),'task-a');assert.equal(state('_addModalBlockId'),'task-row');
 assert.equal(state('_addModalNotesSnapshot'),snapshot,'the snapshot does not claim the text was saved');
 assert.equal(editor.getBlocks()[0].content,'Typed while storage was full','the editor keeps the text');
 assert.deepEqual(calls.released,[]);assert.equal(calls.saves.length,1);
 // Storage freed: the same close now queues the same text and closes.
 saveResult.value=true;
 assert.equal(ctx.closeAddModal(),true);
 assert.equal(calls.saves.length,2);assert.equal(calls.saves[1].text,'Typed while storage was full');
 assert.equal(overlay.state.open,false);assert.equal(state('_addModalTaskId'),null);assert.deepEqual(calls.released,['task-a']);
});

test('switching the details modal to another task does not rebuild the editor over text that could not be queued',()=>{
 const saveResult={value:false};
 const {ctx,editor,calls,state}=addModalContext({saveResult});
 assert.equal(ctx.openAddModal('task-b','Other task'),false,'the switch is refused before anything is rebuilt');
 assert.equal(state('_addModalTaskId'),'task-a');
 assert.equal(editor.getBlocks()[0].content,'Typed while storage was full');
 assert.equal(calls.saves.length,1);
});

test('Save in the details modal does not claim submission or leave edit mode when the notes could not be queued',()=>{
 const saveResult={value:false};
 const {ctx,calls,state}=addModalContext({saveResult});
 ctx.saveAddModalEdits();
 assert.deepEqual(calls.modes,[],'still in edit mode');
 assert.ok(!calls.toasts.includes('Changes submitted'));
 assert.notEqual(state('_addModalNotesSnapshot'),state('_addModalNotesFingerprint()'),'the text is still unsaved');
 saveResult.value=true;
 ctx.saveAddModalEdits();
 assert.deepEqual(calls.modes,[false]);assert.ok(calls.toasts.includes('Changes submitted'));
 assert.equal(state('_addModalNotesSnapshot'),state('_addModalNotesFingerprint()'));
});

test('the notes drawer stays open with its text when the notes could not be queued; a retry closes it',()=>{
 const overlay=fakeOverlay(true),editor=fakeEditor([{id:'p',type:'paragraph',content:'Drawer text'}]),released=[],saves=[];
 let saveResult=false;
 const ctx=vm.createContext({window:{_notesBlockEditor:editor},document:{getElementById:id=>id==='notes-drawer-overlay'?overlay:null},
  loadNotes:()=>({}),saveNotes:(notes,options)=>{saves.push(plain(notes[options.taskId]));return saveResult;},
  releaseTaskNotesEditor:id=>released.push(id),_flushDeferredRender(){},render(){}});
 vm.runInContext('var currentNotesTaskId="task-a";\n'+fnSource(source,'_saveNotesDrawer')+fnSource(source,'closeNotesDrawer'),ctx);
 assert.equal(ctx.closeNotesDrawer(),false);
 assert.equal(overlay.state.open,true);assert.equal(vm.runInContext('currentNotesTaskId',ctx),'task-a');assert.deepEqual(released,[]);
 assert.equal(editor.getBlocks()[0].content,'Drawer text');
 saveResult=true;
 assert.equal(ctx.closeNotesDrawer(),true);
 assert.equal(overlay.state.open,false);assert.equal(vm.runInContext('currentNotesTaskId',ctx),null);assert.deepEqual(released,['task-a']);
 assert.equal(saves.length,2);assert.equal(saves[1].text,'Drawer text');
});

test('the completion dialog does not complete the task or close when its notes could not be queued',()=>{
 const editor=fakeEditor([{id:'p',type:'paragraph',content:'Done notes'}]),completed=[],closed=[];
 let saveResult=false;
 const ctx=vm.createContext({window:{_dmBlockEditor:editor},document:{getElementById:()=>null,querySelectorAll:()=>[]},
  loadNotes:()=>({}),saveNotes:()=>saveResult,closeDoneModal:()=>closed.push(true),showToast(){}});
 vm.runInContext('var _dmId="task-a",_dmCallback=text=>__completed(text),_dmSessions=[];\n'+fnSource(triageSource,'confirmDoneModal'),ctx);
 ctx.__completed=text=>completed.push(text);
 assert.equal(ctx.confirmDoneModal(),false);
 assert.deepEqual(completed,[]);assert.deepEqual(closed,[]);
 saveResult=true;
 ctx.confirmDoneModal();
 assert.deepEqual(completed,['Done notes']);assert.deepEqual(closed,[true]);
});
