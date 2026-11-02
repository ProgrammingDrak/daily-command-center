// Canonical task-owned note shape shared by the owner notes endpoint and every
// explicit notes write (db.js updateBlock `taskNotes`). The browser computes the
// same revision in public/js/block-store.js (taskNotesRevision); keep stable()
// and the UTF-8 SHA-256 identical on both sides.
const {createHash}=require('node:crypto');
const {fail}=require('./conversation-model');
const REVISION_RE=/^[a-f0-9]{64}$/;
// Bases are revision ids, never note snapshots: one per superseded offline draft.
const MAX_BASE_REVISIONS=20;
function stable(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function revision(note){return createHash('sha256').update(stable(note)).digest('hex');}
function revisionOrNull(note){return note==null?null:revision(note);}
function validate(note){
  if(!note||typeof note!=='object'||Array.isArray(note)||typeof note.html!=='string'||typeof note.text!=='string'||!Array.isArray(note.blocks)||note.blocks.length>1000||Buffer.byteLength(JSON.stringify(note))>200000)throw fail('Notes must contain text, HTML and at most 1000 blocks (200 KB maximum)');
  for(const b of note.blocks)if(!b||typeof b!=='object'||!['paragraph','heading','bullet','numbered','checkbox','image'].includes(b.type)||typeof b.id!=='string'||typeof b.content!=='string')throw fail('Invalid notes block');
  return {html:note.html,text:note.text,blocks:note.blocks};
}
// A daily note block written before task-owned notes existed. Its canonical note
// (and so its revision) is derived the same way by every reader and writer.
function isLegacyNoteRow(row){
  const p=(row&&row.properties)||{};
  return !!row&&(row.type==='note'||(typeof p.html==='string'&&typeof p.text==='string'));
}
function legacyNote(props){
  const p=props||{};
  return {html:p.html||'',text:p.text||'',blocks:Array.isArray(p.blocks)?p.blocks:[]};
}
// The note currently stored on a write target: `_taskNotes` on the task row
// (null when none was ever written) or the legacy note block's content.
function storedNote(props,target){
  if(target==='legacy')return legacyNote(props);
  const note=(props||{})._taskNotes;
  return note==null?null:note;
}
module.exports={revision,revisionOrNull,validate,isLegacyNoteRow,legacyNote,storedNote,stable,REVISION_RE,MAX_BASE_REVISIONS};
