// One view over the account coordinator. No client-only foreground state.
(function () {
  'use strict';
  const DCC=window.DCC, account=window.DCC_ACCOUNT_CONTEXT;
  if(!DCC || !account?.userId || !account.workspaceId)return;
  const key='dcc-working-queue:'+account.workspaceId+':'+account.userId;
  let state={revision:0,foreground:[],queue:{items:[],order:[]}},pending=null,conflict=null,loading=null,sending=false,ticking=false,problem='';
  try {state=JSON.parse(localStorage.getItem(key))||state;pending=JSON.parse(localStorage.getItem(key+':pending'));conflict=JSON.parse(localStorage.getItem(key+':conflict'));}catch(_e){}
  const esc=DCC.esc,items=()=>state.queue?.items||[];
  let completedPeriod='today'; // Per-view choice only; each new page starts on Today.
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
    if(window.DCCGlassesQueue){window.DCCGlassesQueue.render(root,{state,pending,conflict,sending,problem},glassesAction);return;}
    const focused=document.activeElement,focusKey=focused?.dataset.queueAction,focusId=focused?.dataset.taskId;
    const completedOpen=root.querySelector('.wq-completed')?.open;
    const periodFocused=focused?.matches('[data-completed-period]');
    const completionView=window.DCCCompletedQueueFilter.select(items(),completedPeriod,Date.now(),state.timeZone);
    const periodLabel=window.DCCCompletedQueueFilter.options.find(([value])=>value===completedPeriod)[1];
    const contextOpen=new Set(Array.from(root.querySelectorAll('.wq-context[open]')).map(el=>el.closest('[data-queue-id]').dataset.queueId));
    const contextFocused=focused?.matches('.wq-context > summary')?focused.closest('[data-queue-id]').dataset.queueId:null;
    const completedFocused=focused?.matches('.wq-completed > summary');
    const all=items(),index=new Map((window.DCCWorkSessions?.availableTasks()||[]).map(t=>[t.id,t]));all.forEach(i=>{const t=DCC.TaskModel.fromBlock(i.task);index.set(t.id,t);});
    function card(item){
      const row=item.task,task=DCC.TaskModel.fromBlock(row),foreground=item.status==='foreground',completed=item.status==='completed';
      const elapsed=item.backgroundSince?Math.max(0,Math.floor((Date.now()-Date.parse(item.backgroundSince))/60000)):0;
      const reminder=item.dueAt?(Date.parse(item.dueAt)<=Date.now()?'Check back now':'Check back in '+Math.max(1,Math.ceil((Date.parse(item.dueAt)-Date.now())/60000))+'m'):'';
      const actual=item.actualMinutes==null?'Focused actuals unknown':item.actualMinutes+'m focused saved';
      const activeMinutes=foreground?Math.max(0,Math.floor((Date.now()-Date.parse(row.properties.startedAt))/60000)):0;
      let controls=completed?button('remove','Remove',row.id):foreground?button('background','Send to background',row.id)+button('pause','Pause',row.id)+button('complete','Complete',row.id):button('focus','Bring forward',row.id)+button('complete','Complete',row.id);
      if(!completed){if(!foreground&&!['background','blocked'].includes(item.status))controls+=button('background',item.status==='queued'?'Start in background':'Resume in background',row.id);controls+=button('priority','Priority: '+esc(item.taskPriority||'Medium'),row.id)+button('note','Context',row.id);if(!foreground)controls+=button('up','↑',row.id,'aria-label="Move up" title="Move within this lane and priority"')+button('down','↓',row.id,'aria-label="Move down" title="Move within this lane and priority"')+button(item.status==='blocked'?'unblock':'block',item.status==='blocked'?'Unblock':'Blocked',row.id)+button('remove','Remove',row.id);}
      if(item.dueAt)controls+=button('snooze','Snooze 5m',row.id)+button('dismiss','Dismiss check-back',row.id);
      else if(['background','blocked'].includes(item.status))controls+=button('remind','Set check-back',row.id);
      controls+=button('details','Open task',row.id);
      const finished=item.status==='completed'?(Number.isFinite(item.completedAt)?'<p class="wq-time"><time datetime="'+new Date(item.completedAt).toISOString()+'">Completed '+esc(new Intl.DateTimeFormat(undefined,{timeZone:completionView.timeZone,dateStyle:'medium',timeStyle:'short'}).format(item.completedAt))+'</time></p>':'<p class="wq-time">Completion time unavailable</p>'):'';
      const readingUrl=DCC.safeUrlAttr?.(row.properties?.readingSession?.url||'');
      if(readingUrl)controls+='<a href="'+readingUrl+'" rel="noreferrer">Open book in QuietShelf</a>';
      return '<article class="wq-card '+(foreground?'wq-focus':'')+'" data-queue-id="'+esc(row.id)+'" tabindex="0" draggable="'+(!foreground&&!completed)+'"><div class="wq-card-top"><h3>'+esc(pathFor(task,index))+'</h3><span class="wq-status">'+esc(item.status==='queued'?'Not started':item.status)+'</span></div><p class="wq-time">'+esc(foreground?activeMinutes+'m this session · '+actual:actual+(item.backgroundSince?' · '+elapsed+'m waiting':''))+'</p>'+(reminder?'<p class="wq-attention">'+esc(reminder)+'</p>':'')+finished+contextHtml(item)+'<div class="wq-actions">'+controls+'</div>'+(foreground&&window.DCCWorkSessions?.checkInHtml?window.DCCWorkSessions.checkInHtml(task,Date.now()):'')+'</article>';
    }
    function lane(title,rows,empty,cls=''){return '<section class="wq-lane '+cls+'"><h2>'+title+' <small>'+rows.length+'</small></h2>'+(cls==='wq-next'?'<p class="wq-empty">High → Medium → Low. Move tasks within a priority; change Priority to move between levels.</p>':'')+(rows.length?rows.map(card).join(''):'<p class="wq-empty">'+empty+'</p>')+'</section>';}
    const fg=all.filter(i=>i.status==='foreground'),needs=all.filter(i=>i.needsYou&&i.status!=='foreground'),background=all.filter(i=>['background','paused','blocked'].includes(i.status)&&!i.needsYou),upNext=(state.queue?.priorityOrder||all.filter(i=>i.status==='queued').map(i=>i.task.id)).map(id=>all.find(i=>i.task.id===id)).filter(i=>i&&i.status==='queued'&&!i.needsYou);
    root.innerHTML='<header class="wq-header"><div><h1>Working Queue</h1><p>Priority Queue is unstarted work. Working tasks stay here; Itinerary plans when.</p></div>'+button('add','Add tasks')+'</header><p class="wq-sync" role="status">'+esc(sending?'Saving…':pending?'Update saved on this device; awaiting confirmation.':problem?'Offline or unavailable: '+problem:'Synced · waiting time is not focused effort')+'</p>'+(pending?button('retry','Retry saved update'):'')+(conflict?'<p class="wq-conflict">'+esc(conflict.message)+' Your attempted change is retained. Review current work before trying again. '+button('conflict','Review attempted change')+button('clear-conflict','Dismiss conflict')+'</p>':'')+(state.otherWorkspaceForeground?'<p class="wq-conflict">Work is active in another workspace. Pause it there before bringing a task forward here.</p>':'')+'<div class="wq-grid">'+lane('Foreground',fg,'Choose a task below to begin focused work.','wq-foreground')+lane('Needs You',needs,'No reported review actions or manual check-backs due.','wq-needs')+lane('Priority Queue',upNext,'No unstarted tasks in your queue. Add existing tasks to prioritize them.','wq-next')+lane('Background & paused',background,'Tasks you set aside keep their context here.','wq-background')+'</div>'+completedHtml();
    function completedHtml(){
      const help=completedPeriod==='today'?'Calendar day · '+completionView.timeZone:completedPeriod==='latest'?'Most recent known completion':completedPeriod==='all'?'All retained queue history':'Rolling last '+periodLabel.toLowerCase();
      return '<details class="wq-completed"><summary>Completed · '+esc(periodLabel)+' · '+completionView.rows.length+'</summary><div class="wq-completed-controls"><label>Completed timeframe<select data-completed-period aria-describedby="wq-completed-help">'+window.DCCCompletedQueueFilter.options.map(([value,label])=>'<option value="'+value+'"'+(value===completedPeriod?' selected':'')+'>'+label+'</option>').join('')+'</select></label><p class="wq-time" id="wq-completed-help">'+esc(help)+'</p></div><p class="wq-time" role="status">'+completionView.rows.length+' of '+completionView.total+' retained completed tasks'+(completionView.unknown?' · '+completionView.unknown+' without a completion time'+(completedPeriod==='all'?'':' (shown in All time)'):'')+'</p>'+(completionView.rows.length?completionView.rows.map(card).join(''):'<p class="wq-empty">No completed tasks in this time range.</p>')+'</details>';
    }
    for(const id of contextOpen)root.querySelector('[data-queue-id="'+CSS.escape(id)+'"] .wq-context')?.setAttribute('open','');
    if(contextFocused)root.querySelector('[data-queue-id="'+CSS.escape(contextFocused)+'"] .wq-context > summary')?.focus({preventScroll:true});
    if(completedOpen)root.querySelector('.wq-completed')?.setAttribute('open','');
    if(periodFocused)root.querySelector('[data-completed-period]')?.focus({preventScroll:true});
    if(completedFocused)root.querySelector('.wq-completed > summary')?.focus({preventScroll:true});
    if(focusKey)root.querySelector('[data-queue-action="'+CSS.escape(focusKey)+'"][data-task-id="'+CSS.escape(focusId||'')+'"]')?.focus({preventScroll:true});
  }
  function modal(title,body,submit,label='Save',onClose){let busy=false;return DCC.overlay.open({kind:'modal',title,body,onClose,canClose:reason=>!busy||reason==='glasses-back',actions:[{label:'Cancel'},{label,kind:'primary',onClick:async()=>{if(busy)return false;busy=true;try{await submit();return true;}catch(error){const el=body.querySelector('[role=status]');if(el)el.textContent=error.message;else warn(error);return false;}finally{busy=false;}}}]});}
  function form(html){const body=document.createElement('div');body.className='wq-form';body.innerHTML=html+'<p role="status"></p>';return body;}
  async function transition(action,item,callbacks={}){
    const body=form('<p>'+esc(item.task.properties.title||'Task')+'</p>'+(['start','background-start','queue-block'].includes(action)?'<label>Check back on the background task<select data-minutes><option value="">No reminder</option><option value="5">5 minutes</option><option value="15" selected>15 minutes</option><option value="30">30 minutes</option><option value="120">2 hours</option><option value="custom">Custom</option></select></label><label data-custom hidden>Minutes<input type="number" min="1" max="1440" value="10"></label>':'')+(action==='done'?'<div data-completion-time aria-live="off">Loading recorded time…</div><p>Completing saves the current focused session to this task. The saved total is confirmed after the update succeeds.</p>':'')+(item.task.properties.guidedDefinitionId?'<details open><summary>Guided instructions</summary><pre data-preview>Loading…</pre></details>'+(action==='done'?'<label>Outcome<textarea data-outcome maxlength="6000" required></textarea></label>':''):''));
    let guided=null,ready=!item.task.properties.guidedDefinitionId,completion=null,clockOffset=0,command=null;
    const formatSeconds=seconds=>Math.floor(seconds/60)+'m '+String(seconds%60).padStart(2,'0')+'s';
    function updateCompletion(){
      const el=body.querySelector('[data-completion-time]');if(!el||!completion)return;
      const value=window.DCCWorkCompletion.project(completion,command?Date.parse(command.at):Date.now()+clockOffset);
      el.innerHTML='<dl class="wq-effort"><div><dt>Previously recorded'+(completion.history.estimated?' (estimated)':'')+'</dt><dd>'+esc(completion.history.savedMinutes==null?'Unknown':completion.history.savedMinutes+'m')+'</dd></div><div><dt>Current timer</dt><dd>'+esc(value.active?formatSeconds(value.elapsedSeconds):'Not running')+'</dd></div><div><dt>After completion'+(value.active?' (estimated)':'')+'</dt><dd>'+esc(value.projectedMinutes==null?'Unknown':value.projectedMinutes+'m')+'</dd></div></dl>'+(value.active?'<p class="wq-time">'+esc(formatSeconds(value.creditSeconds)+' of this session will be recorded.'+(value.capped?' Time after the missed check-in cutoff stays unknown.':' Totals round once after adding recorded seconds.'))+'</p>':'<p class="wq-time">No running session to add. Recorded time stays as saved.</p>')+(completion.history.carryMinutes?'<p class="wq-time">Includes '+esc(completion.history.carryMinutes)+'m saved before or outside the session ledger.</p>':'');
    }
    if(action==='done')DCC.api('/api/working-queue/tasks/'+encodeURIComponent(item.task.id)+'/completion-preview',{cache:'no-store'}).then(view=>{completion=view;clockOffset=view.serverNow-Date.now();updateCompletion();}).catch(error=>{body.querySelector('[role=status]').textContent='Time summary unavailable: '+error.message;});
    const select=body.querySelector('[data-minutes]');select?.addEventListener('change',()=>{body.querySelector('[data-custom]').hidden=select.value!=='custom';});
    const handle=modal(action==='start'?'Bring forward':action==='done'?'Complete task':'Set task aside',body,async()=>{
      if(!ready)throw new Error('Wait for current guided instructions.');
      if(action==='done'&&!completion)throw new Error('Wait for the recorded-time summary, or reopen this dialog to retry.');
      const minutes=select?(select.value==='custom'?Number(body.querySelector('[data-custom] input').value):select.value?Number(select.value):null):null;
      if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>1440))throw new Error('Choose 1–1440 minutes.');
      const payload={taskId:item.task.id,...(select?{remindMinutes:minutes}:{})};
      const outcome=action==='done'&&guided?body.querySelector('[data-outcome]').value:null;
      if(outcome!==null&&(!outcome.trim()||outcome.length>6000))throw new Error('Record a confirmed outcome (1–6000 characters) before completing.');
      if(guided)payload.guided={expectedRevision:guided.revision,expectedDefinitionRevision:guided.definitionRevision,expectedContextVersion:guided.contextVersion,...(action==='done'?{outcome:outcome.trim(),confirmed:true}:{})};
      if(!command||action!=='done')command=envelope(action,{...payload,...(completion?{expectedRevision:completion.revision}:{})});
      updateCompletion();
      try {
        const result=await send(command);
        callbacks.success?.(result);
        if(action==='done')DCC.toast('Task completed · '+(result.task?.properties.actualMinutes==null?'focused time unknown':result.task.properties.actualMinutes+'m recorded'),'success');
      } catch(error) {
        if([400,403,404,409].includes(error.status))throw new Error(error.message+(action==='done'?' Close this dialog and review the current task before completing.':''));
        throw new Error((action==='done'?'Completion not confirmed. Retry uses the same saved update. ':'Update not confirmed. ')+error.message);
      }
    },action==='start'?'Bring forward':action==='done'?'Complete':'Save',callbacks.close);
    if(action==='done'){const timer=setInterval(()=>{if(!body.isConnected){clearInterval(timer);return;}updateCompletion();},1000);}
    if(!ready)DCC.api('/api/guided/tasks/'+encodeURIComponent(item.task.id),{cache:'no-store'}).then(view=>{guided=view;ready=true;body.querySelector('[data-preview]').textContent=view.prompt;}).catch(error=>{body.querySelector('[role=status]').textContent=error.message;});
    return handle;
  }
  // Glasses use the same receipt, revision and foreground coordinator as every client.
  // Foreground selection opens notes locally; only explicit queue intents mutate work.
  async function glassesAction(intent,id,revision){
    if(!['add','focus','complete','dismiss'].includes(intent))throw new Error('Unsupported glasses work action');
    if(!navigator.onLine)throw new Error('Offline. Reconnect before changing work.');
    if(pending||sending)throw new Error('Wait for the saved update to be confirmed.');
    if(revision!==state.revision)throw new Error('Work changed. Review the current task and try again.');
    const item=items().find(i=>i.task.id===id);
    if(intent==='add') {if(item)return {ok:true};return send(envelope('queue-add',{taskId:id,expectedRevision:revision}));}
    if(!item||item.status==='completed')throw new Error('This task is no longer open.');
    if(intent==='dismiss'){
      let expectedRevision=revision;
      if(item.status==='foreground'){
        const paused=await send(envelope('pause',{taskId:id,expectedRevision}));
        expectedRevision=(paused.currentState||paused.state).revision;
      }
      return send(envelope('queue-remove',{taskId:id,expectedRevision}));
    }
    if(intent==='focus'&&item.status==='foreground')return {ok:true};
    const action=intent==='complete'?'done':'start';
    if(item.task.properties.guidedDefinitionId&&['start','done'].includes(action)){
      return window.DCCGlassesQueue.review(callbacks=>transition(action,item,callbacks));
    }
    let expectedRevision=revision;
    if(action==='done'){
      const preview=await DCC.api('/api/working-queue/tasks/'+encodeURIComponent(id)+'/completion-preview',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(preview.revision!==revision) {await refresh();throw new Error('Work changed. Review the timer before completing.');}
      expectedRevision=preview.revision;
    }
    return send(envelope(action,{taskId:id,expectedRevision,...(action==='start'?{remindMinutes:null}:{})}));
  }
  function addTasks(){
    const body=form('<label>Find an existing task<input type="search" data-search placeholder="Search tasks" autofocus></label><div data-results></div><button type="button" data-more hidden>More results</button>');
    const handle=DCC.overlay.open({kind:'modal',title:'Add tasks to your queue',body,actions:[{label:'Done'}]});
    let sequence=0,offset=0,query='',timer,adding=false;
    async function search(append=false){const token=++sequence;query=body.querySelector('[data-search]').value;if(!append)offset=0;try{const result=await DCC.api('/api/working-queue/tasks?query='+encodeURIComponent(query)+'&offset='+offset,{cache:'no-store'});if(token!==sequence)return;const rows=result.tasks.filter(t=>t.status!=='done'&&t.type!=='recurring-definition');const html=rows.map(t=>'<button type="button" data-add-id="'+esc(t.id)+'" '+(items().some(i=>i.task.id===t.id)?'disabled':'')+'>'+esc(t.title)+' <small>'+esc(t.date||'Unscheduled')+'</small></button>').join('');if(append)body.querySelector('[data-results]').insertAdjacentHTML('beforeend',html);else body.querySelector('[data-results]').innerHTML=html||'<p>No matching open tasks. Search an existing occurrence for recurring work.</p>';offset=result.nextOffset;body.querySelector('[data-more]').hidden=offset==null;}catch(error){body.querySelector('[role=status]').textContent=error.message;}}
    body.querySelector('[data-search]').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>search(),180);});body.querySelector('[data-more]').addEventListener('click',()=>search(true));
    body.addEventListener('click',async event=>{const button=event.target.closest('[data-add-id]');if(!button||adding)return;adding=true;body.querySelectorAll('[data-add-id]').forEach(b=>b.disabled=true);try{await send(envelope('queue-add',{taskId:button.dataset.addId}));body.querySelector('[role=status]').textContent='Added to queue.';}catch(error){body.querySelector('[role=status]').textContent=error.message;}finally{adding=false;body.querySelectorAll('[data-add-id]').forEach(b=>b.disabled=items().some(i=>i.task.id===b.dataset.addId));}});search();return handle;
  }
  function reorder(id,target){
    const item=items().find(i=>i.task.id===id);if(!item)return;
    const peers=items().filter(i=>i.status===item.status&&!!i.needsYou===!!item.needsYou&&(item.status!=='queued'||i.taskPriority===item.taskPriority)).map(i=>i.task.id);
    const peerIndex=peers.indexOf(id),targetId=typeof target==='number'?peers[peerIndex+target]:target;
    if(!targetId||!peers.includes(targetId)||id===targetId)return;
    const order=state.queue.order.slice(),from=order.indexOf(id),to=order.indexOf(targetId);
    order.splice(from,1);order.splice(to,0,id);return send(envelope('queue-reorder',{order}));
  }
  document.addEventListener('change',event=>{if(event.target.matches('[data-completed-period]')){completedPeriod=event.target.value;render();}});
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-queue-action]');if(!button)return;const action=button.dataset.queueAction,item=items().find(i=>i.task.id===button.dataset.taskId);
    if(action==='add'){addTasks();return;}if(action==='retry'&&pending){send(pending).catch(warn);return;}
    if(action==='clear-conflict'){conflict=null;persist(':conflict',null);render();return;}
    if(action==='conflict'){const body=form('<p>'+esc(conflict?.message)+'</p><pre>'+esc(JSON.stringify(conflict?.body,null,2))+'</pre>');DCC.overlay.open({kind:'modal',title:'Attempted change',body,actions:[{label:'Close'}]});return;}
    if(!item)return;
    if(action==='details'){const task=DCC.TaskModel.fromBlock(item.task);if(window.DCCTaskWorkspace?.preview)window.DCCTaskWorkspace.preview(task);else if(typeof window.openAddModal==='function')window.openAddModal(task.id,task.title);else {const body=form('<h3>'+esc(task.title)+'</h3><p>'+esc(task.detail||'No task details yet.')+'</p>');DCC.overlay.open({kind:'modal',title:'Task details',body,actions:[{label:'Close'}]});}return;}
    if(['focus','background','complete','block','remind'].includes(action)){transition(action==='focus'?'start':action==='complete'?'done':action==='block'?'queue-block':'background-start',item);return;}
    if(action==='priority'){
      const body=form('<label>Task priority<select data-priority>'+['High','Medium','Low'].map(p=>'<option'+(p===(item.taskPriority||'Medium')?' selected':'')+'>'+p+'</option>').join('')+'</select></label><p>This changes priority only. Planned times and work history stay as recorded.</p>');
      modal('Set priority',body,()=>send(envelope('queue-priority',{taskId:item.task.id,taskPriority:body.querySelector('[data-priority]').value})));return;
    }
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
    const due=items().find(i=>i.dueAt&&Date.parse(i.dueAt)<=Date.now()&&i.needsYou&&!i.notifiedAt);if(!due)return;
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
  // Keep the former rotation navigation entry point. Floating workspace focus()
  // must be migrated to the shared coordinator when that separate feature lands.
  window.DCCWorkRotation={render,refresh,tick,open:(_from,to)=>{activate();if(to){const row=items().find(i=>i.task.id===(to._blockId||to.id));if(row)transition('start',row);}else addTasks();}};
})();
