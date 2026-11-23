
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {setImmediate}=require('node:timers');

const source=fs.readFileSync(require.resolve('./public/js/working-queue'),'utf8');
const outbox=source.slice(source.indexOf('  const completionPrefix='),source.indexOf('  const esc=DCC.esc'));
const turn=()=>new Promise(resolve=>setImmediate(resolve));

function harness(){
  const storage=new Map(),sent=[],celebrated=[];
  const item=id=>({task:{id},status:'queued',needsYou:true});
  let send, saveNote, version='v1';
  const ctx=vm.createContext({
    crypto:require('node:crypto'),key:'queue:test',state:{revision:1},pending:null,conflict:null,problem:'',
    localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],
      getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    navigator:{onLine:true},document:{querySelectorAll:()=>[]},window:{saveTaskNotes:(...args)=>saveNote?.(...args)},
    requestQueue:async()=>({revision:ctx.state.revision,taskVersion:version}),
    DCC:{api:async()=>({revision:ctx.state.revision,taskVersion:version}),toast(){}},
    assertActionAccount(){},sameAccount:()=>true,items:()=>[item('a'),item('b'),item('c')],render(){},notifySync(){},
    _finishCompletionCelebration:(_rect,id)=>celebrated.push(id),
    setConflict:value=>{ctx.conflict=value;},warn(){},
    sendUnlocked:async body=>{sent.push({...body});await send?.(body);ctx.state.revision++;return {};},
  });
  const methods=vm.runInContext(outbox+'\n({enqueueCompletion,displayedItems,drainCompletions,completionEntries,reviewEntries})',ctx);
  const enqueue=(id,second,note)=>methods.enqueueCompletion({action:'done',sourceEventId:id,taskId:id,expectedRevision:1,at:'2026-11-11T10:00:0'+second+'.000Z'},{taskVersion:'v1'},note);
  return {...methods,ctx,enqueue,sent,celebrated,onSend:fn=>{send=fn;},onNote:fn=>{saveNote=fn;},setVersion:value=>{version=value;}};
}

test('burst previews every task and plays each celebration while writes drain in order',async()=>{
  const h=harness();
  let release;
  h.onSend(body=>body.taskId==='a'?new Promise(resolve=>{release=resolve;}):undefined);
  h.enqueue('a',0);h.enqueue('b',1);h.enqueue('c',2);
  assert.deepEqual(h.displayedItems().map(item=>item.status),['completed','completed','completed']);
  assert.equal(h.displayedItems().some(item=>item.needsYou),false);
  assert.deepEqual(h.celebrated,['a','b','c']);
  await turn();
  assert.deepEqual(h.sent.map(body=>body.taskId),['a']);
  release();await turn();
  assert.deepEqual(h.sent.map(body=>[body.taskId,body.expectedRevision]),[['a',1],['b',2],['c',3]]);
  assert.equal(h.completionEntries().length,0);
});

test('lost response reuses the exact command without replaying the animation',async()=>{
  const h=harness();
  h.onSend(()=>{throw new Error('Response lost');});
  h.enqueue('a',0);await turn();
  h.ctx.state.revision=2;
  h.onSend(()=>{});
  await h.drainCompletions();
  assert.deepEqual(h.sent,[h.sent[0],h.sent[0]]);
  assert.deepEqual(h.celebrated,['a']);
  assert.equal(h.completionEntries().length,0);
});


const revisionChanged=()=>Object.assign(new Error('Revision changed'),{status:409,code:'queue_revision_changed'});

test('confirmed revision rejection creates one durable replacement before sending it',async()=>{
  const h=harness();
  h.onSend(body=>{
    if(body.sourceEventId==='a'){h.ctx.state.revision=2;throw revisionChanged();}
    assert.deepEqual(h.completionEntries()[0].body,body);
    throw new Error('Response lost');
  });
  h.enqueue('a',0);await turn();
  assert.equal(h.sent.length,2);
  assert.notEqual(h.sent[1].sourceEventId,h.sent[0].sourceEventId);
  assert.equal(h.sent[1].expectedRevision,2);
  assert.equal(h.sent[1].at,h.sent[0].at);
  h.onSend(()=>{});
  await h.drainCompletions();
  assert.deepEqual(h.sent[2],h.sent[1]);
  assert.equal(h.completionEntries().length,0);
});

test('changed preview parks the completion and preserves notes while later work saves',async()=>{
  const h=harness();
  const note={text:'Preserved draft'};
  h.onSend(body=>{
    if(body.sourceEventId==='a'){h.setVersion('v2');throw revisionChanged();}
  });
  h.enqueue('a',0,note);h.enqueue('b',1);await turn();
  const review=h.reviewEntries()[0];
  assert.equal(review.body.taskId,'a');
  assert.deepEqual({...review.note},note);
  assert.equal(h.displayedItems()[0].status,'queued');
  assert.deepEqual(h.sent.map(body=>body.taskId),['a','b']);
  assert.equal(h.completionEntries().length,0);
});

test('a second revision rejection parks only that completion',async()=>{
  const h=harness();
  h.onSend(body=>{if(body.taskId==='a')throw revisionChanged();});
  h.enqueue('a',0);h.enqueue('b',1);await turn();
  assert.deepEqual(h.sent.map(body=>body.taskId),['a','a','b']);
  assert.equal(h.reviewEntries().length,1);
});

test('note failure retains the acknowledged entry and retries only the notes',async()=>{
  const h=harness();
  const note={text:'Retry these notes'};
  const attempts=[];
  h.onNote((id,value)=>{attempts.push([id,{...value}]);if(attempts.length===1)throw Object.assign(new Error('Notes failed'),{status:409});});
  h.enqueue('a',0,note);await turn();
  assert.equal(h.completionEntries()[0].acknowledged,true);
  assert.equal(h.reviewEntries().length,0);
  await h.drainCompletions();
  assert.equal(h.sent.length,1);
  assert.deepEqual(attempts,[['a',note],['a',note]]);
  assert.equal(h.completionEntries().length,0);
});
