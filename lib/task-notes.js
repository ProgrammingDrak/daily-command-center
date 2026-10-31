// Canonical task-owned note shape shared by the owner notes endpoint.
const {createHash}=require('node:crypto');
const {fail}=require('./conversation-model');
function stable(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function revision(note){return createHash('sha256').update(stable(note)).digest('hex');}
function validate(note){
  if(!note||typeof note!=='object'||Array.isArray(note)||typeof note.html!=='string'||typeof note.text!=='string'||!Array.isArray(note.blocks)||note.blocks.length>1000||Buffer.byteLength(JSON.stringify(note))>200000)throw fail('Notes must contain text, HTML and at most 1000 blocks (200 KB maximum)');
  for(const b of note.blocks)if(!b||typeof b!=='object'||!['paragraph','heading','bullet','numbered','checkbox','image'].includes(b.type)||typeof b.id!=='string'||typeof b.content!=='string')throw fail('Invalid notes block');
  return {html:note.html,text:note.text,blocks:note.blocks};
}
module.exports={revision,validate};
