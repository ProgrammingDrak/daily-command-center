
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
  let send;
  const ctx=vm.createContext({
    key:'queue:test',state:{revision:1},pending:null,conflict:null,problem:'',
    localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],
      getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    navigator:{onLine:true},document:{querySelectorAll:()=>[]},window:{},
    requestQueue:async()=>({revision:ctx.state.revision,taskVersion:'v1'}),
    DCC:{api:async()=>({revision:ctx.state.revision,taskVersion:'v1'}),toast(){}},
    assertActionAccount(){},sameAccount:()=>true,items:()=>[item('a'),item('b'),item('c')],render(){},notifySync(){},
    _finishCompletionCelebration:(_rect,id)=>celebrated.push(id),
    setConflict:value=>{ctx.conflict=value;},warn(){},
    sendUnlocked:async body=>{sent.push({...body});await send?.(body);ctx.state.revision++;return {};},
  });
  const methods=vm.runInContext(outbox+'\n({enqueueCompletion,displayedItems,drainCompletions,completionEntries})',ctx);
  const enqueue=(id,second)=>methods.enqueueCompletion({sourceEventId:id,taskId:id,expectedRevision:1,at:'2026-11-11T10:00:0'+second+'.000Z'},{taskVersion:'v1'});
  return {...methods,ctx,enqueue,sent,celebrated,onSend:fn=>{send=fn;}};
}

test('burst previews every task and plays each celebration while writes drain in order',async()=>{
  const h=harness();
  let release;
  h.onSend(body=>body.taskId==='a'?new Promise(resolve=>{release=resolve;}):undefined);
  h.enqueue('a',0);h.enqueue('b',1);h.enqueue('c',2);
  assert.deepEqual(h.displayedItems().map(item=>item.status),['completed','completed','completed']);
  assert.equal(h.displayedItems().some(item=>item.needsYou),false);
  assert.deepEqual(h.celebrated,['a','b','c']);
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
