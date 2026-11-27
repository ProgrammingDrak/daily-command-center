/* global window, document, localStorage, navigator, CSS, AbortSignal */
// One view over the account coordinator. No client-only foreground state.
(function () {
  'use strict';
  const DCC=window.DCC, account=window.DCC_ACCOUNT_CONTEXT;
  if(!DCC || !account?.userId || !account.workspaceId)return;
  const key='dcc-working-queue:'+account.workspaceId+':'+account.userId;
  const actionAccount={userId:account.userId,workspaceId:account.workspaceId};
  const scope=encodeURIComponent(JSON.stringify([actionAccount.userId,actionAccount.workspaceId]));
  const queueUrl='/api/working-queue';
  const fallbackMs=30000;
  const localTickMs=15000;
  let refreshTimer=null, invalidated=false, scopeRejected=false, readVersion=null;
  const emptyState={revision:0,foreground:[],queue:{items:[],order:[]}};
  // Which queued task is opened into a tile. Display-only: never persisted or sent.
  let openCard=null,justOpened=null; // justOpened: animate only the render that opens it
  const WQ_SVG=d=>'<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const WQ_ICON={
    bolt:WQ_SVG('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
    play:'<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    pause:'<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
    moon:WQ_SVG('<path d="M20 15A8 8 0 1 1 9 4a6.5 6.5 0 0 0 11 11z"/>'),
    cal:WQ_SVG('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    snooze:WQ_SVG('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M5 3 2 6M19 3l3 3"/>'),
    camera:WQ_SVG('<path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    copy:WQ_SVG('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),
    up:WQ_SVG('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    down:WQ_SVG('<path d="M12 5v14M5 12l7 7 7-7"/>'),
    ret:WQ_SVG('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    info:WQ_SVG('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
    trash:WQ_SVG('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    book:WQ_SVG('<path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M4 21a2 2 0 0 1 2-2h14"/>'),
    fold:WQ_SVG('<path d="M6 15l6-6 6 6"/>'),
  };
  let state=emptyState,pending=null,conflict=null,loading=null,sending=false,ticking=false,problem='',startOpening=false;
  try {const cached=JSON.parse(localStorage.getItem(key));if(cached){delete cached.readVersion;state=cached;}pending=JSON.parse(localStorage.getItem(key+':pending'));conflict=JSON.parse(localStorage.getItem(key+':conflict'));}catch(_e){}
  const completionPrefix=key+':completion:';
  const reviewPrefix=key+':review:';
  const rejectedStatuses=[400,404,409];
  let draining=false;
  function storedActions(prefix){
    const entries=[];
    for(let i=0;i<localStorage.length;i++){
      const storageKey=localStorage.key(i);
      if(!storageKey?.startsWith(prefix))continue;
      try {
        const entry=JSON.parse(localStorage.getItem(storageKey));
        if(entry?.body?.sourceEventId)entries.push(entry);
      } catch(_error){}
    }
    return entries.sort((a,b)=>String(a.body.at||'').localeCompare(String(b.body.at||''))
      ||a.body.sourceEventId.localeCompare(b.body.sourceEventId));
  }
  const completionEntries=()=>storedActions(completionPrefix);
  function captureQueueCompletion(entry){
    const row=items().find(item=>item.task.id===entry.body.taskId)?.task;
    DCC.TaskActions?.capture({token:'queue:'+entry.body.sourceEventId,source:'queue-completion',action:'complete',
      targets:entry.targets||DCC.TaskActions?.targetList(entry.body.taskId,row?.date)||[{id:entry.body.taskId,date:row?.date||null}],mutationId:entry.body.sourceEventId});
  }
  function captureQueueUndo(body){
    if(body?.action!=='undo-completion')return;
    const row=items().find(item=>item.task.id===body.taskId)?.task;
    DCC.TaskActions?.capture({token:'queue:'+body.sourceEventId,source:'queue-transition',action:'reopen',targets:DCC.TaskActions.targetList(body.taskId,row?.date)});
  }
  function syncQueueActionReceipts(){
    const entries=completionEntries(),current=new Set(entries.map(entry=>'queue:'+entry.body.sourceEventId));
    for(const entry of entries)captureQueueCompletion(entry);
    DCC.TaskActions?.settleMissing('queue-completion',current,reviewEntries().map(entry=>'queue:'+entry.body.sourceEventId));
  }
  const reviewEntries=()=>storedActions(reviewPrefix);
  const completionKey=entry=>completionPrefix+entry.body.sourceEventId;
  const saveCompletion=entry=>{
    if(!entry.targets)entry.targets=DCC.TaskActions?.targetList(entry.body.taskId,items().find(item=>item.task.id===entry.body.taskId)?.task.date);
    localStorage.setItem(completionKey(entry),JSON.stringify(entry));captureQueueCompletion(entry);
  };
  const reviewKey=id=>reviewPrefix+id;
  const reviewableAction=body=>['queue-dismiss','done'].includes(body?.action);
  function saveReview(entry){
    localStorage.setItem(reviewKey(entry.body.sourceEventId),JSON.stringify(entry));
    notifySync();
  }
  function importLegacyReview(){
    const raw=localStorage.getItem(key+':conflict');
    let saved;
    try { saved=JSON.parse(raw); } catch(_error){ return; }
    if(!reviewableAction(saved?.body)||!saved.body.sourceEventId||[401,403].includes(saved.status))return;
    const id=reviewKey(saved.body.sourceEventId);
    if(!localStorage.getItem(id))saveReview(saved);
    if(localStorage.getItem(key+':conflict')===raw)setConflict(null);
  }
  const previewFor=id=>requestQueue({},null,'/tasks/'+encodeURIComponent(id)+'/completion-preview');
  const previewVersion=preview=>JSON.stringify([preview.taskVersion,preview.history,preview.startedMs,preview.creditUntilMs]);
  function displayedItems(){
    const entries=new Map(completionEntries().map(entry=>[entry.body.taskId,entry]));
    return items().filter(item=>DCC.TaskActions?.stateFor({_blockId:item.task.id,date:item.task.date})?.action!=='delete').map(item=>{
      const entry=entries.get(item.task.id);
      const shared=DCC.TaskActions?.stateFor({_blockId:item.task.id,date:item.task.date});
      if((!entry&&shared?.action!=='complete')||item.status==='completed')return item;
      return {...item,status:'completed',needsYou:false,snoozed:false,dueAt:null,onBreak:false,completedAt:entry?Date.parse(entry.body.at):shared.at,savingCompletion:shared?shared.status==='pending':true};
    });
  }
  function enqueueCompletion(body,preview,note,reviewId){
    assertActionAccount();
    if(conflict)throw new Error('Review the current queue conflict before completing another task.');
    if(completionEntries().some(entry=>entry.body.taskId===body.taskId))throw new Error('This task is already marked done and syncing.');
    saveCompletion({body,preview,note});
    if(reviewId)localStorage.removeItem(reviewKey(reviewId));
    const checkbox=[...document.querySelectorAll('[data-queue-id]')].find(row=>row.dataset.queueId===body.taskId)
      ?.querySelector('.quick-complete-control');
    const rect=checkbox?.getBoundingClientRect();
    render();
    if(typeof _finishCompletionCelebration==='function')_finishCompletionCelebration({rect},body.taskId);
    window.performance?.mark('dcc-completion-rendered');
    notifySync();
    void drainCompletions();
  }
  async function prepareCompletion(entry){
    if(entry.sent&&!entry.revisionRejected)return;
    if(entry.revisionRejected||state.revision!==entry.body.expectedRevision){
      const current=await previewFor(entry.body.taskId);
      assertActionAccount();
      if(previewVersion(current)!==previewVersion(entry.preview)){
        const error=new Error('Task or recorded time changed. Review this completion before retrying.');
        error.status=409;
        throw error;
      }
      const priorId=entry.body.sourceEventId;
      entry.body={...entry.body,expectedRevision:current.revision};
      if(entry.revisionRejected){
        entry.body.sourceEventId='queue:'+crypto.randomUUID();
        entry.retried=true;
        delete entry.revisionRejected;
        // Persist the new request before removing the rejected one. The replacement
        // identifies its predecessor so recovery can handle a crash between writes.
        entry.replaces=priorId;
        entry.sent=true;
        saveCompletion(entry);
        DCC.TaskActions?.finish('queue:'+priorId,'cancelled');
        localStorage.removeItem(completionPrefix+priorId);
        return;
      }
    }
    entry.sent=true;
    saveCompletion(entry);
  }
  async function drainCompletions(){
    if(draining||navigator.onLine===false||conflict)return;
    draining=true;
    const drain=async()=>{
      if(localStorage.getItem(key+':conflict'))return;
      const entries=completionEntries();
      // Keep only the durable replacement if a tab closed during the handoff.
      const replaced=new Set(entries.map(entry=>entry.replaces).filter(Boolean));
      for(const id of replaced)localStorage.removeItem(completionPrefix+id);
      const next=()=>completionEntries().find(entry=>!entry.acknowledged);
      for(let entry=next();entry;entry=next()){
        assertActionAccount();
        pending=JSON.parse(localStorage.getItem(key+':pending')||'null');
        if(pending&&pending.sourceEventId!==entry.body.sourceEventId)return;
        if(window.blockStore?.hasPendingWrites?.()){window.blockStore.flushPending();return;}
        for(;;){
          try{
            await prepareCompletion(entry);
            const result=await sendUnlocked(entry.body,{fromCompletionOutbox:true});
            problem='';
            entry.acknowledged=true;
            saveCompletion(entry);
            DCC.TaskActions?.finish('queue:'+entry.body.sourceEventId);
            window.performance?.mark('dcc-completion-acknowledged');
            DCC.toast('Task completed · '+(result.task?.properties.actualMinutes==null?'focused time unknown':result.task.properties.actualMinutes+'m recorded'),'success');
            break;
          }catch(error){
            if(!sameAccount())return;
            if(conflict||!rejectedStatuses.includes(error.status))throw error;
            if(error.code==='queue_revision_changed'&&!entry.retried&&!entry.revisionRejected){
              entry.revisionRejected=true;
              saveCompletion(entry);
              continue;
            }
            saveReview({body:entry.body,note:entry.note,message:error.message});
            DCC.TaskActions?.finish('queue:'+entry.body.sourceEventId,'rejected');
            localStorage.removeItem(completionKey(entry));
            warn(error);
            break;
          }
        }
      }
      for(const entry of completionEntries().filter(entry=>entry.acknowledged)){
        assertActionAccount();
        try{
          if(entry.note)await window.saveTaskNotes(entry.body.taskId,entry.note);
          assertActionAccount();
          localStorage.removeItem(completionKey(entry));
        }catch(error){
          if(!sameAccount())return;
          if(problem!=='Completion notes are saved on this device. Waiting to sync.')
            DCC.toast('Completion notes are saved on this device. Waiting to sync.','info');
          problem='Completion notes are saved on this device. Waiting to sync.';
        }
      }
      if(!completionEntries().length&&problem==='Completion notes are saved on this device. Waiting to sync.')problem='';
    };
    try {
      if(navigator.locks?.request)await navigator.locks.request(key+':write',drain);
      else await drain();
    } catch(error){
      if(sameAccount()&&!conflict){
        if(problem!=='Completion saved on this device. Waiting to sync.')DCC.toast('Completion saved on this device. Waiting to sync.','info');
        problem='Completion saved on this device. Waiting to sync.';
      }
    } finally {
      draining=false;
      render();
      notifySync();
    }
  }
  const esc=DCC.esc;
  // ======== Instant actions (docs/instant-interactions.md) ========
  // One-tap queue commands change the view at once and are saved on this device
  // as intents, then sent one at a time in tap order. The view is always the
  // server state with the unsent intents predicted on top, so dropping a refused
  // intent restores exactly what it changed and never touches anything newer.
  // Dialog flows (snooze, set aside, switch foreground, block, done, delete)
  // keep confirming in their dialog.
  const intentPrefix=key+':intent:',ackKey=key+':acks',OFFLINE_INTENT='Queue changes are saved on this device. Waiting to sync.';
  let intentCache=null,viewCache=null,intentVersion=0,intentSeq=0,drainPromise=null,intentRetry=null,lastRenderKey='';
  function readIntents(){
    const list=[];
    for(let i=0;i<localStorage.length;i++){
      const storageKey=localStorage.key(i);if(!storageKey?.startsWith(intentPrefix))continue;
      try{const entry=JSON.parse(localStorage.getItem(storageKey));if(entry?.body?.sourceEventId)list.push(entry);}catch(_e){}
    }
    return list.sort((a,b)=>a.seq-b.seq||a.body.sourceEventId.localeCompare(b.body.sourceEventId));
  }
  function intents(){if(!intentCache)intentCache=readIntents();return intentCache;}
  function bumpIntents(){intentCache=null;viewCache=null;intentVersion++;notifySync();}
  const represent=item=>window.DCCQueuePolicy.presentation({...item,status:['foreground','completed'].includes(item.status)?item.status:'queued'});
  // What the server will do to the visible items. Only the fields the card shows;
  // the acknowledged snapshot replaces the prediction a moment later.
  function predict(list,order,b){
    const copy=item=>({...item,task:{...item.task,properties:{...item.task.properties}}});
    const patch=fn=>list.map(item=>item.task.id===b.taskId?fn(copy(item)):item);
    switch(b.action){
      case 'queue-priority':return {list:patch(item=>{item.taskPriority=b.taskPriority;item.task.properties.taskPriority=b.taskPriority;return item;}),order};
      case 'queue-reorder':{
        const at=new Map(b.order.map((id,i)=>[id,i])),rank=item=>at.has(item.task.id)?at.get(item.task.id):Infinity;
        return {list:list.slice().sort((a,c)=>rank(a)-rank(c)),order:b.order.concat(order.filter(id=>!at.has(id)))};
      }
      case 'queue-return':return {list:patch(item=>represent({...item,status:'queued',onBreak:false,breakStartedAt:null})),order};
      case 'queue-dismiss':return {list:patch(item=>represent({...item,dueAt:null,snoozedUntil:null,generation:null,notifiedAt:null})),order};
      case 'queue-unblock':return {list:patch(item=>represent({...item,blocked:false,needsReview:false,dueAt:null,snoozedUntil:null})),order};
      case 'queue-remove':return {list:list.filter(item=>item.task.id!==b.taskId),order:order.filter(id=>id!==b.taskId)};
      case 'pause':return {list:patch(item=>{
        if(!b.attentionMode){item.onBreak=true;item.breakStartedAt=b.at;return item;}
        delete item.task.properties.startedAt;
        return represent({...item,status:'queued',onBreak:false,breakStartedAt:null,snoozedUntil:null,...(b.attentionMode==='needs-you'?{dueAt:b.at,generation:b.sourceEventId}:{dueAt:null})});
      }),order};
      case 'start':return {list:list.map(item=>{
        if(item.task.id===b.taskId){const next=copy(item);next.task.properties.startedAt=b.at;return {...next,status:'foreground',onBreak:false,breakStartedAt:null,needsYou:false,snoozed:false,dueAt:null,snoozedUntil:null,backgroundSince:null};}
        if(item.status!=='foreground')return item;
        const next=copy(item);delete next.task.properties.startedAt;return represent({...next,status:'queued',onBreak:false});
      }),order};
      default:return {list,order};
    }
  }
  function view(){
    const second=Math.floor(Date.now()/1000);
    if(viewCache&&viewCache.state===state&&viewCache.version===intentVersion&&viewCache.second===second)return viewCache;
    let list=(state.queue?.items||[]).map(item=>window.DCCQueuePolicy.presentation(item)),order=(state.queue?.order||[]).slice();
    for(const entry of intents()){try{({list,order}=predict(list,order,entry.body));}catch(_e){}}
    viewCache={state,version:intentVersion,second,list,order};
    return viewCache;
  }
  const items=()=>view().list;
  // Revisions produced by this device's own acknowledged commands. A revision an
  // action was built on is still safe to send against if every change since then
  // was ours; anything else goes as-is and the server refuses it (409).
  function readAcks(){try{return JSON.parse(localStorage.getItem(ackKey))||[];}catch(_e){return [];}}
  function recordAck(from,to){
    if(!Number.isFinite(from)||!Number.isFinite(to)||from===to)return;
    try{localStorage.setItem(ackKey,JSON.stringify(readAcks().filter(ack=>ack.from!==from).concat({from,to}).slice(-50)));}catch(_e){}
  }
  function rebased(revision){
    const current=state.revision;if(!Number.isFinite(revision)||revision===current)return revision;
    const acks=readAcks();let at=revision;
    for(let hops=0;hops<60&&at!==current;hops++){const next=acks.find(ack=>ack.from===at);if(!next)return revision;at=next.to;}
    return at===current?current:revision;
  }
  const intentLabel=b=>({'queue-priority':'Priority change','queue-reorder':'Reorder','queue-return':'Return to Priority','queue-dismiss':'Dismiss reminder','queue-unblock':'Unblock','queue-remove':'Remove',start:'Bring forward',pause:b.attentionMode?'Move':'Pause'})[b.action]||'Queue change';
  // Apply now, save on this device, send in the background. Never waits.
  function instant(body){
    try{
      assertActionAccount();
      if(conflict)throw new Error('Review the current queue conflict before changing tasks.');
      localStorage.setItem(intentPrefix+body.sourceEventId,JSON.stringify({body,seq:Date.now()*1000+(intentSeq++%1000)}));
      bumpIntents();render();
      void drainIntents();
      return Promise.resolve();
    }catch(error){return Promise.reject(error);}
  }
  function scheduleIntentRetry(){if(intentRetry)return;intentRetry=setTimeout(()=>{intentRetry=null;void drainIntents();},5000);}
  function drainIntents(){
    if(drainPromise)return drainPromise;
    if(conflict||!sameAccount()||!intents().length)return Promise.resolve();
    const run=async()=>{
      for(let entry=intents()[0];entry;entry=intents()[0]){
        if(!sameAccount()||conflict)return;
        if(window.blockStore?.hasPendingWrites?.()){window.blockStore.flushPending();scheduleIntentRetry();return;}
        const body=entry.body.action==='queue-dismiss'?entry.body:{...entry.body,expectedRevision:rebased(entry.body.expectedRevision)};
        try{
          const result=await requestQueue({method:'POST',body});
          if(!sameAccount())return;
          recordAck(body.expectedRevision,(result.currentState||result.state)?.revision);
          localStorage.removeItem(intentPrefix+entry.body.sourceEventId);bumpIntents();
          if(problem===OFFLINE_INTENT)problem='';
          apply(result);
        }catch(error){
          if(!sameAccount())return;
          if([401,403].includes(error.status)){setConflict({body,message:error.message,status:error.status});render();return;}
          if(rejectedStatuses.includes(error.status)){
            // Refused: drop only this change. The view falls back by itself.
            localStorage.removeItem(intentPrefix+entry.body.sourceEventId);bumpIntents();render();
            DCC.toast(intentLabel(body)+' was not saved: '+(error.code==='queue_revision_changed'?'the queue changed on another device or worker.':error.message)+' It has been undone.','error',8000);
            refresh().catch(()=>{});
            continue;
          }
          // Offline, timeout or server error: keep it on this device and retry.
          if(problem!==OFFLINE_INTENT){problem=OFFLINE_INTENT;render();}
          notifySync();scheduleIntentRetry();return;
        }
      }
    };
    drainPromise=(navigator.locks?.request?navigator.locks.request(key+':write',run):run()).catch(()=>{}).finally(()=>{drainPromise=null;});
    return drainPromise;
  }
  // Everything the queue renders from. Equal keys mean an identical screen.
  function renderKey(){
    return JSON.stringify([displayedItems().map(i=>[i.task.id,i.status,!!i.needsYou,!!i.snoozed,i.dueAt||null,i.snoozedUntil||null,!!i.onBreak,i.taskPriority,i.actualMinutes??null,!!i.blocked,!!i.needsReview,i.note||'',i.completedAt??null,!!i.savingCompletion,i.task.properties.startedAt||null,i.task.properties.title,i.task.date,i.task.parent_id,i.backgroundSince||null,i.breakStartedAt||null,i.execution?.state||null,(i.delegated||[]).length,i.generation||null]),
      !!state.otherWorkspaceForeground,problem,!!pending,!!conflict,completionEntries().length,reviewEntries().length,sending,openCard,completedPeriod]);
  }
  // A background repaint (a save reply or refresh) that lands between press and
  // release would rebuild the card under the finger and lose the tap, hold or
  // drag. Hold it until release; the click still fires first. Explicit render()
  // calls are never held.
  let pointerHeld=false,heldRender=false;
  document.addEventListener('pointerdown',event=>{if(event.target?.closest?.('#working-queue-root'))pointerHeld=true;},true);
  const releasePointer=()=>{if(!pointerHeld)return;pointerHeld=false;if(heldRender){heldRender=false;setTimeout(()=>{if(!pointerHeld)render();},0);}};
  for(const type of ['pointerup','pointercancel','dragend'])document.addEventListener(type,releasePointer,true);
  window.addEventListener('blur',releasePointer);
  function backgroundRender(){if(pointerHeld){heldRender=true;return;}render();}
  // Dialog commands go after any instant changes already tapped.
  async function settleIntents(){if(intents().length)await drainIntents();}
  let completedPeriod='today'; // Per-view choice only; each new page starts on Today.
  function persist(name,value){if(value==null)localStorage.removeItem(key+name);else localStorage.setItem(key+name,JSON.stringify(value));}
  // Memory, then storage, then the header notice: observers read the new state.
  function notifySync(){document.dispatchEvent(new CustomEvent('dcc:working-queue-sync'));}
  function setPending(value){pending=value;persist(':pending',value);notifySync();}
  function setConflict(value){conflict=value;persist(':conflict',value);notifySync();}
  function newer(value){return value && (value.revision>state.revision || (value.revision===state.revision && (value.queue?.serverNow||'')>=(state.queue?.serverNow||'')));}
  function accept(value, version=null, save=true){
    if(!sameAccount()||!newer(value))return;
    state=value;viewCache=null;
    readVersion=version;
    if(save)persist('',{...value,readVersion:version});
    // An acknowledgement that matches what is already on screen repaints nothing,
    // so it can't cancel a hold or drop :active mid-tap.
    if(renderKey()!==lastRenderKey)backgroundRender();
  }
  function apply(result){window.blockStore?.acceptWorkRotation?.(result.affectedTasks||[]);accept(result.currentState||result.state);window.DCCWorkSessions?.refresh();}
  function requestQueue(options={}, version=null, suffix=''){
    return DCC.api(queueUrl+suffix,{
      cache:'no-store',signal:AbortSignal.timeout(15000),...options,
      headers:{'X-DCC-Queue-Scope':scope,...(version&&{'X-DCC-Queue-Version':version})}
    }).catch(error=>{
      if(error.code==='queue_scope_changed'||(!suffix&&!options.method&&[401,403].includes(error.status))){
        scopeRejected=true;
        render();
      }
      throw error;
    });
  }
  async function refresh(){
    assertActionAccount();
    if(loading)return loading;
    invalidated=false;
    loading=(async()=>{
      const checkedState=state;
      const actionRead=DCC.TaskActions?.readToken();
      let value=await requestQueue({},readVersion);
      assertActionAccount();
      // A conditional hit confirms the state sent with its validator. If a
      // storage or write response replaced it, validate the replacement too.
      if(value.unchanged&&state!==checkedState){
        value=await requestQueue();
        assertActionAccount();
      }
      const hadProblem=problem;
      problem='';
      if(!value.unchanged){
        if(!value.state)throw new Error('Queue connection changed. Reload to continue.');
        accept(value.state,value.version||null);
        DCC.TaskActions?.reconcile(items().map(item=>item.task),actionRead);
      }else if(hadProblem)render();
      return state;
    })().catch(error=>{
      problem=error.message;
      render();
      throw error;
    }).finally(()=>{
      loading=null;
      if(invalidated)invalidate();
    });
    return loading;
  }
  function invalidate(){
    invalidated=true;
    if(loading||refreshTimer!==null||document.hidden||!navigator.onLine||!sameAccount())return;
    refreshTimer=setTimeout(()=>{
      refreshTimer=null;
      if(!document.hidden&&navigator.onLine&&sameAccount())refresh().then(()=>processPendingQueueWork()).catch(()=>{});
    },150);
  }
  function envelope(action,extra={}){return {action,sourceEventId:'queue:'+crypto.randomUUID(),expectedRevision:state.revision,at:new Date().toISOString(),...extra};}
  async function sendUnlocked(body,{fromCompletionOutbox=false}={}){
    assertActionAccount();
    pending=JSON.parse(localStorage.getItem(key+':pending')||'null');
    if(sending)throw new Error('A queue update is still being saved.');
    if(pending && pending.sourceEventId!==body.sourceEventId)throw new Error('Resolve the pending update first.');
    if(window.blockStore?.hasPendingWrites?.()){window.blockStore.flushPending();throw new Error('Wait for your task edits to sync first.');}
    if(body.action!=='queue-dismiss'&&Number.isFinite(body.expectedRevision)){const revision=rebased(body.expectedRevision);if(revision!==body.expectedRevision)body={...body,expectedRevision:revision};}
    sending=true;setPending(body);captureQueueUndo(body);render();
    try {const result=await requestQueue({method:'POST',body});assertActionAccount();recordAck(body.expectedRevision,(result.currentState||result.state)?.revision);setPending(null);apply(result);if(body.action==='undo-completion')DCC.TaskActions?.finish('queue:'+body.sourceEventId);return result;}
    catch(error){
      if(sameAccount()&&[...rejectedStatuses,401,403].includes(error.status)){
        if(body.action==='undo-completion')DCC.TaskActions?.finish('queue:'+body.sourceEventId,'rejected');
        const rejected={body,message:error.message,status:error.status};
        if(reviewableAction(body)&&rejectedStatuses.includes(error.status)){
          if(!fromCompletionOutbox)saveReview(rejected);
        }else setConflict(rejected);
        setPending(null);
        await refresh().catch(()=>{});
      }
      throw error;
    }
    finally{sending=false;render();}
  }
  function send(body){
    const go=()=>navigator.locks?.request?navigator.locks.request(key+':write',()=>sendUnlocked(body)):sendUnlocked(body);
    // Only wait when instant changes are queued ahead; otherwise pending is visible at once.
    return intents().length?settleIntents().then(go):go();
  }
  const warn=error=>DCC.toast(error.message||'Queue update failed','error');
  function activate(id){if(DCC.nav)DCC.nav.go({page:'tasks',view:'queue'});else document.querySelector('.tab[data-tab="working-queue"]')?.click();render();if(id)document.querySelector('[data-queue-id="'+CSS.escape(id)+'"]')?.scrollIntoView({block:'nearest',behavior:DCC.reducedMotion?.()?'auto':'smooth'});}
  // Independent columns: each lane sizes to its own content. Stacked keeps the
  // DOM (and focus) order Foreground, Needs You, Background, Priority Queue.
  const narrow=window.matchMedia('(max-width: 700px)');
  const LANES={stacked:[['wq-foreground','wq-needs'],['wq-background','wq-next']],columns:[['wq-foreground','wq-background'],['wq-needs','wq-next']]};
  function layout(){return LANES[narrow.matches||document.body.classList.contains('device-glasses')||new URLSearchParams(location.search).get('device')==='glasses'?'stacked':'columns'];}
  // Breakpoint change: move the existing lane nodes (shared with the shared-link page).
  const arrangeLanes=()=>{const root=document.getElementById('working-queue-root');window.DCCQueueLayout.arrange(root,layout(),name=>root.querySelector('.wq-grid .wq-lane.'+name));};
  narrow.addEventListener('change',arrangeLanes);
  const appZone=()=>window.DCCCompletedQueueFilter.select([],'today',Date.now(),state.timeZone).timeZone;
  function when(ms,timeZone){return new Intl.DateTimeFormat(undefined,{timeZone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(ms);}
  // Why Return to Priority is unavailable, or '' when it is allowed.
  function returnHold(item){
    if(item.execution?.state==='running')return 'Stop the worker and record its stopped state before returning to Priority.';
    if(item.snoozed)return 'Snoozed requests wait in Background until their check-back time. Dismiss the snooze'+(item.needsReview?' and resolve the '+(item.blocked?'block':'review request'):'')+' before returning to Priority.';
    if(item.needsReview)return (item.blocked?'Unblock this task':'Resolve the review request')+' before returning to Priority.';
    if(item.needsYou)return 'Resolve the review request or due check-back before returning to Priority.';
    return '';
  }
  // Snooze is waiting only: it never starts a worker or focused time. One
  // command per dialog, so a transport retry resends the exact same envelope.
  function snooze(item){
    const targets=item?null:items().filter(row=>row.needsYou&&row.status!=='foreground').map(row=>({taskId:row.task.id,generation:row.generation||null}));
    if(targets&&!targets.length)return;
    if(sending||pending||conflict){warn(new Error('Resolve the current queue update first.'));return;}
    const zone=appZone(),expectedRevision=state.revision;
    const body=form('<p>'+(targets?'Snooze all '+targets.length+' Needs You '+(targets.length===1?'item':'items')+'.':esc(item.task.properties.title||'Task'))+'</p>'+(targets?'<p>Only these attention items are included. If the queue changes, nothing is snoozed; reopen to review it.</p>':'')+'<label>Snooze<select data-minutes aria-label="Snooze duration"><option value="0">Now · Needs You</option><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="1440">24 hours</option><option value="custom">Custom</option></select></label><label data-custom hidden>Minutes (1–1440)<input type="number" min="1" max="1440" value="45"></label><p class="wq-time" data-snooze-preview></p><p class="wq-time">'+(targets?'The selected items wait in Background until the check-back time.':'Choose Now to move to Needs You, or a delay to wait in Background first.')+' Snoozing does not start or stop workers and adds no focused time. The original reason and details stay attached. If the app is closed then, it appears on your next visit; no closed-browser notification is sent.</p>');
    const select=body.querySelector('[data-minutes]'),custom=body.querySelector('[data-custom] input');
    if(targets)select.querySelector('option[value="0"]').remove();
    const minutes=()=>select.value==='custom'?Number(custom.value):Number(select.value);
    let command=null;
    function preview(){const m=minutes(),ok=Number.isInteger(m)&&m>=(targets?1:0)&&m<=1440,from=command?Date.parse(command.at):Date.now();body.querySelector('[data-snooze-preview]').textContent=ok?(m===0?'Moves to Needs You now.':'Snoozed until '+when(from+m*60000,zone)):(targets?'Choose 1–1440 minutes.':'Choose Now or 1–1440 minutes.');}
    select.addEventListener('change',()=>{body.querySelector('[data-custom]').hidden=select.value!=='custom';preview();});custom.addEventListener('input',preview);preview();
    return modal(targets?'Snooze all':'Snooze',body,async()=>{
      if(!command){
        const m=minutes();if(!Number.isInteger(m)||m<(targets?1:0)||m>1440)throw new Error((targets?'Choose 1–1440 minutes.':'Choose Now or 1–1440 minutes.'));
        command=targets?envelope('queue-snooze-all',{targets,expectedRevision,remindMinutes:m}):m===0?envelope('pause',{taskId:item.task.id,attentionMode:'needs-you',expectedRevision}):envelope('queue-snooze',{taskId:item.task.id,expectedRevision,remindMinutes:m,...(item.generation?{generation:item.generation}:{})});
        body.querySelectorAll('select,input').forEach(el=>{el.disabled=true;});preview();
      }
      try {await send(command);}
      catch(error){
        if([400,403,404,409].includes(error.status))throw new Error(error.message+' Close this dialog and review the current task before snoozing again.');
        throw new Error('Snooze not confirmed. Retry uses the same saved update. '+error.message);
      }
    },targets?'Snooze '+targets.length+' '+(targets.length===1?'item':'items'):'Snooze',undefined,targets?()=>document.querySelector('[data-queue-action="snooze-all"]:not(:disabled)')||document.querySelector('[data-queue-action="clear-conflict"]')||document.querySelector('[data-queue-action="retry"]')||document.querySelector('[data-queue-action="add"]'):undefined);
  }
  let detailRows=[];
  function rememberTaskContext(rows){detailRows=rows;}
  function contextRows(){
    const dates=new Set([...detailRows.map(r=>r.date),...items().map(item=>item.task.date)]),rows=new Map(detailRows.map(row=>[row.id,window.blockStore?.get?.(row.id)||row]));
    for(const type of ['block','action_item','note'])for(const row of window.blockStore?.getByType?.(type)||[])if(dates.has(row.date))rows.set(row.id,row);
    for(const item of items())rows.set(item.task.id,window.blockStore?.get?.(item.task.id)||item.task);
    for(const task of DCC.Carryover?.rows?.()||[]){const row=task.__unf?.sourceBlock;if(row&&!rows.has(row.id))rows.set(row.id,row);}
    return [...rows.values()].filter(row=>!row.deleted_at);
  }
  function taskPool(anchor){
    const rows=anchor.sourceRows||[],byId=new Map(rows.map(row=>[row.id,row]));
    return DCC.TaskModel.projectCollection(rows,{canonicalIds:true}).map(ev=>{
      const row=byId.get(ev.id);ev.__unf={sourceId:row.id,sourceDate:row.date,sourceBlock:row};return ev;
    });
  }
  async function refreshTaskContext(taskId){
    const anchor=taskAnchor(taskId);if(!anchor)return;
    await window.loadTaskNotesForAnchor(anchor);
    if(typeof window.renderModalItems==='function')window.renderModalItems(taskId);
  }
  async function addTask(task){
    const row=window.DCCWorkSessions?.blockFor(task);
    if(!row)throw new Error('Task is not synced yet. Wait for it to save, then try again.');
    await refresh();
    await send(envelope('queue-add',{taskId:row.id}));
    activate(row.id);
    const item=items().find(item=>item.task.id===row.id);
    DCC.toast(item?.status==='queued'?'Moved to Priority Queue.':'Added to Working Queue; existing work state preserved.');
  }
  function button(action,label,id,extra=''){return '<button type="button" data-queue-action="'+action+'" data-task-id="'+esc(id||'')+'" '+extra+'>'+label+'</button>';}
  function pathFor(task,index){const parts=[],seen=new Set();let t=task;while(t&&!seen.has(t.id)){seen.add(t.id);parts.unshift(t.title||'Task');t=index.get(DCC.TaskModel.parentIdOf(t));}return parts.join(' › ');}
  function brief(value, limit=150){const text=String(value||'').replace(/\s+/g,' ').trim(), sentence=text.match(/^.{1,150}?[.!?](?:\s|$)/)?.[0]?.trim()||text;return sentence.length>limit?sentence.slice(0,limit-1).trimEnd()+'…':sentence;}
  function contextHtml(item){
    const reports=(item.delegated||[]).slice().sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    const latest=reports[0], summary=brief(latest?.note||item.note), next=brief(latest?.reviewActions?.[0],120);
    if(!summary&&!next&&!reports.length)return '';
    return (summary?'<p class="wq-summary">'+esc(summary)+'</p>':'')+(next?'<p class="wq-summary"><strong>Next:</strong> '+esc(next)+'</p>':'')+
      '<details class="wq-context"><summary>Details</summary>'+(item.note?'<p class="wq-note">'+esc(item.note)+'</p>':'')+reports.map(report=>'<div class="wq-note"><small>'+esc(report.work.source+' · '+report.phase+' · '+report.at)+'</small><p>'+esc(report.note)+'</p>'+(report.reviewActions.length?'<ul>'+report.reviewActions.map(action=>'<li>'+esc(action)+'</li>').join('')+'</ul>':'')+'</div>').join('')+'</details>';
  }
  function render(){
    const root=document.getElementById('working-queue-root');if(!root)return;
    if(!sameAccount()){root.replaceChildren();return;}
    const focused=document.activeElement,focusKey=focused?.dataset.queueAction,focusId=focused?.dataset.taskId;
    const completedOpen=root.querySelector('.wq-completed')?.open;
    const periodFocused=focused?.matches('[data-completed-period]');
    const all=displayedItems();
    lastRenderKey=renderKey();
    const completionView=window.DCCCompletedQueueFilter.select(all,completedPeriod,Date.now(),state.timeZone);
    const periodLabel=window.DCCCompletedQueueFilter.options.find(([value])=>value===completedPeriod)[1];
    const helpOpen=new Set(Array.from(root.querySelectorAll('.wq-help[open]')).map(el=>el.dataset.queueHelp));
    const helpFocused=focused?.closest('.wq-help')?.dataset.queueHelp;
    const contextOpen=new Set(Array.from(root.querySelectorAll('.wq-context[open]')).map(el=>el.closest('[data-queue-id]').dataset.queueId));
    const contextFocused=focused?.matches('.wq-context > summary')?focused.closest('[data-queue-id]').dataset.queueId:null;
    const completedFocused=focused?.matches('.wq-completed > summary');
    const index=new Map((window.DCCWorkSessions?.availableTasks()||[]).map(t=>[t.id,t]));all.forEach(i=>{const t=DCC.TaskModel.fromBlock(i.task);index.set(t.id,t);});
    const cards=[];
    // Rows + Tiles: Needs You, Priority and Background tasks are compact rows.
    // Foreground, and the one row opened in place, render as a full tile. Opening
    // and folding is display-only (openCard), so it never waits on the network.
    function card(item){
      const row=item.task,task=DCC.TaskModel.fromBlock(row),foreground=item.status==='foreground',completed=item.status==='completed';
      const tile=!completed&&(foreground||openCard===row.id);
      const id=row.id,title=pathFor(task,index),exactTitle=String(row.properties.title??task.title??'');
      const elapsed=item.backgroundSince?Math.max(0,Math.floor((Date.now()-Date.parse(item.backgroundSince))/60000)):0;
      const reminder=item.snoozed?'':item.dueAt?(Date.parse(item.dueAt)<=Date.now()?'Check back now':'Check back in '+Math.max(1,Math.ceil((Date.parse(item.dueAt)-Date.now())/60000))+'m'):'';
      const actual=item.actualMinutes==null?'Focused actuals unknown':item.actualMinutes+'m focused saved';
      const activeMinutes=foreground&&!item.onBreak?Math.max(0,Math.floor((Date.now()-Date.parse(row.properties.startedAt))/60000)):0;
      const held=!completed&&!foreground&&returnHold(item);
      const statusKey=completed?'completed':foreground?'foreground':item.needsYou?'needs':item.snoozed?'snoozed':item.status==='queued'?'priority':'background';
      const statusLabel=item.needsYou?'Needs You':item.snoozed?'Snoozed':item.status==='queued'?'Priority':foreground?'Foreground':completed?'Completed':'Background'; // the break veil carries 'On a break'
      const snoozedUntil=item.snoozed?when(Date.parse(item.snoozedUntil),completionView.timeZone):'';
      const finished=item.savingCompletion?'<p class="wq-time">Done &middot; saving&hellip;</p>':completed?(Number.isFinite(item.completedAt)?'<p class="wq-time"><time datetime="'+new Date(item.completedAt).toISOString()+'">Completed '+esc(new Intl.DateTimeFormat(undefined,{timeZone:completionView.timeZone,dateStyle:'medium',timeStyle:'short'}).format(item.completedAt))+'</time></p>':'<p class="wq-time">Completion time unavailable</p>'):'';
      const levels=DCC.TaskPriority.levels,priority=levels.includes(item.taskPriority)?item.taskPriority:'Medium',level=levels.indexOf(priority),nextPriority=levels[(level+1)%levels.length];
      const pLabel=priority+' priority. Click to change to '+nextPriority+' priority. Tap, hold, Shift+Enter or Arrow Down to choose.';
      const glyph={'Very low':'⇊',Low:'↓',Medium:'=',High:'↑','Very high':'⇈'}[priority];
      const readingUrl=DCC.safeUrlAttr?.(row.properties?.readingSession?.url||'');
      const ttl='<span class="ttl" role="button" tabindex="0" aria-label="Open task details: '+esc(task.title)+'" title="'+esc(title)+'">'+esc(title)+'</span>';
      const complete=completed||item.savingCompletion?'':'<button type="button" class="wq-complete quick-complete-control" data-queue-action="complete" data-task-id="'+esc(id)+'" title="Tap to complete. Hold for the same completion flow." aria-label="Complete task: '+esc(task.title)+'">'+WQ_ICON.bolt+'</button>';
      const prio=completed?'':button('priority',tile?'<span aria-hidden="true">'+glyph+'</span><span class="wq-priority-label">'+priority+'</span>':'<span aria-hidden="true">'+glyph+'</span>',id,'class="wq-priority-symbol'+(tile?' wq-priority-badge':'')+'" data-priority-level="'+level+'" aria-haspopup="dialog" aria-label="'+esc(pLabel)+'" title="'+esc(pLabel)+'"');
      const status='<span class="wq-status" data-wq-status="'+statusKey+'">'+esc(statusLabel)+'</span>';
      const tool=(action,icon,label,extra='')=>button(action,WQ_ICON[icon]+'<span>'+label+'</span>',id,'class="wq-tool'+(action==='delete'?' wq-tool-danger':'')+'" '+extra);
      const node=document.createElement('div');
      node.className='wq-card '+(tile?'wq-tile':'wq-row')+(foreground?' wq-focus':'')+(item.onBreak?' wq-on-break':'')+(completed?' wq-done':'')+(tile&&justOpened===id?' wq-opening':'');
      node.dataset.queueId=id;node.dataset.wqStatus=statusKey;
      if(!tile){
        const meta=completed?'':esc(item.snoozed?'Snoozed until '+snoozedUntil:reminder||actual+(item.backgroundSince?' · '+elapsed+'m waiting':''));
        node.innerHTML='<div class="wq-row-main">'+complete+
          '<button type="button" class="wq-row-hit" data-queue-action="'+(completed?'details':'expand')+'" data-task-id="'+esc(id)+'"'+(completed?'':' aria-expanded="false"')+' aria-label="'+esc((completed?'Open task details: ':'Open: ')+title)+'"><span class="wq-row-title">'+esc(title)+'</span><span class="wq-row-meta">'+status+(meta?' · '+meta:'')+'</span>'+finished+'</button>'+
          prio+(completed?'':button('focus',WQ_ICON.play,id,'class="wq-play" aria-label="Bring forward: '+esc(task.title)+'" title="Bring forward"'))+
          (completed&&!item.savingCompletion?button('delete',WQ_ICON.trash,id,'class="wq-row-delete" aria-haspopup="dialog" aria-label="Delete task: '+esc(task.title)+'"'):'')+'</div>';
      }else{
        const band='<div class="wq-band">'+prio+'<span class="wq-band-end">'+status+(foreground?'':button('expand',WQ_ICON.fold,id,'class="wq-fold" aria-expanded="true" aria-label="Fold back to a row" title="Fold back to a row"'))+'</span></div>';
        const titleRow='<div class="wq-tile-title">'+ttl+'<button type="button" class="wq-copy-title" data-queue-action="copy-title" data-task-id="'+esc(id)+'" aria-label="Copy task title: '+esc(exactTitle)+'" title="Copy task title">'+WQ_ICON.copy+'</button></div>';
        const attention=(reminder?'<div class="wq-banner wq-banner-due"><span class="wq-attention">'+esc(reminder)+'</span>'+(item.dueAt?button('dismiss','Dismiss reminder',id):'')+'</div>':'')+
          (item.snoozed?'<div class="wq-banner wq-banner-snoozed"><span><span class="wq-attention">Snoozed until '+esc(snoozedUntil)+'</span><span class="wq-time">Attention snoozed; worker state and focused time are unchanged.</span></span>'+(item.dueAt?button('dismiss','Dismiss reminder',id):'')+'</div>':'')+
          (held?'<p class="wq-time wq-held" id="queue-return-'+esc(id)+'">'+esc(held)+'</p>':'')+finished;
        let body,bar,strip;
        if(foreground){
          const progress=Math.min(1,activeMinutes/25),circ=2*Math.PI*44;
          body='<div class="wq-fg"><div class="wq-ring" aria-hidden="true"><svg viewBox="0 0 108 108"><circle cx="54" cy="54" r="44" class="wq-ring-track"/><circle cx="54" cy="54" r="44" class="wq-ring-fill" stroke-dasharray="'+(progress*circ).toFixed(1)+' '+circ.toFixed(1)+'" transform="rotate(-90 54 54)"/></svg><span><b>'+activeMinutes+'</b>min</span></div><div class="wq-fg-text">'+titleRow+'<p class="wq-time">'+esc(item.onBreak?'Timer paused · '+actual:activeMinutes+'m this session · '+actual)+'</p></div></div>';
          bar=button('pause',WQ_ICON.pause+'Pause',id,'class="wq-big wq-big-amber"')+button('background',WQ_ICON.moon+'Send to background',id,'class="wq-big"')+'<button type="button" class="wq-big btn-schedule" data-schedule-id="'+esc(id)+'" aria-label="Schedule">'+WQ_ICON.cal+'Schedule</button>';
          strip=complete.replace('class="wq-complete quick-complete-control"','class="wq-tool wq-tool-done quick-complete-control"').replace(WQ_ICON.bolt,WQ_ICON.bolt+'<span>Done</span>')+tool('photo','camera','Photo','aria-label="Add task photos"')+tool('details','info','Details')+(item.savingCompletion?'':tool('delete','trash','Delete','aria-haspopup="dialog" aria-label="Delete task: '+esc(task.title)+'"'));
        }else{
          const stat=(value,label)=>'<div class="wq-stat"><b>'+esc(value)+'</b><span>'+label+'</span></div>';
          body=titleRow+'<div class="wq-stats">'+stat(item.actualMinutes==null?'—':item.actualMinutes+'m','Focused saved')+stat(item.backgroundSince?elapsed+'m':'—','Waiting')+stat(item.snoozed?new Intl.DateTimeFormat(undefined,{timeZone:completionView.timeZone,hour:'numeric',minute:'2-digit'}).format(Date.parse(item.snoozedUntil)):reminder?(Date.parse(item.dueAt)<=Date.now()?'Now':reminder.replace('Check back in ','')):'—','Check back')+'</div>';
          bar=button('focus',WQ_ICON.play+'Bring forward',id,'class="wq-big wq-big-go"')+'<button type="button" class="wq-big btn-schedule" data-schedule-id="'+esc(id)+'" aria-label="Schedule">'+WQ_ICON.cal+'Schedule</button>'+button('snooze',WQ_ICON.snooze+'Snooze',id,'class="wq-big" aria-haspopup="dialog"');
          strip=complete.replace('class="wq-complete quick-complete-control"','class="wq-tool wq-tool-done quick-complete-control"').replace(WQ_ICON.bolt,WQ_ICON.bolt+'<span>Done</span>')+tool('photo','camera','Photo','aria-label="Add task photos"')+
            tool('up','up','Up','aria-label="Move up" title="Move up one position. Hold or Shift+Enter to move to the top of this group."')+tool('down','down','Down','aria-label="Move down" title="Move down one position. Hold or Shift+Enter to move to the top of this group."')+
            tool('return','ret','Return',held?'disabled aria-describedby="queue-return-'+esc(id)+'" aria-label="Return to Priority"':'aria-label="Return to Priority" title="Return to Priority"')+tool('details','info','Details')+(item.savingCompletion?'':tool('delete','trash','Delete','aria-haspopup="dialog" aria-label="Delete task: '+esc(task.title)+'"'));
        }
        node.innerHTML=band+'<div class="wq-tile-body">'+body+attention+contextHtml(item)+(readingUrl?'<a class="wq-book" href="'+readingUrl+'" rel="noreferrer">'+WQ_ICON.book+'Open book in QuietShelf</a>':'')+'</div><div class="wq-bar">'+bar+'</div><div class="wq-strip">'+strip+'</div>';
        if(foreground&&!item.onBreak&&window.DCCWorkSessions?.checkInHtml)node.querySelector('.wq-tile-body').insertAdjacentHTML('beforeend',window.DCCWorkSessions.checkInHtml(task,Date.now()));
      }
      node.querySelectorAll('.btn-schedule').forEach(schedule=>schedule.addEventListener('click',event=>{event.stopPropagation();openSchedule(item,schedule).catch(warn);}));
      node.querySelectorAll('[data-queue-action="photo"]').forEach(photo=>photo.addEventListener('click',event=>{
        event.stopPropagation();
        if(typeof window.openAddModal!=='function')return;
        const anchor=typeof window.taskAnchorById==='function'?window.taskAnchorById(task._blockId)||window.taskAnchorById(task.id):null;
        window.openAddModal(task.id,task.title,{anchor,generic:true,tab:'photos'});
      }));
      const ttlEl=node.querySelector('.ttl');
      if(ttlEl){
        ttlEl.addEventListener('click',event=>{event.stopPropagation();openDetails(id).catch(warn);});
        ttlEl.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();openDetails(id).catch(warn);}});
      }
      const copy=node.querySelector('.wq-copy-title');
      if(copy){
        copy.addEventListener('pointerdown',event=>event.stopPropagation());
        copy.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();const hadFocus=document.activeElement===copy;copy.disabled=true;try{const ok=await DCC.copyText(exactTitle);DCC.toast(ok?'Title copied':'Could not copy title. Select the title and copy it manually.',ok?'success':'error');}finally{copy.disabled=false;if(hadFocus&&document.activeElement===document.body){const current=document.querySelector('[data-queue-id="'+CSS.escape(id)+'"] .wq-copy-title');current?.focus({preventScroll:true});}}});
      }
      node.tabIndex=0;node.draggable=!completed;
      node.querySelectorAll('[data-queue-action="complete"]').forEach(done=>DCC.bindHoldAction(done,()=>transition('done',item).catch(warn),()=>transition('done',item).catch(warn)));
      if(item.onBreak){
        // Cover the whole tile. Keep the underlying layout intact, but remove
        // every covered control from use.
        for(const child of node.children){child.inert=true;child.setAttribute('aria-hidden','true');}
        node.tabIndex=-1;node.draggable=false;node.setAttribute('role','group');
        node.setAttribute('aria-label','Paused task: '+task.title);
        const veil=document.createElement('div');veil.className='wq-break-veil';
        veil.innerHTML='<div class="wq-break-header"><span class="wq-break-title">'+esc(title)+'</span><span class="wq-break-badge">On a break</span>'+button('break-options','⋯',id,'aria-label="Task options" aria-haspopup="dialog"')+'</div><div class="wq-break-body"><div class="wq-break-copy"><strong role="status"><span class="wq-break-symbol" aria-hidden="true">Ⅱ</span> I’m on a break</strong><p><span data-break-clock data-break-since="'+esc(item.breakStartedAt)+'"></span> on break<span class="wq-break-timer-note">Work timer paused</span></p></div>'+button('focus','▶ Resume task',id)+'</div>';
        veil.addEventListener('click',event=>{if(!event.target.closest('[data-queue-action]'))event.stopPropagation();});
        node.appendChild(veil);
      }
      const priorityButton=node.querySelector('[data-queue-action="priority"]');
      if(priorityButton){
        const choose=()=>choosePriority(item);
        let touch=false;priorityButton.addEventListener('pointerdown',event=>{touch=event.pointerType==='touch';});
        DCC.bindHoldAction(priorityButton,()=>{if(touch){touch=false;choose();return;}instant(envelope('queue-priority',{taskId:id,taskPriority:nextPriority})).catch(warn);},choose);
        priorityButton.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();choose();}});
      }
      node.querySelectorAll('[data-queue-action="up"],[data-queue-action="down"]').forEach(control=>DCC.bindHoldAction(control,()=>reorder(id,control.dataset.queueAction==='up'?-1:1)?.catch(warn),()=>reorder(id,'top')?.catch(warn)));
      cards.push(node);return '<div data-wq-card="'+(cards.length-1)+'"></div>';
    }
    function lane(title,rows,empty,cls='',policy='') {return '<section class="wq-lane '+cls+'" data-queue-lane="'+cls+'"><div class="wq-heading"><h2>'+title+' <small>'+rows.length+'</small></h2>'+(policy==='needs'?button('snooze-all',sending?'Saving…':'Snooze all',null,'aria-haspopup="dialog" aria-label="Snooze all '+rows.length+' Needs You items" '+(!rows.length||sending||pending||conflict?'disabled':'')):'')+(policy==='foreground'?button('pomodoro',window.DCCPomodoro?.label()||'🍅',null,'aria-label="Create or open Pomodoro focus plan" aria-haspopup="dialog"'):'')+'<details class="wq-help" data-queue-help="'+policy+'"><summary aria-label="About '+title+'">ⓘ</summary><p>'+esc(window.DCCQueuePolicy.tips[policy])+'</p></details></div>'+(cls==='wq-next'?'<p class="wq-empty">Very high → High → Medium → Low → Very low. Move tasks within a priority; change Priority to move between levels.</p>':'')+(rows.length?rows.map(card).join(''):'<p class="wq-empty">'+empty+'</p>')+'</section>';}
    const {foreground:fg,needs,background,priority:upNext}=window.DCCQueuePolicy.lanes(all,DCC.TaskPriority.group);
    const lanes={'wq-foreground':lane('Foreground',fg,'Choose a task below to begin focused work.','wq-foreground','foreground'),'wq-needs':lane('Needs You',needs,'No reported review actions or manual check-backs due.','wq-needs','needs'),'wq-next':lane('Priority Queue',upNext,'No inactive tasks in your queue. Add existing tasks to prioritize them.','wq-next','priority'),'wq-background':lane('Background',background,'No active workers or snoozed requests.','wq-background','background')};
    root.dataset.priorityStyle='outline';
    const reviewCount=reviewEntries().length;
    const syncMessage=sending?'Saving…':problem||((pending||completionEntries().length)?'Update awaiting confirmation.':'');
    root.innerHTML='<header class="wq-header">'+button('journal','<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5A2.5 2.5 0 0 0 4 21.5 2.5 2.5 0 0 0 6.5 24H20"/><path d="M8 7h8"/></svg><span>Journal</span>',null,'class="wq-journal" title="Open the journal for the day on screen"')+button('add','Add tasks')+'</header>'+
      (syncMessage?'<p class="wq-sync" role="status">'+esc(syncMessage)+'</p>':'')+
      ((pending||completionEntries().length||problem===OFFLINE_INTENT)&&!conflict?button('retry','Retry saved update'):'')+
      (conflict?'<div class="wq-conflict wq-actions"><span>Update conflict.</span>'+button('conflict','Review change')+button('clear-conflict','Dismiss conflict')+'</div>':'')+
      (!conflict&&reviewCount?'<div class="wq-conflict wq-actions"><span>'+reviewCount+' '+(reviewCount===1?'change needs':'changes need')+' review.</span>'+button('conflict','Review change')+'</div>':'')+
      (state.otherWorkspaceForeground?'<p class="wq-conflict">Another workspace holds Foreground. Open it, pause if needed, then choose Return to Priority before bringing a task forward here.</p>':'')+
      '<div class="wq-grid">'+layout().map(names=>'<div class="wq-col">'+names.map(name=>lanes[name]).join('')+'</div>').join('')+'</div>'+completedHtml();
    function completedHtml(){
      const help=completedPeriod==='today'?'Calendar day · '+completionView.timeZone:completedPeriod==='latest'?'Most recent known completion':completedPeriod==='all'?'All retained queue history':'Rolling last '+periodLabel.toLowerCase();
      return '<details class="wq-completed"><summary>Completed · '+esc(periodLabel)+' · '+completionView.rows.length+'</summary><div class="wq-completed-controls"><label>Completed timeframe<select data-completed-period aria-describedby="wq-completed-help">'+window.DCCCompletedQueueFilter.options.map(([value,label])=>'<option value="'+value+'"'+(value===completedPeriod?' selected':'')+'>'+label+'</option>').join('')+'</select></label><p class="wq-time" id="wq-completed-help">'+esc(help)+'</p></div><p class="wq-time" role="status">'+completionView.rows.length+' of '+completionView.total+' retained completed tasks'+(completionView.unknown?' · '+completionView.unknown+' without a completion time'+(completedPeriod==='all'?'':' (shown in All time)'):'')+'</p>'+(completionView.rows.length?completionView.rows.map(card).join(''):'<p class="wq-empty">No completed tasks in this time range.</p>')+'</details>';
    }
    root.querySelectorAll('[data-wq-card]').forEach(slot=>slot.replaceWith(cards[Number(slot.dataset.wqCard)]));
    for(const id of contextOpen)root.querySelector('[data-queue-id="'+CSS.escape(id)+'"] .wq-context')?.setAttribute('open','');
    if(contextFocused)root.querySelector('[data-queue-id="'+CSS.escape(contextFocused)+'"] .wq-context > summary')?.focus({preventScroll:true});
    for(const id of helpOpen)root.querySelector('[data-queue-help="'+CSS.escape(id)+'"]')?.setAttribute('open','');
    if(helpFocused)root.querySelector('[data-queue-help="'+CSS.escape(helpFocused)+'"] > summary')?.focus({preventScroll:true});
    if(completedOpen)root.querySelector('.wq-completed')?.setAttribute('open','');
    if(periodFocused)root.querySelector('[data-completed-period]')?.focus({preventScroll:true});
    if(completedFocused)root.querySelector('.wq-completed > summary')?.focus({preventScroll:true});
    updateBreakClocks();
    if(focusKey==='focus'&&items().some(i=>i.task.id===focusId&&!i.onBreak))root.querySelector('[data-queue-action="pause"][data-task-id="'+CSS.escape(focusId||'')+'"]')?.focus({preventScroll:true});
    if(focusKey)root.querySelector('[data-queue-action="'+CSS.escape(focusKey==='pause'&&items().some(i=>i.task.id===focusId&&i.onBreak)?'focus':focusKey)+'"][data-task-id="'+CSS.escape(focusId||'')+'"]')?.focus({preventScroll:true});
  }
  function choosePriority(item){
    const body=form('<label>Priority<select data-priority aria-label="Priority" size="5">'+DCC.TaskPriority.levels.map((level,i)=>'<option value="'+level+'"'+(level===(item.taskPriority||'Medium')?' selected':'')+'>'+['⇊','↓','=','↑','⇈'][i]+' '+level+'</option>').join('')+'</select></label>');
    modal('Choose priority',body,()=>instant(envelope('queue-priority',{taskId:item.task.id,taskPriority:body.querySelector('[data-priority]').value})));
  }
  function taskAnchor(id){
    const item=items().find(i=>i.task.id===id)||items().find(i=>i.task.properties.local_id===id);
    const row=item?.task||contextRows().find(r=>r.id===id);if(!row)return null;
    const ev=DCC.TaskModel.fromBlock(row);ev.__unf={sourceId:row.id,sourceDate:row.date,sourceBlock:row};
    return {ev,date:row.date,blockId:row.id,carryover:true,queue:true,sourceRows:contextRows().filter(r=>r.date===row.date)};
  }
  async function prepareTask(id){
    if(window.blockStore?.hasPendingWrites?.())throw new Error('Wait for task edits to finish saving.');
    await refresh();const anchor=taskAnchor(id);if(!anchor)throw new Error('Task is no longer in the queue.');
    window.blockStore?.acceptWorkRotation?.([anchor.ev.__unf.sourceBlock]);return anchor;
  }
  async function openDetails(id){
    const anchor=await prepareTask(id);anchor.noteValue=await window.loadTaskNotesForAnchor(anchor);window.openTaskNotes(anchor.ev,{anchor});
    const item=items().find(i=>i.task.id===anchor.blockId),host=document.querySelector('#add-modal-overlay .add-modal-body');
    if(host&&item){
      host.querySelector('.wq-task-context')?.remove();
      const context=document.createElement('details');context.className='wq-task-context';
      const label=document.createElement('summary');label.textContent='Queue context';
      const editor=form('<label>Where you left off<textarea maxlength="4000">'+esc(item.note||'')+'</textarea></label><button type="button">Save context</button>');
      editor.querySelector('button').addEventListener('click',async()=>{
        const button=editor.querySelector('button');button.disabled=true;
        try{await refresh();await send(envelope('queue-note',{taskId:anchor.blockId,note:editor.querySelector('textarea').value}));editor.querySelector('[role=status]').textContent='Context saved.';}
        catch(error){editor.querySelector('[role=status]').textContent=error.message;}finally{button.disabled=false;}
      });context.append(label,editor);host.appendChild(context);
    }
  }
  async function deletionPreview(anchor){
    const id=anchor.blockId;
    const date=anchor.date||null;
    const partition=date?'/api/blocks/range?start='+encodeURIComponent(date)+'&end='+encodeURIComponent(date):'/api/blocks?type=block&undated=1';
    const rows=await DCC.api(partition,{cache:'no-store'});
    assertActionAccount();
    const scope=rows.filter(row=>(row.date||null)===date&&!row.deleted_at);
    const taskRows=scope.filter(row=>row.type==='block'&&DCC.TaskModel.isTaskRow(row));
    const pool=taskPool({sourceRows:taskRows});
    const byId=new Map(pool.map(task=>[task.id,task]));
    const task=byId.get(id);
    if(!task)throw new Error('This task is no longer available. Refresh the queue.');
    const members=[task,...DCC.TaskModel.descendantsOf(id,pool)];
    const versions=new Map(members.map(member=>[member.id,member.__unf.sourceBlock.updated_at]));
    const ids=[...versions.keys()].sort();
    if(members.some(member=>member.__unf.sourceBlock.properties.startedAt)){
      throw new Error('Pause the active timer before deleting this task.');
    }
    if(completionEntries().some(entry=>ids.includes(entry.body.taskId))){
      throw new Error('Wait for the task completion to finish saving.');
    }
    return {task,ids,date,versions};
  }
  let openingDelete=false;
  async function openDelete(id,opener,options={}){
    if(openingDelete)return;
    openingDelete=true;
    try {
      const prepare=async()=>{
        assertActionAccount();
        if(window.blockStore?.hasPendingWrites?.())throw new Error('Wait for task edits to finish saving.');
        const anchor=await (options.resolveAnchor?options.resolveAnchor():prepareTask(id));
        assertActionAccount();
        if(!anchor||anchor.blockId!==id)throw new Error('This task is no longer available. Refresh and try again.');
        return anchor;
      };
      const anchor=await prepare();
      const preview=await deletionPreview(anchor);
      if(preview.task.repeatMode==='scheduled'&&window.openScheduledOccurrenceActions){
        await window.openScheduledOccurrenceActions(preview.task);
        return;
      }
      const count=preview.ids.length-1;
      const consequence=count?' and '+count+' '+(count===1?'nested task':'nested tasks'):'';
      const body=form('<p>Delete <strong>'+esc(preview.task.title)+'</strong>'+consequence+' from DCC?</p><p>Undo is available after deleting.</p>');
      let busy=false;
      const dialog=DCC.overlay.open({kind:'modal',title:'Delete task',body,anchor:opener,canClose:()=>!busy,
        returnFocus:options.returnFocus||(()=>document.querySelector('[data-queue-id="'+CSS.escape(id)+'"] [data-queue-action="break-options"]')
          ||document.querySelector('[data-queue-action="delete"][data-task-id="'+CSS.escape(id)+'"]')
          ||document.querySelector('[data-queue-action="add"]')),
        actions:[{label:'Cancel'},{label:'Delete task',destructive:true,onClick:async()=>{
          if(busy)return false;
          busy=true;
          try{
            const current=await deletionPreview(await prepare());
            if(current.date!==preview.date||current.task.title!==preview.task.title||current.task.repeatMode!==preview.task.repeatMode||
                JSON.stringify(current.ids)!==JSON.stringify(preview.ids)){
              throw new Error('This task or its nested tasks changed. Reopen Delete task to review.');
            }
            const result=await window.deleteQueueTaskWithUndo({...current.task,date:current.date},current.ids,current.versions);
            if(!result?.ok&&!result?.buffered)throw new Error(result?.error?.message||'Could not confirm deletion.');
            invalidate();
            await options.onSettled?.();
            return true;
          }catch(error){
            body.querySelector('[role=status]').textContent=error.message;
            return false;
          }finally{busy=false;}
        }}]});
      requestAnimationFrame(()=>dialog.el.querySelector('.dcc-overlay-actions button')?.focus());
    }finally{openingDelete=false;}
  }
  async function openSchedule(item,anchorEl){
    const anchor=await prepareTask(item.task.id),task=anchor.ev;
    if(!anchor.date){
      return window.openSchedulePopover({mode:'pick',id:task.id,task,anchorEl,view:'date',header:'Add “'+task.title+'” to itinerary',actionLabel:'Add',onPick:async date=>{
        const result=await window.blockStore.rescheduleBlock(anchor.blockId,date,{placement:{kind:'pool_date'}});await refresh();return result;
      }});
    }
    window.openSchedulePopover({mode:'reschedule',id:task.id,task,anchorEl,view:'date',onMove:async(date,time)=>{
      const duration=window._positiveDuration(task.__unf.sourceBlock.properties.duration??task.__unf.sourceBlock.properties.durMin,window.dur(task));
      const slot=time?{start:time,end:window.fmt(window.pt(time)+duration)}:null;
      const result=await DCC.Carryover.moveTo(task,date,{slot});await refresh();return result;
    }});
  }
  function itemForTask(task){
    const canonical=task._blockId||task.__unf?.sourceId;
    if(canonical)return items().find(i=>i.task.id===canonical);
    const exact=items().find(i=>i.task.id===task.id);if(exact)return exact;
    const aliases=items().filter(i=>i.task.properties.local_id===task.id);
    return aliases.length===1?aliases[0]:null;
  }
  function isBlocked(task){return !!itemForTask(task)?.blocked;}
  async function openBlocked(task){
    await refresh();let item=itemForTask(task);
    if(!item){const row=await DCC.api('/api/blocks/'+encodeURIComponent(task._blockId||task.id));item={task:row,status:'queued'};}
    if(item.blocked)return send(envelope('queue-unblock',{taskId:item.task.id}));
    return transition('queue-block',item);
  }
  function modal(title,body,submit,label='Save',onClose,returnFocus){let busy=false;return DCC.overlay.open({kind:'modal',title,body,onClose,anchor:returnFocus?.(),returnFocus,canClose:()=>!busy,actions:[{label:'Cancel'},{label,kind:'primary',onClick:async()=>{if(busy)return false;busy=true;try{await submit();return true;}catch(error){const el=body.querySelector('[role=status]');if(el)el.textContent=error.message;else warn(error);return false;}finally{busy=false;}}}]});}
  function form(html){const body=document.createElement('div');body.className='wq-form';body.innerHTML=html+'<p role="status"></p>';return body;}
  async function transition(action,item,savedReview){
    let displaced=null,startRevision=null;
    if(action==='start'){
      if(startOpening)return;
      const local=items().find(row=>row.task.id===item.task.id);
      if(local&&local.status!=='completed'&&!state.otherWorkspaceForeground&&!local.task.properties.guidedDefinitionId&&!items().some(row=>row.status==='foreground'&&row.task.id!==local.task.id)){
        if(local.status==='foreground'&&!local.onBreak)return;
        return instant(envelope('start',{taskId:local.task.id,expectedForegroundTaskId:null})).catch(warn);
      }
      startOpening=true;
      try {
        await refresh();
        item=items().find(row=>row.task.id===item.task.id);
        if(!item||item.status==='completed')throw new Error('This task is no longer open. Review the current queue.');
        if(state.otherWorkspaceForeground)throw new Error('Open the other workspace, pause if needed, then choose Return to Priority before switching.');
        if(item.status==='foreground'&&!item.onBreak){startOpening=false;return;}
        displaced=items().find(row=>row.status==='foreground'&&row.task.id!==item.task.id)||null;
        startRevision=state.revision;
        if(!displaced&&!item.task.properties.guidedDefinitionId){
          startOpening=false;
          return instant(envelope('start',{taskId:item.task.id,expectedRevision:startRevision,expectedForegroundTaskId:null})).catch(warn);
        }
      } catch(error){startOpening=false;warn(error);return;}
    }
    const completionAnchor=action==='done'?taskAnchor(item.task.id):null;
    if(action==='done'){
      assertActionAccount();
      if(!completionAnchor||item.status==='completed'||completionEntries().some(entry=>entry.body.taskId===item.task.id)
          ||document.getElementById('done-modal-overlay')?.classList.contains('open'))return;
      window.performance?.mark('dcc-completion-open-start');
    }
    const review=action==='done'?(savedReview||reviewEntries().filter(entry=>
      entry.body.action==='done'&&entry.body.taskId===item.task.id).at(-1)):null;
    let notesReady=action!=='done';
    const timerNeeded=action==='start'?!!displaced:['background-start','queue-block'].includes(action);
    const timer=timerNeeded?'<label>'+'Snooze'+'<select data-minutes aria-label="Snooze duration">'+(action==='queue-block'?'<option value="">Needs You now</option>':'')+'<option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="1440">24 hours</option><option value="custom">Custom</option></select></label><label data-custom hidden>Minutes<input type="number" min="1" max="1440" value="10"></label>':'';
    const heading=action==='start'?(displaced?'<div class="wq-switch-old"><div><strong>Moving to Background</strong><p>'+esc(displaced.task.properties.title||'Task')+'</p></div>'+timer+'</div><div class="wq-switch-new"><strong>Moving to Foreground</strong><p>'+esc(item.task.properties.title||'Task')+'</p></div>':'<p>'+esc(item.task.properties.title||'Task')+'</p>'):'<p>'+esc(item.task.properties.title||'Task')+'</p>';
    const reviewNotice=review?'<p>Review the current timing before completing this task again.</p>':'';
    const body=form(heading+reviewNotice+(action==='background-start'?'<p>This sets the task aside and optionally sets a check-back. It does not start a worker. A selected Snooze waits in Background; without one, inactive work returns to Priority.</p>':'')+(action==='start'?'':timer)+(action==='done'?'<div data-completion-time aria-live="off">Loading recorded time…</div><p>Completing saves the current focused session to this task. The saved total is confirmed after the update succeeds.</p>':'')+(item.task.properties.guidedDefinitionId?'<details open><summary>Guided instructions</summary><pre data-preview>Loading…</pre></details>'+(action==='done'?'<label>Outcome<textarea data-outcome required></textarea></label>':''):''));
    let guided=null,ready=!item.task.properties.guidedDefinitionId,completion=null,clockOffset=0,command=null;
    function updateConfirm(){
      if(action==='done'&&body.isConnected)document.getElementById('done-modal-confirm').disabled=!(ready&&completion&&notesReady);
    }
    const formatSeconds=seconds=>Math.floor(seconds/60)+'m '+String(seconds%60).padStart(2,'0')+'s';
    function updateCompletion(){
      const el=body.querySelector('[data-completion-time]');if(!el||!completion)return;
      const value=window.DCCWorkCompletion.project(completion,command?Date.parse(command.at):Date.now()+clockOffset);
      el.innerHTML='<dl class="wq-effort"><div><dt>Previously recorded'+(completion.history.estimated?' (estimated)':'')+'</dt><dd>'+esc(completion.history.savedMinutes==null?'Unknown':completion.history.savedMinutes+'m')+'</dd></div><div><dt>Current timer</dt><dd>'+esc(value.active?formatSeconds(value.elapsedSeconds):'Not running')+'</dd></div><div><dt>After completion'+(value.active?' (estimated)':'')+'</dt><dd>'+esc(value.projectedMinutes==null?'Unknown':value.projectedMinutes+'m')+'</dd></div></dl>'+(value.active?'<p class="wq-time">'+esc(formatSeconds(value.creditSeconds)+' of this session will be recorded.'+(value.capped?' Time after the missed check-in cutoff stays unknown.':' Totals round once after adding recorded seconds.'))+'</p>':'<p class="wq-time">No running session to add. Recorded time stays as saved.</p>')+(completion.history.carryMinutes?'<p class="wq-time">Includes '+esc(completion.history.carryMinutes)+'m saved before or outside the session ledger.</p>':'');
    }
    if(action==='done')previewFor(item.task.id).then(view=>{completion=view;clockOffset=view.serverNow-Date.now();updateCompletion();updateConfirm();}).catch(error=>{body.querySelector('[role=status]').textContent='Time summary unavailable: '+error.message;});
    const select=body.querySelector('[data-minutes]');select?.addEventListener('change',()=>{body.querySelector('[data-custom]').hidden=select.value!=='custom';});
    const submit=async(note)=>{
      if(!ready)throw new Error('Wait for current guided instructions.');
      if(action==='done'&&!notesReady)throw new Error('Wait for task notes, or reopen this dialog to retry.');
      if(action==='done'&&!completion)throw new Error('Wait for the recorded-time summary, or reopen this dialog to retry.');
      const minutes=select?(select.value==='custom'?Number(body.querySelector('[data-custom] input').value):select.value?Number(select.value):null):null;
      if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>1440))throw new Error('Choose 1–1440 minutes.');
      const payload={taskId:item.task.id,...(select?{remindMinutes:minutes}:{}),...(select&&minutes!==null?{attentionMode:'snooze'}:{}),...(action==='start'?{expectedForegroundTaskId:displaced?.task.id||null}:{})};
      if(guided)payload.guided={expectedRevision:guided.revision,expectedDefinitionRevision:guided.definitionRevision,expectedContextVersion:guided.contextVersion,...(action==='done'?{outcome:body.querySelector('[data-outcome]').value,confirmed:true}:{})};
      if(!command||!['start','done'].includes(action))command=envelope(action,{...payload,...(action==='start'?{expectedRevision:startRevision}:completion?{expectedRevision:completion.revision}:{})});
      if(action==='start')body.querySelectorAll('[data-minutes],[data-custom] input').forEach(el=>{el.disabled=true;});
      updateCompletion();
      if(action==='done'){enqueueCompletion(command,completion,note||review?.note,review?.body.sourceEventId);return;}
      try {
        await send(command);
      } catch(error) {
        if([400,403,404,409].includes(error.status))throw new Error(error.message+(action==='done'?' Close this dialog and review the current task before completing.':''));
        throw new Error((action==='done'?'Completion not confirmed. Retry uses the same saved update. ':'Update not confirmed. ')+error.message);
      }
    };
    const handle=action==='done'
      ?window.openDoneModal(item.task.id,item.task.properties.title,submit,DCC.TaskModel.fromBlock(item.task),{body,noteValue:undefined,authoritativeTime:true,awaitConfirmation:true,queueCompletion:true,loadNotes:async()=>{const current=await window.loadTaskNotesForAnchor(completionAnchor);return review?.note||current;},onNotesReady:()=>{notesReady=true;updateConfirm();}})
      :modal(action==='start'?(displaced?'Switch foreground task':'Guided instructions'):action==='queue-block'?'Blocked / Waiting':['queue-snooze','queue-remind'].includes(action)?'Snooze':'Set task aside',body,submit,action==='start'?'Bring forward':'Save',()=>{if(action==='start')startOpening=false;});
    if(action==='start'&&!body.isConnected)startOpening=false;
    if(action==='done')window.performance?.mark('dcc-completion-dialog-open');
    if(action==='done'){const timer=setInterval(()=>{if(!body.isConnected){clearInterval(timer);return;}updateCompletion();},1000);}
    if(!ready)DCC.api('/api/guided/tasks/'+encodeURIComponent(item.task.id),{cache:'no-store'}).then(view=>{guided=view;ready=true;body.querySelector('[data-preview]').textContent=view.prompt;updateConfirm();}).catch(error=>{body.querySelector('[role=status]').textContent=error.message;});
    return handle;
  }
  function addTasks(){
    const body=form('<label>Find an existing task<input type="search" data-search placeholder="Search tasks" autofocus></label><div data-results></div><button type="button" data-more hidden>More results</button>');
    const input=body.querySelector('[data-search]'),results=body.querySelector('[data-results]'),more=body.querySelector('[data-more]'),status=body.querySelector('[role=status]');
    let sequence=0,offset=null,query='',timer,adding=false,loading=false,closed=false,controller;
    const seen=new Set();
    const handle=DCC.overlay.open({kind:'modal',title:'Add tasks to your queue',body,actions:[{label:'Done'}],onClose:()=>{
      closed=true;++sequence;clearTimeout(timer);controller?.abort();document.removeEventListener('dcc:nav-changed',navigate);
    }});
    function navigate(){handle.close('navigation');}
    document.addEventListener('dcc:nav-changed',navigate);
    function syncButtons(){body.querySelectorAll('[data-add-id]').forEach(button=>{button.disabled=adding||items().some(item=>item.task.id===button.dataset.addId);});}
    async function search(append=false){
      if(closed||(append&&(loading||offset==null||input.value!==query)))return;
      controller?.abort();controller=new AbortController();
      const token=++sequence,requestedQuery=input.value,requestedOffset=append?offset:0;
      query=requestedQuery;loading=true;more.disabled=true;status.textContent='Searching…';
      if(!append){seen.clear();results.replaceChildren();offset=null;more.hidden=true;}
      try{
        const result=await requestQueue({signal:controller.signal},null,'/tasks?query='+encodeURIComponent(requestedQuery)+'&offset='+requestedOffset);
        if(closed||!sameAccount()||token!==sequence||input.value!==requestedQuery)return;
        for(const task of result.tasks){
          if(seen.has(task.id))continue;seen.add(task.id);
          const button=document.createElement('button');button.type='button';button.dataset.addId=task.id;
          button.append(document.createTextNode(task.title+' '));const date=document.createElement('small');date.textContent=task.date||'Unscheduled';button.append(date);results.append(button);
        }
        if(!seen.size){const empty=document.createElement('p');empty.textContent='No matching open tasks. Search an existing occurrence for recurring work.';results.append(empty);}
        offset=result.nextOffset;more.hidden=offset==null;status.textContent='';syncButtons();
      }catch(error){if(!closed&&token===sequence&&error.name!=='AbortError')status.textContent=error.message;}
      finally{if(!closed&&token===sequence){loading=false;more.disabled=false;}}
    }
    input.addEventListener('input',()=>{
      ++sequence;controller?.abort();clearTimeout(timer);offset=null;more.hidden=true;results.replaceChildren();status.textContent='Searching…';
      timer=setTimeout(()=>search(),180);
    });
    more.addEventListener('click',()=>search(true));
    body.addEventListener('click',async event=>{
      const button=event.target.closest('[data-add-id]');if(!button||button.disabled||adding||closed)return;
      adding=true;syncButtons();
      try{await send(envelope('queue-add',{taskId:button.dataset.addId}));if(!closed)status.textContent='Added to queue.';}
      catch(error){if(!closed)status.textContent=error.message;}
      finally{adding=false;if(!closed)syncButtons();}
    });
    search();return handle;
  }
  function openBreakOptions(item,anchor){
      const body=form('<p>'+esc(item.task.properties.title||'Paused task')+'</p><div class="wq-break-option-actions">'+button('return','Return to Priority',item.task.id)+button('background','Send to background',item.task.id)+button('complete','Complete task',item.task.id)+button('details','Task details',item.task.id)+button('delete','Delete task',item.task.id)+'</div>');
      const handle=DCC.overlay.open({kind:'modal',title:'Paused task options',body,anchor,returnFocus:()=>document.querySelector('[data-queue-id="'+CSS.escape(item.task.id)+'"] [data-queue-action="break-options"]')||document.querySelector('[data-queue-id="'+CSS.escape(item.task.id)+'"] [data-queue-action="focus"]'),actions:[{label:'Close'}]});
      body.addEventListener('click',event=>{if(event.target.closest('[data-queue-action]'))handle.close('action');});
  }

  function reorder(id,target){
    const item=items().find(i=>i.task.id===id);if(!item)return;
    const peers=items().filter(i=>i.status===item.status&&!!i.needsYou===!!item.needsYou&&(item.status!=='queued'||i.taskPriority===item.taskPriority)).map(i=>i.task.id);
    const peerIndex=peers.indexOf(id),targetId=target==='top'?peers[0]:typeof target==='number'?peers[peerIndex+target]:target;
    if(!targetId||!peers.includes(targetId)||id===targetId)return;
    const activeIds=new Set(items().filter(item=>item.status!=='completed').map(item=>item.task.id));
    const order=view().order.filter(id=>activeIds.has(id)),from=order.indexOf(id),to=order.indexOf(targetId);
    order.splice(from,1);order.splice(to,0,id);return instant(envelope('queue-reorder',{order}));
  }
  function reviewRejectedChanges(){
    const entries=reviewEntries();
    if(!entries.length)return;
    const body=form('');
    const handle=DCC.overlay.open({kind:'modal',title:'Review queue changes',body,actions:[{label:'Close'}]});
    function show(){
      body.querySelectorAll('section').forEach(section=>section.remove());
      const titles=new Map((state.queue?.items||[]).map(({task})=>[task.id,task.properties.title]));
      for(const entry of reviewEntries()){
        const id=entry.body.sourceEventId;
        const completion=entry.body.action==='done';
        const section=document.createElement('section');
        section.innerHTML='<h3>'+esc(titles.get(entry.body.taskId)||(completion?'Task completion':'Reminder dismissal'))+'</h3>'
          +'<p>'+esc(entry.message)+'</p>'
          +'<details><summary>Attempted change</summary><pre>'+esc(JSON.stringify(entry.note?{command:entry.body,notes:entry.note.text}:entry.body,null,2))+'</pre></details>'
          +'<div class="wq-actions">'+(completion?'<button type="button" data-reopen>Review completion</button>':'')
          +'<button type="button" data-dismiss>Dismiss review</button></div>';
        section.querySelector('[data-reopen]')?.addEventListener('click',async event=>{
          const control=event.currentTarget;
          control.disabled=true;
          try{
            await refresh();
            assertActionAccount();
            const current=reviewEntries().find(review=>review.body.sourceEventId===id);
            if(!current){
              if(reviewEntries().length)show();else handle.close('review-dismissed');
              warn(new Error('This review was dismissed.'));
              return;
            }
            // Close the blocking review overlay before opening the shared completion dialog.
            handle.close('review-completion');
            await openTaskOutcome(current.body.taskId,{},current);
          }catch(error){warn(error);control.disabled=false;}
        });
        section.querySelector('[data-dismiss]').addEventListener('click',()=>{
          if(entry.note&&!window.confirm('Discard the notes from this attempted completion?'))return;
          localStorage.removeItem(reviewKey(id));
          render();
          notifySync();
          if(reviewEntries().length)show();else handle.close('dismiss-review');
        });
        body.insertBefore(section,body.querySelector('[role=status]'));
      }
    }
    show();
  }
  // Opens (creating if needed) the journal for the day the date bar is showing.
  async function openJournal(control){
    if(typeof DCC.openDayJournal!=='function'){DCC.toast?.('Journal is still loading. Try again in a moment.','error');return;}
    const date=(typeof viewDate!=='undefined'&&viewDate)||(typeof __todayDate!=='undefined'&&__todayDate)||undefined;
    control.disabled=true;
    try{await DCC.openDayJournal(date);}finally{control.disabled=false;}
  }
  document.addEventListener('change',event=>{if(event.target.matches('[data-completed-period]')){completedPeriod=event.target.value;render();}});
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-queue-action]');if(!button)return;const action=button.dataset.queueAction,item=items().find(i=>i.task.id===button.dataset.taskId);
    if(action==='add'){addTasks();return;}
    if(action==='journal'){openJournal(button);return;}if(action==='retry'){void drainIntents();if(pending&&!completionEntries().some(entry=>entry.body.sourceEventId===pending.sourceEventId))send(pending).catch(warn);else void drainCompletions();return;}
    if(action==='snooze-all'){snooze(null);return;}
    if(action==='pomodoro'){window.DCCPomodoro?.open(items().find(i=>i.status==='foreground')?.task);return;}
    if(action==='clear-conflict'){setConflict(null);render();void drainCompletions();return;}
    if(action==='conflict'&&!conflict){reviewRejectedChanges();return;}
    if(action==='conflict'){const body=form('<p>'+esc(conflict?.message)+'</p><pre>'+esc(JSON.stringify(conflict?.note ? {command:conflict.body,notes:conflict.note.text} : conflict?.body,null,2))+'</pre>');DCC.overlay.open({kind:'modal',title:'Attempted change',body,actions:[{label:'Close'}]});return;}
    if(!item)return;
    if(action==='expand'){
      // Display-only: no network. Focus follows the control the person used.
      const opening=openCard!==item.task.id;openCard=opening?item.task.id:null;justOpened=openCard;render();justOpened=null;
      document.querySelector('[data-queue-id="'+CSS.escape(item.task.id)+'"] '+(opening?'.wq-fold':'.wq-row-hit'))?.focus({preventScroll:true});
      return;
    }
    if(['photo','copy-title'].includes(action))return; // Bound on the card itself.
    if(action==='delete'){openDelete(item.task.id,button).catch(warn);return;}
    if(action==='details'){const task=DCC.TaskModel.fromBlock(item.task);if(window.DCCTaskWorkspace?.preview)window.DCCTaskWorkspace.preview(task);else if(typeof window.openAddModal==='function')window.openAddModal(task.id,task.title);else {const body=form('<h3>'+esc(task.title)+'</h3><p>'+esc(task.detail||'No task details yet.')+'</p>');DCC.overlay.open({kind:'modal',title:'Task details',body,actions:[{label:'Close'}]});}return;}
    if(['snooze','remind'].includes(action)){snooze(item);return;}
    if(['focus','background','complete','block'].includes(action)){transition(action==='focus'?'start':action==='complete'?'done':action==='block'?'queue-block':'background-start',item).catch(warn);return;}
    if(action==='break-options'){openBreakOptions(item,button);return;}
    if(action==='priority')return; // Shared hold controller owns click and hold.
    if(action==='note'){const body=form('<label>Where you left off<textarea maxlength="4000">'+esc(item.note||'')+'</textarea></label>');modal('Task context',body,()=>send(envelope('queue-note',{taskId:item.task.id,note:body.querySelector('textarea').value})));return;}
    if(['up','down','complete'].includes(action))return; // Shared row/hold controls own these events.
    const map={return:'queue-return',pause:'pause',remove:'queue-remove',unblock:'queue-unblock',dismiss:'queue-dismiss'};
    if(map[action])instant(envelope(map[action],{taskId:item.task.id,...(['snooze','dismiss'].includes(action)?{generation:item.generation}:{})})).catch(warn);
  });
  let dragging=null;
  document.addEventListener('dragstart',event=>{const row=event.target.closest?.('[data-queue-id][draggable=true]');if(event.target.closest?.('button,input,select,textarea,a')){event.preventDefault();return;}if(row){dragging=row.dataset.queueId;event.dataTransfer.setData('text/plain',dragging);}});
  document.addEventListener('dragover',event=>{if(dragging&&event.target.closest?.('[data-queue-lane]')){event.preventDefault();event.dataTransfer.dropEffect='move';}});
  document.addEventListener('drop',event=>{
    const lane=event.target.closest?.('[data-queue-lane]'),row=event.target.closest?.('[data-queue-id]'),id=dragging;dragging=null;
    if(!lane||!id)return;event.preventDefault();event.stopPropagation();
    const item=items().find(item=>item.task.id===id);if(!item)return;
    const source=document.querySelector('[data-queue-id="'+CSS.escape(id)+'"]')?.closest('[data-queue-lane]');
    if(source===lane){if(row&&row.dataset.queueId!==id)reorder(id,row.dataset.queueId)?.catch(warn);return;}
    const dest=lane.dataset.queueLane;
    if(dest==='wq-foreground')transition('start',item).catch(warn);
    else if(dest==='wq-background'){if(item.status==='foreground')transition('background-start',item).catch(warn);else snooze(item);}
    else if(dest==='wq-next'){
      const held=returnHold(item);if(held){DCC.toast(held);return;}
      instant(envelope(item.status==='foreground'&&!item.onBreak?'pause':'queue-return',{taskId:id,...(item.status==='foreground'&&!item.onBreak?{attentionMode:'priority'}:{})})).catch(warn);
    }else if(dest==='wq-needs'){
      instant(envelope('pause',{taskId:id,attentionMode:'needs-you'})).catch(warn);
    }
  });
  document.addEventListener('dragend',()=>{dragging=null;});
  document.addEventListener('keydown',event=>{if(event.target.closest?.('[data-queue-id]')===event.target&&['Enter',' '].includes(event.key)){event.preventDefault();openDetails(event.target.dataset.queueId).catch(warn);return;}const row=event.target.closest?.('[data-queue-id]');if(row&&event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();reorder(row.dataset.queueId,event.key==='ArrowUp'?-1:1)?.catch(warn);}});
  function updateBreakClocks(){
    document.querySelectorAll('[data-break-clock]').forEach(el=>{
      const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(el.dataset.breakSince))/1000));
      el.textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
    });
  }
  setInterval(updateBreakClocks,1000);
  function tick(){
    render();
    return processPendingQueueWork();
  }
  async function processPendingQueueWork(){
    if(document.hidden||ticking||sending||!navigator.onLine||!sameAccount())return;
    ticking=true;
    try{
      if(intents().length){await drainIntents();if(intents().length)return;}
      const completions=completionEntries();
      if(completions.length&&(!pending||completions.some(entry=>entry.body.sourceEventId===pending.sourceEventId))){
        await drainCompletions();return;
      }
      if(pending){await send(pending);return;}
      if(DCC.busyElsewhere?.())return;
      const dueItem=()=>items().find(i=>i.dueAt&&Date.parse(i.dueAt)<=Date.now()&&i.needsYou&&!i.notifiedAt);
      if(!dueItem())return;
      // Confirm a due reminder against the current revision and generation.
      await refresh();
      const due=dueItem();
      if(!due||pending||sending||DCC.busyElsewhere?.())return;
      const body=envelope('queue-claim',{taskId:due.task.id,generation:due.generation});
      const result=await requestQueue({method:'POST',body});
      assertActionAccount();
      const activeRead=loading;
      if(activeRead)await activeRead.catch(()=>{});
      await refresh();
      if(!result.claimed||!items().some(i=>i.task.id===due.task.id&&i.generation===due.generation&&i.needsYou))return;
      const text='Time to check back on '+(due.task.properties.title||'your background task')+'.';
      if(DCC.PetNudge?.deliverWorkCheckIn)await DCC.PetNudge.deliverWorkCheckIn(text,{open:()=>activate(due.task.id)});
      else DCC.toast(text,'info',60000,{label:'Open queue',onClick:()=>activate(due.task.id)});
    }catch(_error){}finally{ticking=false;}
  }
  window.addEventListener('storage',event=>{
    if(!sameAccount())return;
    try{
      if(event.key===key&&event.newValue){
        const {readVersion:version,...value}=JSON.parse(event.newValue);
        accept(value,version||null,false);
      }
      if(event.key===key+':conflict'){conflict=JSON.parse(event.newValue);importLegacyReview();render();notifySync();}
      if(event.key===key+':pending'){pending=JSON.parse(event.newValue);render();notifySync();}
      if(event.key?.startsWith(intentPrefix)){bumpIntents();render();}
      if(event.key?.startsWith(completionPrefix)||event.key?.startsWith(reviewPrefix)){syncQueueActionReceipts();render();notifySync();}
    }catch(_e){}
  });
  function recover(){
    if(document.hidden)return;
    // Replay durable writes independently, including when the read path fails.
    void tick();
    invalidate();
  }
  window.addEventListener('dcc:data-ready',recover);
  window.addEventListener('dcc:work-session-changed',invalidate);
  window.addEventListener('online',recover);
  document.addEventListener('visibilitychange',recover);
  setInterval(tick,localTickMs);
  setInterval(invalidate,fallbackMs);
  DCC.tabs?.register('working-queue',()=>{render();invalidate();});
  function syncState(){
    const review=conflict||reviewEntries().at(0);
    return {pending:!!pending||completionEntries().length>0||intents().length>0,conflict:review?{message:review.message||''}:null};
  }
  DCC.TaskActions?.registerPool('working-queue',()=>taskPool({sourceRows:contextRows()}));
  syncQueueActionReceipts();
  captureQueueUndo(pending);
  window.addEventListener('dcc:task-action',()=>{if(sameAccount())render();});
  window.addEventListener('dcc:task-context',()=>{if(sameAccount())render();});
  function sameAccount(){
    const current=window.DCC_ACCOUNT_CONTEXT;
    return !scopeRejected&&!window.__DCC_SIGNING_OUT__&&current?.userId===actionAccount.userId&&current.workspaceId===actionAccount.workspaceId;
  }
  function assertActionAccount(){
    if(!sameAccount())throw new Error('Account changed. Reload before updating tasks.');
  }
  function assertActionReady(){
    assertActionAccount();
    // navigator.onLine is advisory; requestQueue checks actual connectivity.
    if(sending||pending||conflict)throw new Error('Resolve the current queue update before changing this task.');
  }
  async function performTaskAction(action,taskId,descriptor={}){
    assertActionReady();
    if(descriptor.kind&&descriptor.kind!=='task')throw new Error('Open this '+(descriptor.kind==='waiting'?'Waiting check-in':'triage item')+' in More to use its existing outcome flow.');
    const map={complete:'done',foreground:'start',background:'background-start',remove:'queue-remove'};
    if(!map[action])throw new Error('Unsupported task action.');
    const expectedRevision=state.revision;
    // Never silently replace the revision the user actually saw.
    const snapshot=await refresh();assertActionReady();
    if(snapshot.revision!==expectedRevision)throw new Error('Queue changed. Review it and try again.');
    let item=items().find(row=>row.task.id===taskId);
    if(!item){
      if(action==='remove')throw new Error('This task is not in Priority Queue.');
      const value=await requestQueue({},null,'/task/'+encodeURIComponent(taskId));
      assertActionReady();
      item={task:value.task||value};
    }
    if(!item.task?.id)throw new Error('Task is not synced. Refresh and try again.');
    const props=item.task.properties||{};
    if(DCC.Waiting?.isCheckInTask?.(DCC.TaskModel.fromBlock(item.task)))throw new Error('Open this Waiting check-in in More to record its outcome.');
    if(item.task.properties?.guidedDefinitionId||item.task.properties?.type==='guided')throw new Error('Open this guided task to review its instructions and outcome.');
    if(item.status==='completed')throw new Error('This task is already completed.');
    if(action==='remove'&&item.status!=='queued')throw new Error('Only Priority Queue tasks can be removed here.');
    const displaced=(state.foreground||[]).filter(row=>row.id!==taskId);
    const command=envelope(map[action],{taskId,expectedRevision,...(action==='background'?{attentionMode:'snooze',remindMinutes:30}:{}),...(action==='foreground'?{expectedForegroundTaskId:displaced[0]?.id||null}:{})});
    const result=await send(command);assertActionAccount();
    if(result.undo)result.undo={...result.undo,expiresAt:Math.min(result.undo.expiresAt,Date.now()+5000),account:{...actionAccount}};
    return result;
  }
  async function openTaskOutcome(taskId,descriptor={},savedReview){
    assertActionReady();
    const actionId=descriptor.actionId||taskId;
    if(descriptor.kind==='waiting'){
      const open=DCC.Waiting?.open||window.openWaitingItem;
      if(!open||await open(actionId)===false)throw new Error('This Waiting item is unavailable. Refresh and try again.');
      return {opened:true,completed:false,owner:'waiting'};
    }
    if(descriptor.kind==='triage'){
      if(!DCC.CatchUp?.open||!await DCC.CatchUp.open())throw new Error('This Loose End is no longer available. Refresh and try again.');
      return {opened:true,completed:false,owner:'triage'};
    }
    let item=items().find(row=>row.task.id===actionId);
    const cachedTask=window.blockStore?.get?.(actionId);
    if(!item&&cachedTask)item={task:cachedTask};
    if(!item){
      const value=await requestQueue({},null,'/task/'+encodeURIComponent(actionId));
      assertActionReady();item={task:value.task};
    }
    if(item.task&&!items().some(row=>row.task.id===item.task.id))rememberTaskContext([...detailRows.filter(row=>row.id!==item.task.id),item.task]);
    if(!item.task?.id)throw new Error('Task is not available. Refresh and try again.');
    const props=item.task.properties||{},ev=DCC.TaskModel.fromBlock(item.task);
    if(DCC.Waiting?.isCheckInTask?.(ev)){
      const waitingId=props.delegatedItemId||ev.delegatedItemId||/^waiting-checkin-task:(.+)$/.exec(props.local_id||ev.id||'')?.[1];
      if(!waitingId||!DCC.Waiting.open||await DCC.Waiting.open(waitingId)===false)throw new Error('This check-in’s Waiting item is unavailable. Refresh and try again.');
      return {opened:true,completed:false,owner:'waiting'};
    }
    if(item.status==='completed'||props.done||props.status==='done')throw new Error('This task is already completed.');
    if(document.getElementById('done-modal-overlay')?.classList.contains('open'))throw new Error('Finish or close the current task outcome first.');
    if(savedReview&&!localStorage.getItem(reviewKey(savedReview.body.sourceEventId)))throw new Error('This review was dismissed.');
    await transition('done',item,savedReview);
    if(!document.getElementById('done-modal-overlay')?.classList.contains('open'))throw new Error('The task outcome flow could not open. Refresh and try again.');
    return {opened:true,completed:false,owner:'task'};
  }
  async function undoCompletion(receipt){
    assertActionReady();
    if(!receipt||receipt.account?.userId!==actionAccount.userId||receipt.account?.workspaceId!==actionAccount.workspaceId)throw new Error('This completion belongs to a different account.');
    if(Date.now()>receipt.expiresAt)throw new Error('Undo expired. Reopen the task from its details.');
    if(receipt.expectedRevision!==state.revision)throw new Error('Queue changed. Review the task before reopening.');
    const result=await send(envelope('undo-completion',{taskId:receipt.taskId,expectedRevision:receipt.expectedRevision,undoEventId:receipt.sourceEventId}));
    assertActionAccount();return result;
  }
  window.DCCWorkingQueue={openDelete,performTaskAction,openTaskOutcome,undoCompletion,syncState,addTask,render,refresh,invalidate,tick,activate,send,taskAnchor,taskPool,refreshTaskContext,rememberTaskContext,openBlocked,isBlocked,getState:()=>sameAccount()?state:emptyState};
  // Keep the former rotation navigation entry point. Floating workspace focus()
  // must be migrated to the shared coordinator when that separate feature lands.
  importLegacyReview();
  notifySync();
  recover();
  window.DCCWorkRotation={render,refresh,tick,open:(_from,to)=>{activate();if(to){const row=items().find(i=>i.task.id===(to._blockId||to.id));if(row)transition('start',row);}else addTasks();}};
})();
