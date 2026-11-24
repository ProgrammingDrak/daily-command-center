const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {setImmediate}=require('node:timers');
const source=fs.readFileSync(require.resolve('./public/js/working-queue.js'),'utf8');

function harness(){
  let dialog,changed=false,pending=false,resolveWrite;
  const writes=[],status={textContent:''},versions=new Map([['historical-row','v1'],['child-row','v2']]);
  const preview=()=>({task:{id:'historical-row',_blockId:'historical-row',title:'Historical task'},
    ids:changed?['historical-row']:['child-row','historical-row'],date:'2026-10-15',versions});
  const page={assertActionAccount(){},prepareTask(){throw new Error('Library deletion must not resolve through today’s queue');},
    deletionPreview:async anchor=>{assert.equal(anchor.blockId,'historical-row');return preview();},
    form:html=>({html,querySelector:()=>status}),esc:value=>value,CSS:{escape:value=>value},
    document:{querySelector:()=>null},requestAnimationFrame:fn=>fn(),invalidate(){},
    DCC:{overlay:{open:options=>{dialog=options;return {el:{querySelector:()=>null}};}}},
    window:{blockStore:{hasPendingWrites:()=>pending},deleteQueueTaskWithUndo:async(...args)=>{
      writes.push(args);if(changed)return {ok:true};
      return new Promise(resolve=>{resolveWrite=resolve;});
    }}};
  vm.createContext(page);
  vm.runInContext(source.slice(source.indexOf('  let openingDelete=false;'),source.indexOf('  async function openSchedule(')),page);
  return {page,writes,status,versions,dialog:()=>dialog,setChanged:()=>changed=true,setPending:()=>pending=true,
    finish:()=>resolveWrite({ok:true})};
}

test('library delete confirms the exact tree, rechecks it, prevents duplicate writes, and refreshes',async()=>{
  const h=harness();let reads=0,settled=0;
  await h.page.openDelete('historical-row',{}, {resolveAnchor:async()=>{reads++;return {blockId:'historical-row',date:'2026-10-15'};},onSettled:()=>settled++});
  assert.match(h.dialog().body.html,/Historical task.*1 nested task/);
  assert.equal(h.writes.length,0,'opening and cancelling must not delete');
  const confirm=h.dialog().actions[1].onClick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await h.dialog().actions[1].onClick(),false);
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0][0]._blockId,'historical-row');
  assert.equal(h.writes[0][0].date,'2026-10-15');
  assert.deepEqual(h.writes[0][1],['child-row','historical-row']);
  assert.equal(h.writes[0][2],h.versions);
  h.finish();assert.equal(await confirm,true);
  assert.equal(reads,2);assert.equal(settled,1);
});

test('a changed tree refuses deletion until its consequences are reviewed again',async()=>{
  const h=harness();
  await h.page.openDelete('historical-row',{}, {resolveAnchor:async()=>({blockId:'historical-row'})});
  h.setChanged();
  assert.equal(await h.dialog().actions[1].onClick(),false);
  assert.equal(h.writes.length,0);
  assert.match(h.status.textContent,/changed.*Reopen Delete/);
});

test('library resolution retains account and pending-write guards',async()=>{
  const h=harness();let reads=0;
  h.setPending();
  await assert.rejects(h.page.openDelete('historical-row',{}, {resolveAnchor:async()=>{reads++;}}),/finish saving/);
  assert.equal(reads,0);
  const switched=harness();
  switched.page.assertActionAccount=()=>{throw new Error('Account changed');};
  await assert.rejects(switched.page.openDelete('historical-row',{}, {resolveAnchor:async()=>({blockId:'historical-row'})}),/Account changed/);
  assert.equal(switched.writes.length,0);
});

test('All Tasks and Someday wire their delete control to the shared preview and undo flow',()=>{
  const library=fs.readFileSync(require.resolve('./public/js/task-library.js'),'utf8');
  assert.match(library,/onDelete:.*trigger => deleteTask\(row,trigger\)/);
  assert.match(library,/DCCWorkingQueue\.openDelete\(row\.id,trigger/);
  assert.match(library,/library\.tasks\.find\(task=>task\.id===row\.id&&!task\.deleted_at\)/);
  assert.doesNotMatch(library,/blockStore\.deleteBlock/);
});

test('drawer dismissal defers pointer and keyboard events while the delete dialog owns focus',()=>{
  const drawer=fs.readFileSync(require.resolve('./public/js/side-drawers.js'),'utf8');
  for(const event of ['pointerdown','keydown']){
    const start=drawer.indexOf('    document.addEventListener("'+event+'", e => {');
    const end=drawer.indexOf('\n    });',start);
    const code=drawer.slice(start,end)+'\n    });';
    let handler,closed=0,trapped=0;
    const page={document:{addEventListener:(_name,fn)=>handler=fn},window:{DCC:{overlay:{activeBlocking:{}}}},
      drawer:()=>({classList:{contains:()=>true},querySelector:()=>null}),closeTasks:()=>closed++,trapFocus:()=>trapped++};
    vm.runInNewContext(code,page);
    handler({key:'Escape',target:{closest:()=>null}});
    assert.equal(closed,0,event+' must not reset the collection under a modal');
    assert.equal(trapped,0,event+' must not steal modal focus');
  }
});
