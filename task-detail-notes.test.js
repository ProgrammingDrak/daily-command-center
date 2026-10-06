const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./public/js/sync.js'),'utf8');
const saveSource=source.slice(source.indexOf('function saveNotes('),source.indexOf('\nfunction seedNoteForTask'));
function fixture(){
 const calls=[];
 const context=vm.createContext({window:{USE_BLOCKSTORE:{notes:true},blockStore:{
  updateBlockDebounced:(...args)=>calls.push(['update',...args]),
  createBlock:(...args)=>{calls.push(['create',...args]);return Promise.resolve({id:'new-note'});},
  deleteBlock:id=>calls.push(['delete',id]),getDayRootId:()=> 'day-a',getCurrentDate:()=> '2026-10-06'
 }}});
 vm.runInContext(saveSource,context);return {context,calls};
}
test('saving one detail note retains identity and never rewrites another task note',()=>{
 const {context,calls}=fixture();
 context.saveNotes({a:{_blockId:'note-a',html:'<p>Edited</p>',text:'Edited'},b:{_blockId:'note-b',html:'Other',text:'Other'}},{taskId:'a'});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['update','note-a']);
 assert.equal(calls[0][2]._sourceTaskId,'a');assert.equal(calls[0][2].text,'Edited');
});
test('clearing notes persists an empty override with the same note identity',()=>{
 const {context,calls}=fixture();
 context.saveNotes({a:{_blockId:'note-a',blocks:[],html:'',text:''},b:{_blockId:'note-b',html:'Other',text:'Other'}},{taskId:'a'});
 assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['update','note-a']);
 assert.equal(calls[0][2].html,'');assert.equal(calls[0][2].text,'');
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
  getByType:type=>blocks.filter(b=>b.type===type),
  createBlock:(type,properties,options)=>{const block={id:'saved-note',type,properties,parent_id:options.parentId};blocks.push(block);return Promise.resolve(block);},
  updateBlockDebounced:(id,properties)=>Object.assign(blocks.find(b=>b.id===id).properties,properties),
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
 assert.equal(blocks[1].properties.text,'Call supplier');
});
