const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const sources=require('./public/js/task-sources');
const serializer=require('./public/js/task-serialize');
const model=require('./public/js/task-model');
const ref=(url='https://example.com/original.png')=>({kind:'image',url,name:'Original.png',mime:'image/png'});
test('multiple typed originals survive serialization, projection and legacy dedupe',()=>{
 const refs=[ref(),{kind:'email',url:'https://mail.google.com/mail/u/0/#inbox/123',name:'Email subject'}, {kind:'file',url:'https://drive.google.com/file/d/123/view',name:'Private.pdf',mime:'application/pdf'}];
 const props=serializer.taskBlockProps({id:'task-a',source:'slack',source_id:'https://clever.slack.com/archives/C1/p123',sourceReferences:refs});
 const task=model.fromBlock({id:'block-a',type:'added_task',properties:props});
 assert.deepEqual(task.sourceReferences,refs);assert.equal(task.source_id,props.source_id);
 assert.equal(sources.collect(task,props.source_id).length,4);
 assert.equal(sources.collect({sourceReferences:[{kind:'slack',name:'Same',url:props.source_id}]},props.source_id).length,1);
});
test('unsafe, local, credentialed and temporary URLs cannot become canonical references',()=>{
 for(const url of ['javascript:alert(1)','jav\tascript:alert(1)','data:image/png;base64,x','blob:https://example.com/1','file:///tmp/x','//example.com/x','https://user:secret@example.com/x','http://localhost/x','http://127.0.0.1/x','http://2130706433/x','http://[::1]/x','http://service.internal/x','https://files.oaiusercontent.com/x','https://chatgpt.com/backend-api/estuary/content?id=file-x','https://example.com/x?access_token=secret','https://example.com/x?X-Amz-Signature=secret','https://example.com/x?Expires=123']){
  assert.equal(sources.safeUrl(url),'',url);assert.throws(()=>sources.validate([ref(url)]),undefined,url);
 }
});
test('host parsing names providers without substring spoofing',()=>{
 assert.equal(sources.kindFor('https://clever.slack.com/archives/C1/p1'),'slack');
 assert.equal(sources.kindFor('https://example.com/slack.com/'),'link');
 assert.equal(sources.kindFor('https://slack.com.evil.com/'),'link');
});
test('limits, MIME, malformed updates, duplicates and explicit clear',()=>{
 assert.deepEqual(sources.validate([]),[]);
 for(const value of [null,{},[null],[{...ref(),name:''}],[{...ref(),mime:'text/html;script'}],[{...ref(),kind:'private-key'}],Array.from({length:21},(_,i)=>ref('https://example.com/'+i)),[ref(),ref()]])assert.throws(()=>sources.validate(value));
});
test('invalid stored references surface unavailable without making an href',()=>{
 const out=sources.collect({sourceReferences:[ref('javascript:alert(1)'),ref()]});
 assert.equal(out[0].unavailable,true);assert.equal(out[0].url,undefined);assert.equal(out[1].url,ref().url);
});
test('source write errors reach forms and the shared queue still recovers',async()=>{
 const state=fs.readFileSync(require.resolve('./public/js/state'),'utf8');
 const fn=state.slice(state.indexOf('function enqueueRowPropsWrite('),state.indexOf('// ── C6b:'));
 let fails=true;
 const ctx=vm.createContext({window:{blockStore:{updateBlock:async()=>{if(fails)throw new Error('revoked');return 'saved';}}},_rowForDateWrite:async()=>({id:'a',properties:{}}),console:{warn(){}}});
 vm.runInContext('let _rowPropsChain=Promise.resolve();'+fn,ctx);
 await assert.rejects(ctx.enqueueRowPropsWrite('a',()=>({sourceReferences:[]}),undefined,{rejectOnError:true}),/revoked/);
 fails=false;assert.equal(await ctx.enqueueRowPropsWrite('a',()=>({sourceReferences:[]}),undefined,{rejectOnError:true}),'saved');
});
test('missing task fails explicitly rather than announcing a saved source',async()=>{
 const state=fs.readFileSync(require.resolve('./public/js/state'),'utf8');
 const fn=state.slice(state.indexOf('function enqueueRowPropsWrite('),state.indexOf('// ── C6b:'));
 const ctx=vm.createContext({window:{blockStore:{}},_rowForDateWrite:async()=>null,console:{warn(){}}});
 vm.runInContext('let _rowPropsChain=Promise.resolve();'+fn,ctx);
 await assert.rejects(ctx.enqueueRowPropsWrite('a',()=>({}),undefined,{rejectOnError:true}),/unavailable/);
});

test('database validates reference updates at the shared writer boundary',()=>{
 const db=fs.readFileSync(require.resolve('./db'),'utf8');
 const fn=db.slice(db.indexOf('function validateBlock('),db.indexOf('// ── Block CRUD'));
 const ctx=vm.createContext({VALID_TYPES:new Set(['block']),require:()=>sources});vm.runInContext(fn,ctx);
 assert.throws(()=>ctx.validateBlock('block',{sourceReferences:[ref('javascript:alert(1)')]}),error=>error.statusCode===400);
 assert.throws(()=>ctx.validateBlock('block',{sourceReferences:null}));
 assert.doesNotThrow(()=>ctx.validateBlock('block',{title:'Preserved'}));
 assert.doesNotThrow(()=>ctx.validateBlock('block',{sourceReferences:[]}));
});
