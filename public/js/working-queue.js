// One view over the account coordinator. No client-only foreground state.
(function () {
  'use strict';
  const DCC=window.DCC, account=window.DCC_ACCOUNT_CONTEXT;
  if(!DCC || !account?.userId || !account.workspaceId)return;
  const key='dcc-working-queue:'+account.workspaceId+':'+account.userId;
  let state={revision:0,foreground:[],queue:{items:[],order:[]}},pending=null,conflict=null,loading=null,sending=false,ticking=false,problem='';
  try {state=JSON.parse(localStorage.getItem(key))||state;pending=JSON.parse(localStorage.getItem(key+':pending'));conflict=JSON.parse(localStorage.getItem(key+':conflict'));}catch(_e){}
  const esc=DCC.esc,items=()=>state.queue?.items||[];
  function persist(name,value){if(value==null)localStorage.removeItem(key+name);else localStorage.setItem(key+name,JSON.stringify(value));}
  function newer(value){return value && (value.revision>state.revision || (value.revision===state.revision && (value.queue?.serverNow||'')>=(state.queue?.serverNow||'')));}
  function accept(value){if(!newer(value))return;state=value;persist('',state);render();}
  function apply(result){window.blockStore?.acceptWorkRotation?.(result.affectedTasks||[]);accept(result.currentState||result.state);window.DCCWorkSessions?.refresh();}
  async function refresh(){if(loading)return loading;loading=DCC.api('/api/working-queue',{cache:'no-store',signal:AbortSignal.timeout(15000)}).then(value=>{problem='';accept(value);return value;}).catch(error=>{problem=error.message;render();throw error;}).finally(()=>{loading=null;});return loading;}
  function envelope(action,extra={}){return {action,sourceEventId:'queue:'+crypto.randomUUID(),expectedRevision:state.revision,at:new Date().toISOString(),...extra};}
  async function sendUnlocked(body){
    pending=JSON.parse(localStorage.getItem(key+':pending')||'null');
    if(sending)throw new Error('A queue update is still being saved.');
    if(pending && pending.sourceEventId!==body.sourceEventId)throw new Error('Resolve the pending update first.');
    if(window.blockStore?.hasPendingWrites?.()){window.blockStore.flushPending();throw new Error('Wait for your task edits to sync first.');}
    persist(':pending',body);pending=body;sending=true;render();
    try {const result=await DCC.api('/api/working-queue',{method:'POST',body,signal:AbortSignal.timeout(15000)});persist(':pending',null);pending=null;apply(result);return result;}
    catch(error){if([400,403,404,409].includes(error.status)){conflict={body,message:error.message};persist(':conflict',conflict);persist(':pending',null);pending=null;await refresh().catch(()=>{});}throw error;}
    finally{sending=false;render();}
  }
  function send(body){return navigator.locks?.request?navigator.locks.request(key+':write',()=>sendUnlocked(body)):sendUnlocked(body);}
  const warn=error=>DCC.toast(error.message||'Queue update failed','error');
  function activate(id){document.querySelector('.tab[data-tab="working-queue"]')?.click();render();if(id)document.querySelector('[data-queue-id="'+CSS.escape(id)+'"]')?.scrollIntoView({block:'nearest',behavior:DCC.reducedMotion?.()?'auto':'smooth'});}
  function button(action,label,id,extra=''){return '<button type="button" data-queue-action="'+action+'" data-task-id="'+esc(id||'')+'" '+extra+'>'+label+'</button>';}
  function pathFor(task,index){const parts=[],seen=new Set();let t=task;while(t&&!seen.has(t.id)){seen.add(t.id);parts.unshift(t.title||'Task');t=index.get(DCC.TaskModel.parentIdOf(t));}return parts.join(' › ');}
  function render(){
    const root=document.getElementById('working-queue-root');if(!root)return;
    const focused=document.activeElement,focusKey=focused?.dataset.queueAction,focusId=focused?.dataset.taskId;
    const all=items(),index=new Map((window.DCCWorkSessions?.availableTasks()||[]).map(t=>[t.id,t]));all.forEach(i=>{const t=DCC.TaskModel.fromBlock(i.task);index.set(t.id,t);});
    function card(item){
      const row=item.task,task=DCC.TaskModel.fromBlock(row),foreground=item.status==='foreground',completed=item.status==='completed';
      const elapsed=item.backgroundSince?Math.max(0,Math.floor((Date.now()-Date.parse(item.backgroundSince))/60000)):0;
      const reminder=item.dueAt?(Date.parse(item.dueAt)<=Date.now()?'Check back now':'Check back in '+Math.max(1,Math.ceil((Date.parse(item.dueAt)-Date.now())/60000))+'m'):'';
      const actual=item.actualMinutes==null?'Focused actuals unknown':item.actualMinutes+'m focused saved';
      const activeMinutes=foreground?Math.max(0,Math.floor((Date.now()-Date.parse(row.properties.startedAt))/60000)):0;
      let controls=completed?button('remove','Remove',row.id):foreground?button('background','Send to background',row.id)+button('pause','Pause',row.id)+button('complete','Complete',row.id):button('focus','Bring forward',row.id)+button('complete','Complete',row.id);
      if(!completed){controls+=button('note','Context',row.id);if(!foreground)controls+=button('up','↑',row.id,'aria-label="Move up"')+button('down','↓',row.id,'aria-label="Move down"')+button(item.status==='blocked'?'unblock':'block',item.status==='blocked'?'Unblock':'Blocked',row.id)+button('remove','Remove',row.id);}
      if(item.dueAt)controls+=button('snooze','Snooze 5m',row.id)+button('dismiss','Dismiss check-back',row.id);
      else if(['background','blocked'].includes(item.status))controls+=button('remind','Set check-back',row.id);
      controls+=button('details','Details',row.id);
      return '<article class="wq-card '+(foreground?'wq-focus':'')+'" data-queue-id="'+esc(row.id)+'" tabindex="0" draggable="'+(!foreground&&!completed)+'"><div class="wq-card-top"><h3>'+esc(pathFor(task,index))+'</h3><span class="wq-status">'+esc(item.status)+'</span></div><p class="wq-time">'+esc(foreground?activeMinutes+'m this session · '+actual:actual+(item.backgroundSince?' · '+elapsed+'m waiting':''))+'</p>'+(reminder?'<p class="wq-attention">'+esc(reminder)+'</p>':'')+(item.note?'<p class="wq-note">'+esc(item.note)+'</p>':'')+'<div class="wq-actions">'+controls+'</div>'+(foreground&&window.DCCWorkSessions?.checkInHtml?window.DCCWorkSessions.checkInHtml(task,Date.now()):'')+'</article>';
    }
    function lane(title,rows,empty,cls=''){return '<section class="wq-lane '+cls+'"><h2>'+title+' <small>'+rows.length+'</small></h2>'+(rows.length?rows.map(card).join(''):'<p class="wq-empty">'+empty+'</p>')+'</section>';}
    const fg=all.filter(i=>i.status==='foreground'),needs=all.filter(i=>i.needsYou),background=all.filter(i=>['background','paused','blocked'].includes(i.status)&&!i.needsYou),upNext=all.filter(i=>i.status==='queued'),done=all.filter(i=>i.status==='completed');
    root.innerHTML='<header class="wq-header"><div><h1>Working Queue</h1><p>Bring one task forward. Keep the rest ready to return to.</p></div>'+button('add','Add tasks')+'</header><p class="wq-sync" role="status">'+esc(sending?'Saving…':pending?'Update saved on this device; awaiting confirmation.':problem?'Offline or unavailable: '+problem:'Synced · waiting time is not focused effort')+'</p>'+(pending?button('retry','Retry saved update'):'')+(conflict?'<p class="wq-conflict">'+esc(conflict.message)+' Your attempted change is retained. Review current work before trying again. '+button('conflict','Review attempted change')+button('clear-conflict','Dismiss conflict')+'</p>':'')+(state.otherWorkspaceForeground?'<p class="wq-conflict">Work is active in another workspace. Pause it there before bringing a task forward here.</p>':'')+'<div class="wq-grid">'+lane('Foreground',fg,'Choose a task below to begin focused work.','wq-foreground')+lane('Needs You',needs,'No check-backs due. These are manual reminders, not assistant status detection.','wq-needs')+lane('Up Next',upNext,'Add existing tasks to build your queue.','wq-next')+lane('Background & paused',background,'Tasks you set aside keep their context here.','wq-background')+'</div>'+(done.length?'<details class="wq-completed"><summary>Completed · '+done.length+'</summary>'+done.map(card).join('')+'</details>':'');
    if(focusKey)root.querySelector('[data-queue-action="'+CSS.escape(focusKey)+'"][data-task-id="'+CSS.escape(focusId||'')+'"]')?.focus({preventScroll:true});
  }
  function modal(title,body,submit,label='Save'){let busy=false;return DCC.overlay.open({kind:'modal',title,body,canClose:()=>!busy,actions:[{label:'Cancel'},{label,kind:'primary',onClick:async()=>{if(busy)return false;busy=true;try{await submit();return true;}catch(error){const el=body.querySelector('[role=status]');if(el)el.textContent=error.message;else warn(error);return false;}finally{busy=false;}}}]});}
  function form(html){const body=document.createElement('div');body.className='wq-form';body.innerHTML=html+'<p role="status"></p>';return body;}
  async function transition(action,item){
    const body=form('<p>'+esc(item.task.properties.title||'Task')+'</p>'+(['start','background-start','queue-block'].includes(action)?'<label>Check back on the background task<select data-minutes><option value="">No reminder</option><option value="5">5 minutes</option><option value="15" selected>15 minutes</option><option value="30">30 minutes</option><option value="120">2 hours</option><option value="custom">Custom</option></select></label><label data-custom hidden>Minutes<input type="number" min="1" max="1440" value="10"></label>':'')+(action==='done'?'<p>Mark this task complete? Recorded actuals stay unchanged; missing actuals remain unknown.</p>':'')+(item.task.properties.guidedDefinitionId?'<details open><summary>Guided instructions</summary><pre data-preview>Loading…</pre></details>'+(action==='done'?'<label>Outcome<textarea data-outcome required></textarea></label>':''):''));
    let guided=null,ready=!item.task.properties.guidedDefinitionId;
    const select=body.querySelector('[data-minutes]');select?.addEventListener('change',()=>{body.querySelector('[data-custom]').hidden=select.value!=='custom';});
    const handle=modal(action==='start'?'Bring forward':action==='done'?'Complete task':'Set task aside',body,async()=>{
      if(!ready)throw new Error('Wait for current guided instructions.');
      const minutes=select?(select.value==='custom'?Number(body.querySelector('[data-custom] input').value):select.value?Number(select.value):null):null;
      if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>1440))throw new Error('Choose 1–1440 minutes.');
      const payload={taskId:item.task.id,...(select?{remindMinutes:minutes}:{})};
      if(guided)payload.guided={expectedRevision:guided.revision,expectedDefinitionRevision:guided.definitionRevision,expectedContextVersion:guided.contextVersion,...(action==='done'?{outcome:body.querySelector('[data-outcome]').value,confirmed:true}:{})};
      await send(envelope(action,payload));
    },action==='start'?'Bring forward':action==='done'?'Complete':'Save');
    if(!ready)DCC.api('/api/guided/tasks/'+encodeURIComponent(item.task.id),{cache:'no-store'}).then(view=>{guided=view;ready=true;body.querySelector('[data-preview]').textContent=view.prompt;}).catch(error=>{body.querySelector('[role=status]').textContent=error.message;});
    return handle;
  }
  function addTasks(){
    const body=form('<label>Find an existing task<input type="search" data-search placeholder="Search tasks" autofocus></label><div data-results></div><button type="button" data-more hidden>More results</button>');
    const handle=DCC.overlay.open({kind:'modal',title:'Add tasks to your queue',body,actions:[{label:'Done'}]});
    let sequence=0,offset=0,query='',timer,adding=false;
    async function search(append=false){const token=++sequence;query=body.querySelector('[data-search]').value;if(!append)offset=0;try{const result=await DCC.api('/api/working-queue/tasks?query='+encodeURIComponent(query)+'&offset='+offset,{cache:'no-store'});if(token!==sequence)return;const rows=result.tasks.filter(t=>t.status!=='done'&&t.type!=='recurring-definition');const html=rows.map(t=>'<button type="button" data-add-id="'+esc(t.id)+'" '+(items().some(i=>i.task.id===t.id)?'disabled':'')+'>'+esc(t.title)+' <small>'+esc(t.date||'Unscheduled')+'</small></button>').join('');if(append)body.querySelector('[data-results]').insertAdjacentHTML('beforeend',html);else body.querySelector('[data-results]').innerHTML=html||'<p>No matching open tasks. Search an existing occurrence for recurring work.</p>';offset=result.nextOffset;body.querySelector('[data-more]').hidden=offset==null;}catch(error){body.querySelector('[role=status]').textContent=error.message;}}
    body.querySelector('[data-search]').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>search(),180);});body.querySelector('[data-more]').addEventListener('click',()=>search(true));
    body.addEventListener('click',async event=>{const button=event.target.closest('[data-add-id]');if(!button||adding)return;adding=true;body.querySelectorAll('[data-add-id]').forEach(b=>b.disabled=true);try{await send(envelope('queue-add',{taskId:button.dataset.addId}));body.querySelector('[role=status]').textContent='Added to queue.';}catch(error){body.querySelector('[role=status]').textContent=error.message;}finally{adding=false;body.querySelectorAll('[data-add-id]').forEach(b=>b.disabled=items().some(i=>i.task.id===b.dataset.addId));}});search();return handle;
  }
  function reorder(id,target){const order=state.queue.order.slice(),from=order.indexOf(id),to=typeof target==='number'?from+target:order.indexOf(target);if(from<0||to<0||to>=order.length||from===to)return;order.splice(from,1);order.splice(to,0,id);return send(envelope('queue-reorder',{order}));}
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-queue-action]');if(!button)return;const action=button.dataset.queueAction,item=items().find(i=>i.task.id===button.dataset.taskId);
    if(action==='add'){addTasks();return;}if(action==='retry'&&pending){send(pending).catch(warn);return;}
    if(action==='clear-conflict'){conflict=null;persist(':conflict',null);render();return;}
    if(action==='conflict'){const body=form('<p>'+esc(conflict?.message)+'</p><pre>'+esc(JSON.stringify(conflict?.body,null,2))+'</pre>');DCC.overlay.open({kind:'modal',title:'Attempted change',body,actions:[{label:'Close'}]});return;}
    if(!item)return;
    if(action==='details'){const task=DCC.TaskModel.fromBlock(item.task);if(window.DCCTaskWorkspace?.open)window.DCCTaskWorkspace.open(task);else if(typeof window.openAddModal==='function')window.openAddModal(task.id,task.title);else {const body=form('<h3>'+esc(task.title)+'</h3><p>'+esc(task.detail||'No task details yet.')+'</p>');DCC.overlay.open({kind:'modal',title:'Task details',body,actions:[{label:'Close'}]});}return;}
    if(['focus','background','complete','block','remind'].includes(action)){transition(action==='focus'?'start':action==='complete'?'done':action==='block'?'queue-block':'background-start',item);return;}
    if(action==='note'){const body=form('<label>Where you left off<textarea maxlength="4000">'+esc(item.note||'')+'</textarea></label>');modal('Task context',body,()=>send(envelope('queue-note',{taskId:item.task.id,note:body.querySelector('textarea').value})));return;}
    if(action==='up'||action==='down'){reorder(item.task.id,action==='up'?-1:1)?.catch(warn);return;}
    const map={pause:'pause',remove:'queue-remove',unblock:'queue-unblock',snooze:'queue-snooze',dismiss:'queue-dismiss'};
    if(map[action])send(envelope(map[action],{taskId:item.task.id,...(['snooze','dismiss'].includes(action)?{generation:item.generation}:{}),...(action==='snooze'?{remindMinutes:5}:{})})).catch(warn);
  });
  let dragging=null;
  document.addEventListener('dragstart',event=>{const row=event.target.closest?.('[data-queue-id][draggable=true]');if(row){dragging=row.dataset.queueId;event.dataTransfer.setData('text/plain',dragging);}});
  document.addEventListener('dragover',event=>{if(dragging&&event.target.closest?.('[data-queue-id]'))event.preventDefault();});
  document.addEventListener('drop',event=>{const row=event.target.closest?.('[data-queue-id]');if(row&&dragging){event.preventDefault();reorder(dragging,row.dataset.queueId)?.catch(warn);}dragging=null;});
  document.addEventListener('dragend',()=>{dragging=null;});
  document.addEventListener('keydown',event=>{const row=event.target.closest?.('[data-queue-id]');if(row&&event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();reorder(row.dataset.queueId,event.key==='ArrowUp'?-1:1)?.catch(warn);}});
  async function tick(){render();if(document.hidden||ticking||sending)return;ticking=true;try{
    if(pending&&navigator.onLine){await send(pending);return;}await refresh();if(pending||DCC.busyElsewhere?.())return;
    const due=items().find(i=>i.needsYou&&!i.notifiedAt);if(!due)return;
    const body=envelope('queue-claim',{taskId:due.task.id,generation:due.generation});
    const result=await DCC.api('/api/working-queue',{method:'POST',body,signal:AbortSignal.timeout(15000)});
    if(loading)await loading;await refresh();
    if(!result.claimed||!items().some(i=>i.task.id===due.task.id&&i.generation===due.generation&&i.needsYou))return;
    const text='Time to check back on '+(due.task.properties.title||'your background task')+'.';
    if(DCC.PetNudge?.deliverWorkCheckIn)await DCC.PetNudge.deliverWorkCheckIn(text,{open:()=>activate(due.task.id)});else DCC.toast(text,'info',60000,{label:'Open queue',onClick:()=>activate(due.task.id)});
  }catch(_error){}finally{ticking=false;}}
  window.addEventListener('storage',event=>{try{if(event.key===key){const value=JSON.parse(event.newValue);if(newer(value)){state=value;render();}}if(event.key===key+':conflict'){conflict=JSON.parse(event.newValue);render();}if(event.key===key+':pending'){pending=JSON.parse(event.newValue);render();}}catch(_e){}});
  window.addEventListener('dcc:data-ready',tick);window.addEventListener('dcc:work-session-changed',()=>refresh().catch(()=>{}));window.addEventListener('online',tick);document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});setInterval(tick,15000);
  DCC.tabs?.register('working-queue',()=>{render();refresh().catch(()=>{});});
  window.DCCWorkingQueue={render,refresh,tick,activate,send,getState:()=>state};
  // Existing floating-workspace callers retain their navigation contract.
  window.DCCWorkRotation={render,refresh,tick,open:(_from,to)=>{activate();if(to){const row=items().find(i=>i.task.id===(to._blockId||to.id));if(row)transition('start',row);}else addTasks();}};
})();
