/* global window, document, localStorage, navigator, CSS, AbortSignal */
// One view over the account coordinator. No client-only foreground state.
(function () {
  'use strict';
  const DCC=window.DCC, account=window.DCC_ACCOUNT_CONTEXT;
  if(!DCC || !account?.userId || !account.workspaceId)return;
  const key='dcc-working-queue:'+account.workspaceId+':'+account.userId;
  let state={revision:0,foreground:[],queue:{items:[],order:[]}},pending=null,conflict=null,loading=null,sending=false,ticking=false,problem='',startOpening=false;
  try {state=JSON.parse(localStorage.getItem(key))||state;pending=JSON.parse(localStorage.getItem(key+':pending'));conflict=JSON.parse(localStorage.getItem(key+':conflict'));}catch(_e){}
  const esc=DCC.esc,items=()=>(state.queue?.items||[]).map(item=>window.DCCQueuePolicy.presentation(item));
  let completedPeriod='today'; // Per-view choice only; each new page starts on Today.
  function persist(name,value){if(value==null)localStorage.removeItem(key+name);else localStorage.setItem(key+name,JSON.stringify(value));}
  // Memory, then storage, then the header notice: observers read the new state.
  function notifySync(){document.dispatchEvent(new CustomEvent('dcc:working-queue-sync'));}
  function setPending(value){pending=value;persist(':pending',value);notifySync();}
  function setConflict(value){conflict=value;persist(':conflict',value);notifySync();}
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
    sending=true;setPending(body);render();
    try {const result=await DCC.api('/api/working-queue',{method:'POST',body,signal:AbortSignal.timeout(15000)});setPending(null);apply(result);return result;}
    catch(error){if([400,403,404,409].includes(error.status)){setConflict({body,message:error.message});setPending(null);await refresh().catch(()=>{});}throw error;}
    finally{sending=false;render();}
  }
  function send(body){return navigator.locks?.request?navigator.locks.request(key+':write',()=>sendUnlocked(body)):sendUnlocked(body);}
  const warn=error=>DCC.toast(error.message||'Queue update failed','error');
  function activate(id){if(DCC.nav)DCC.nav.go({page:'tasks',view:'queue'});else document.querySelector('.tab[data-tab="working-queue"]')?.click();render();if(id)document.querySelector('[data-queue-id="'+CSS.escape(id)+'"]')?.scrollIntoView({block:'nearest',behavior:DCC.reducedMotion?.()?'auto':'smooth'});}
  // Independent columns: each lane sizes to its own content. Stacked keeps the
  // DOM (and focus) order Foreground, Needs You, Priority, Background.
  const narrow=window.matchMedia('(max-width: 700px)');
  const LANES={stacked:[['wq-foreground','wq-needs'],['wq-next','wq-background']],columns:[['wq-foreground','wq-next'],['wq-needs','wq-background']]};
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
    return [...rows.values()].filter(row=>!row.deleted_at);
  }
  function taskPool(anchor){
    const rows=anchor.sourceRows||[],parents=new Map();
    for(const row of rows)for(const id of new Set([row.id,row.properties?.local_id].filter(Boolean))){if(!parents.has(id))parents.set(id,[]);parents.get(id).push(row);}
    return rows.filter(r=>r.type==='block').map(row=>{
      const ev=DCC.TaskModel.fromBlock(row);ev.id=row.id;ev.__unf={sourceId:row.id,sourceDate:row.date,sourceBlock:row};
      for(const key of ['subtaskOf','wrapParent']){const parent=parents.get(ev[key])||[];if(parent.length===1)ev[key]=parent[0].id;}
      return ev;
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
    const focused=document.activeElement,focusKey=focused?.dataset.queueAction,focusId=focused?.dataset.taskId;
    const completedOpen=root.querySelector('.wq-completed')?.open;
    const periodFocused=focused?.matches('[data-completed-period]');
    const completionView=window.DCCCompletedQueueFilter.select(items(),completedPeriod,Date.now(),state.timeZone);
    const periodLabel=window.DCCCompletedQueueFilter.options.find(([value])=>value===completedPeriod)[1];
    const helpOpen=new Set(Array.from(root.querySelectorAll('.wq-help[open]')).map(el=>el.dataset.queueHelp));
    const helpFocused=focused?.closest('.wq-help')?.dataset.queueHelp;
    const contextOpen=new Set(Array.from(root.querySelectorAll('.wq-context[open]')).map(el=>el.closest('[data-queue-id]').dataset.queueId));
    const contextFocused=focused?.matches('.wq-context > summary')?focused.closest('[data-queue-id]').dataset.queueId:null;
    const completedFocused=focused?.matches('.wq-completed > summary');
    const all=items(),index=new Map((window.DCCWorkSessions?.availableTasks()||[]).map(t=>[t.id,t]));all.forEach(i=>{const t=DCC.TaskModel.fromBlock(i.task);index.set(t.id,t);});
    const cards=[];
    function card(item){
      const row=item.task,task=DCC.TaskModel.fromBlock(row),foreground=item.status==='foreground',completed=item.status==='completed';
      const elapsed=item.backgroundSince?Math.max(0,Math.floor((Date.now()-Date.parse(item.backgroundSince))/60000)):0;
      const reminder=item.snoozed?'':item.dueAt?(Date.parse(item.dueAt)<=Date.now()?'Check back now':'Check back in '+Math.max(1,Math.ceil((Date.parse(item.dueAt)-Date.now())/60000))+'m'):'';
      const actual=item.actualMinutes==null?'Focused actuals unknown':item.actualMinutes+'m focused saved';
      const activeMinutes=foreground&&!item.onBreak?Math.max(0,Math.floor((Date.now()-Date.parse(row.properties.startedAt))/60000)):0;
      let controls=completed?'':foreground?button('background','Send to background',row.id)+button('pause','Pause',row.id):button('focus','Bring forward',row.id);
      if(!completed){if(!foreground)controls+=button('up','↑',row.id,'aria-label="Move up" title="Move up one position. Hold or Shift+Enter to move to the top of this group." aria-describedby="wq-order-help"')+button('down','↓',row.id,'aria-label="Move down" title="Move down one position. Hold or Shift+Enter to move to the top of this group." aria-describedby="wq-order-help"');}
      const held=!completed&&!foreground&&returnHold(item);
      if(!completed&&!foreground)controls+=button('return','Return to Priority',row.id,held?'disabled aria-describedby="queue-return-'+esc(row.id)+'"':'')+button('snooze','Snooze',row.id,'aria-haspopup="dialog"');
      if(item.dueAt)controls+=button('dismiss','Dismiss reminder',row.id);
      const snoozedHtml=item.snoozed?'<p class="wq-attention">Snoozed until '+esc(when(Date.parse(item.snoozedUntil),completionView.timeZone))+'</p><p class="wq-time">Attention snoozed; worker state and focused time are unchanged.</p>':'';


      const finished=item.status==='completed'?(Number.isFinite(item.completedAt)?'<p class="wq-time"><time datetime="'+new Date(item.completedAt).toISOString()+'">Completed '+esc(new Intl.DateTimeFormat(undefined,{timeZone:completionView.timeZone,dateStyle:'medium',timeStyle:'short'}).format(item.completedAt))+'</time></p>':'<p class="wq-time">Completion time unavailable</p>'):'';
      const readingUrl=DCC.safeUrlAttr?.(row.properties?.readingSession?.url||'');
      if(readingUrl)controls+='<a href="'+readingUrl+'" rel="noreferrer">Open book in QuietShelf</a>';
      const node=window.renderItineraryListRow({...task,title:pathFor(task,index)},{
        extraClass:'wq-card'+(foreground?' wq-focus':'')+(item.onBreak?' wq-on-break':''),dataset:{queueId:row.id},
        done:completed, completionTitle:'Complete task: '+task.title,
        onComplete:completed?null:()=>transition('done',item).catch(warn),
        onCompleteWithNotes:completed?null:()=>transition('done',item).catch(warn),
        onOpen:()=>openDetails(row.id).catch(warn),
        onSchedule:completed?null:anchor=>openSchedule(item,anchor).catch(warn),scheduleLabel:'Schedule',
        titleExtrasHtml:'<span class="wq-status">'+esc(item.needsYou?'Needs You':item.snoozed?'Snoozed':item.status==='queued'?'Priority':item.status)+'</span>',
        metaHtml:'<p class="wq-time">'+esc(foreground?activeMinutes+'m this session · '+actual:actual+(item.backgroundSince?' · '+elapsed+'m waiting':''))+'</p>'+(reminder?'<p class="wq-attention">'+esc(reminder)+'</p>':'')+snoozedHtml+finished+(held?'<p class="wq-time" id="queue-return-'+esc(row.id)+'">'+esc(held)+'</p>':'')+contextHtml(item)
      });
      if(!completed){
        const levels=DCC.TaskPriority.levels,priority=levels.includes(item.taskPriority)?item.taskPriority:'Medium';
        const next=levels[(levels.indexOf(priority)+1)%levels.length];
        const label=priority+' priority. Click to change to '+next+' priority. Tap, hold, Shift+Enter or Arrow Down to choose.';
        const utility=node.querySelector('.it-list-utility');
        utility.insertAdjacentHTML('beforeend',button('priority','<span aria-hidden="true">'+({'Very low':'⇊',Low:'↓',Medium:'=',High:'↑','Very high':'⇈'})[priority]+'</span>',row.id,'class="wq-priority-symbol" data-priority-level="'+levels.indexOf(priority)+'" aria-haspopup="dialog" aria-label="'+label+'" title="'+label+'"'));
      }
      const title=node.querySelector('.ttl'),titleGroup=document.createElement('span'),copy=document.createElement('button');
      titleGroup.className='wq-title-with-copy';title.replaceWith(titleGroup);titleGroup.appendChild(title);
      const exactTitle=String(row.properties.title??task.title??'');
      copy.type='button';copy.className='wq-copy-title';copy.dataset.queueAction='copy-title';copy.dataset.taskId=row.id;
      copy.setAttribute('aria-label','Copy task title: '+exactTitle);copy.title='Copy task title';copy.draggable=false;
      copy.innerHTML='<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
      copy.addEventListener('pointerdown',event=>event.stopPropagation());
      copy.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();const hadFocus=document.activeElement===copy;copy.disabled=true;try{const ok=await DCC.copyText(exactTitle);DCC.toast(ok?'Title copied':'Could not copy title. Select the title and copy it manually.',ok?'success':'error');}finally{copy.disabled=false;if(hadFocus&&document.activeElement===document.body){const current=document.querySelector('[data-queue-id="'+CSS.escape(row.id)+'"] .wq-copy-title');current?.focus({preventScroll:true});}}});
      titleGroup.appendChild(copy);
      node.tabIndex=0;node.draggable=!completed;
      const actions=document.createElement('div');actions.className='wq-actions';actions.innerHTML=controls;
      const schedule=node.querySelector('.btn-schedule');if(schedule)actions.prepend(schedule);
      node.querySelector('.it-list-main').appendChild(actions);
      if(foreground&&!item.onBreak&&window.DCCWorkSessions?.checkInHtml)node.insertAdjacentHTML('beforeend',window.DCCWorkSessions.checkInHtml(task,Date.now()));
      if(item.onBreak){
        // Cover the whole shared card, including its utility gutter. Keep the
        // underlying layout intact, but remove every covered control from use.
        for(const child of node.children){child.inert=true;child.setAttribute('aria-hidden','true');}
        node.tabIndex=-1;node.draggable=false;node.setAttribute('role','group');
        node.setAttribute('aria-label','Paused task: '+task.title);
        const veil=document.createElement('div');veil.className='wq-break-veil';
        veil.innerHTML='<div class="wq-break-header"><span class="wq-break-title">'+esc(pathFor(task,index))+'</span><span class="wq-break-badge">On a break</span>'+button('break-options','⋯',row.id,'aria-label="Task options" aria-haspopup="dialog"')+'</div><div class="wq-break-body"><div class="wq-break-copy"><strong role="status"><span class="wq-break-symbol" aria-hidden="true">Ⅱ</span> I’m on a break</strong><p><span data-break-clock data-break-since="'+esc(item.breakStartedAt)+'"></span> on break<span class="wq-break-timer-note">Work timer paused</span></p></div>'+button('focus','▶ Resume task',row.id)+'</div>';
        veil.addEventListener('click',event=>{if(!event.target.closest('[data-queue-action]'))event.stopPropagation();});
        node.appendChild(veil);
      }
      const completionButton=node.querySelector('.quick-complete-control');if(completionButton){completionButton.dataset.queueAction='complete';completionButton.dataset.taskId=row.id;}
      const priorityButton=node.querySelector('[data-queue-action="priority"]');
      if(priorityButton){
        const choose=()=>choosePriority(item);
        let touch=false;priorityButton.addEventListener('pointerdown',event=>{touch=event.pointerType==='touch';});
        DCC.bindHoldAction(priorityButton,()=>{if(touch){touch=false;choose();return;}const levels=DCC.TaskPriority.levels;send(envelope('queue-priority',{taskId:row.id,taskPriority:levels[(levels.indexOf(item.taskPriority||'Medium')+1)%levels.length]})).catch(warn);},choose);
        priorityButton.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();choose();}});
      }
      node.querySelectorAll('[data-queue-action="up"],[data-queue-action="down"]').forEach(control=>DCC.bindHoldAction(control,()=>reorder(row.id,control.dataset.queueAction==='up'?-1:1)?.catch(warn),()=>reorder(row.id,'top')?.catch(warn)));
      cards.push(node);return '<div data-wq-card="'+(cards.length-1)+'"></div>';
    }
    function lane(title,rows,empty,cls='',policy='') {return '<section class="wq-lane '+cls+'" data-queue-lane="'+cls+'"><div class="wq-heading"><h2>'+title+' <small>'+rows.length+'</small></h2>'+(policy==='needs'?button('snooze-all',sending?'Saving…':'Snooze all',null,'aria-haspopup="dialog" aria-label="Snooze all '+rows.length+' Needs You items" '+(!rows.length||sending||pending||conflict?'disabled':'')):'')+(policy==='foreground'?button('pomodoro',window.DCCPomodoro?.label()||'🍅',null,'aria-label="Create or open Pomodoro focus plan" aria-haspopup="dialog"'):'')+'<details class="wq-help" data-queue-help="'+policy+'"><summary aria-label="About '+title+'">ⓘ</summary><p>'+esc(window.DCCQueuePolicy.tips[policy])+'</p></details></div>'+(cls==='wq-next'?'<p class="wq-empty">Very high → High → Medium → Low → Very low. Move tasks within a priority; change Priority to move between levels.</p>':'')+(rows.length?rows.map(card).join(''):'<p class="wq-empty">'+empty+'</p>')+'</section>';}
    const {foreground:fg,needs,background,priority:upNext}=window.DCCQueuePolicy.lanes(all,DCC.TaskPriority.group);
    const lanes={'wq-foreground':lane('Foreground',fg,'Choose a task below to begin focused work.','wq-foreground','foreground'),'wq-needs':lane('Needs You',needs,'No reported review actions or manual check-backs due.','wq-needs','needs'),'wq-next':lane('Priority Queue',upNext,'No inactive tasks in your queue. Add existing tasks to prioritize them.','wq-next','priority'),'wq-background':lane('Background',background,'No active workers or snoozed requests.','wq-background','background')};
    root.dataset.priorityStyle='outline';
    root.innerHTML='<p id="wq-order-help" class="wq-order-help">Order: click ↑ or ↓ for one step; hold either arrow or press Shift+Enter to jump to the top of its group.</p><header class="wq-header"><div><h1>Working Queue</h1><p>One foreground task. Active workers and snoozed requests in Background; inactive work in Priority. Itinerary and Calendar plan when.</p></div>'+button('add','Add tasks')+'</header><p class="wq-sync" role="status">'+esc(sending?'Saving…':pending?'Update saved on this device; awaiting confirmation.':problem?'Offline or unavailable: '+problem:'Synced · waiting time is not focused effort')+'</p>'+(pending?button('retry','Retry saved update'):'')+(conflict?'<p class="wq-conflict">'+esc(conflict.message)+' Your attempted change is retained. Review current work before trying again. '+button('conflict','Review attempted change')+button('clear-conflict','Dismiss conflict')+'</p>':'')+(state.otherWorkspaceForeground?'<p class="wq-conflict">Another workspace holds Foreground. Open it, pause if needed, then choose Return to Priority before bringing a task forward here.</p>':'')+'<div class="wq-grid">'+layout().map(names=>'<div class="wq-col">'+names.map(name=>lanes[name]).join('')+'</div>').join('')+'</div>'+completedHtml();
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
    modal('Choose priority',body,()=>send(envelope('queue-priority',{taskId:item.task.id,taskPriority:body.querySelector('[data-priority]').value})));
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
  async function openSchedule(item,anchorEl){
    const anchor=await prepareTask(item.task.id),task=anchor.ev;
    if(!anchor.date){
      return window.openSchedulePopover({mode:'pick',id:task.id,task,anchorEl,view:'date',header:'Add “'+task.title+'” to itinerary',actionLabel:'Add',onPick:async date=>{
        const result=await window.blockStore.rescheduleBlock(anchor.blockId,date,{placement:{kind:'pool_date'}});await refresh();return result;
      }});
    }
    window.openSchedulePopover({mode:'reschedule',id:task.id,task,anchorEl,view:'date',onMove:async(date,time)=>{
      const duration=Math.max(1,Number(task.durMin||task.duration)||30);
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
  async function transition(action,item){
    let displaced=null,startRevision=null;
    if(action==='start'){
      if(startOpening)return;
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
          await send(envelope('start',{taskId:item.task.id,expectedRevision:startRevision,expectedForegroundTaskId:null}));
          startOpening=false;return;
        }
      } catch(error){startOpening=false;warn(error);return;}
    }
    let completionNote;
    if(action==='done'){const anchor=await prepareTask(item.task.id);completionNote=await window.loadTaskNotesForAnchor(anchor);item=items().find(row=>row.task.id===item.task.id)||item;}
    const timerNeeded=action==='start'?!!displaced:['background-start','queue-block'].includes(action);
    const timer=timerNeeded?'<label>'+'Snooze'+'<select data-minutes aria-label="Snooze duration">'+(action==='queue-block'?'<option value="">Needs You now</option>':'')+'<option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="1440">24 hours</option><option value="custom">Custom</option></select></label><label data-custom hidden>Minutes<input type="number" min="1" max="1440" value="10"></label>':'';
    const heading=action==='start'?(displaced?'<div class="wq-switch-old"><div><strong>Moving to Background</strong><p>'+esc(displaced.task.properties.title||'Task')+'</p></div>'+timer+'</div><div class="wq-switch-new"><strong>Moving to Foreground</strong><p>'+esc(item.task.properties.title||'Task')+'</p></div>':'<p>'+esc(item.task.properties.title||'Task')+'</p>'):'<p>'+esc(item.task.properties.title||'Task')+'</p>';
    const body=form(heading+(action==='background-start'?'<p>This sets the task aside and optionally sets a check-back. It does not start a worker. A selected Snooze waits in Background; without one, inactive work returns to Priority.</p>':'')+(action==='start'?'':timer)+(action==='done'?'<div data-completion-time aria-live="off">Loading recorded time…</div><p>Completing saves the current focused session to this task. The saved total is confirmed after the update succeeds.</p>':'')+(item.task.properties.guidedDefinitionId?'<details open><summary>Guided instructions</summary><pre data-preview>Loading…</pre></details>'+(action==='done'?'<label>Outcome<textarea data-outcome required></textarea></label>':''):''));
    let guided=null,ready=!item.task.properties.guidedDefinitionId,completion=null,clockOffset=0,command=null;
    const formatSeconds=seconds=>Math.floor(seconds/60)+'m '+String(seconds%60).padStart(2,'0')+'s';
    function updateCompletion(){
      const el=body.querySelector('[data-completion-time]');if(!el||!completion)return;
      const value=window.DCCWorkCompletion.project(completion,command?Date.parse(command.at):Date.now()+clockOffset);
      el.innerHTML='<dl class="wq-effort"><div><dt>Previously recorded'+(completion.history.estimated?' (estimated)':'')+'</dt><dd>'+esc(completion.history.savedMinutes==null?'Unknown':completion.history.savedMinutes+'m')+'</dd></div><div><dt>Current timer</dt><dd>'+esc(value.active?formatSeconds(value.elapsedSeconds):'Not running')+'</dd></div><div><dt>After completion'+(value.active?' (estimated)':'')+'</dt><dd>'+esc(value.projectedMinutes==null?'Unknown':value.projectedMinutes+'m')+'</dd></div></dl>'+(value.active?'<p class="wq-time">'+esc(formatSeconds(value.creditSeconds)+' of this session will be recorded.'+(value.capped?' Time after the missed check-in cutoff stays unknown.':' Totals round once after adding recorded seconds.'))+'</p>':'<p class="wq-time">No running session to add. Recorded time stays as saved.</p>')+(completion.history.carryMinutes?'<p class="wq-time">Includes '+esc(completion.history.carryMinutes)+'m saved before or outside the session ledger.</p>':'');
    }
    if(action==='done')DCC.api('/api/working-queue/tasks/'+encodeURIComponent(item.task.id)+'/completion-preview',{cache:'no-store'}).then(view=>{completion=view;clockOffset=view.serverNow-Date.now();updateCompletion();}).catch(error=>{body.querySelector('[role=status]').textContent='Time summary unavailable: '+error.message;});
    const select=body.querySelector('[data-minutes]');select?.addEventListener('change',()=>{body.querySelector('[data-custom]').hidden=select.value!=='custom';});
    const submit=async()=>{
      if(!ready)throw new Error('Wait for current guided instructions.');
      if(action==='done'&&!completion)throw new Error('Wait for the recorded-time summary, or reopen this dialog to retry.');
      const minutes=select?(select.value==='custom'?Number(body.querySelector('[data-custom] input').value):select.value?Number(select.value):null):null;
      if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>1440))throw new Error('Choose 1–1440 minutes.');
      const payload={taskId:item.task.id,...(select?{remindMinutes:minutes}:{}),...(select&&minutes!==null?{attentionMode:'snooze'}:{}),...(action==='start'?{expectedForegroundTaskId:displaced?.task.id||null}:{})};
      if(guided)payload.guided={expectedRevision:guided.revision,expectedDefinitionRevision:guided.definitionRevision,expectedContextVersion:guided.contextVersion,...(action==='done'?{outcome:body.querySelector('[data-outcome]').value,confirmed:true}:{})};
      if(!command||!['start','done'].includes(action))command=envelope(action,{...payload,...(action==='start'?{expectedRevision:startRevision}:completion?{expectedRevision:completion.revision}:{})});
      if(action==='start')body.querySelectorAll('[data-minutes],[data-custom] input').forEach(el=>{el.disabled=true;});
      updateCompletion();
      try {
        const result=await send(command);
        if(action==='done')DCC.toast('Task completed · '+(result.task?.properties.actualMinutes==null?'focused time unknown':result.task.properties.actualMinutes+'m recorded'),'success');
      } catch(error) {
        if([400,403,404,409].includes(error.status))throw new Error(error.message+(action==='done'?' Close this dialog and review the current task before completing.':''));
        throw new Error((action==='done'?'Completion not confirmed. Retry uses the same saved update. ':'Update not confirmed. ')+error.message);
      }
    };
    const handle=action==='done'
      ?window.openDoneModal(item.task.id,item.task.properties.title,submit,DCC.TaskModel.fromBlock(item.task),{body,noteValue:completionNote,authoritativeTime:true,awaitConfirmation:true,saveNotes:note=>window.saveTaskNotes(item.task.id,note)})
      :modal(action==='start'?(displaced?'Switch foreground task':'Guided instructions'):action==='queue-block'?'Blocked / Waiting':['queue-snooze','queue-remind'].includes(action)?'Snooze':'Set task aside',body,submit,action==='start'?'Bring forward':'Save',()=>{if(action==='start')startOpening=false;});
    if(action==='start'&&!body.isConnected)startOpening=false;
    if(action==='done'){const timer=setInterval(()=>{if(!body.isConnected){clearInterval(timer);return;}updateCompletion();},1000);}
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
  function openBreakOptions(item,anchor){
      const body=form('<p>'+esc(item.task.properties.title||'Paused task')+'</p><div class="wq-break-option-actions">'+button('return','Return to Priority',item.task.id)+button('background','Send to background',item.task.id)+button('complete','Complete task',item.task.id)+button('details','Task details',item.task.id)+'</div>');
      const handle=DCC.overlay.open({kind:'modal',title:'Paused task options',body,anchor,returnFocus:()=>document.querySelector('[data-queue-id="'+CSS.escape(item.task.id)+'"] [data-queue-action="break-options"]')||document.querySelector('[data-queue-id="'+CSS.escape(item.task.id)+'"] [data-queue-action="focus"]'),actions:[{label:'Close'}]});
      body.addEventListener('click',event=>{if(event.target.closest('[data-queue-action]'))handle.close('action');});
  }

  function reorder(id,target){
    const item=items().find(i=>i.task.id===id);if(!item)return;
    const peers=items().filter(i=>i.status===item.status&&!!i.needsYou===!!item.needsYou&&(item.status!=='queued'||i.taskPriority===item.taskPriority)).map(i=>i.task.id);
    const peerIndex=peers.indexOf(id),targetId=target==='top'?peers[0]:typeof target==='number'?peers[peerIndex+target]:target;
    if(!targetId||!peers.includes(targetId)||id===targetId)return;
    const activeIds=new Set(items().filter(item=>item.status!=='completed').map(item=>item.task.id));
    const order=state.queue.order.filter(id=>activeIds.has(id)),from=order.indexOf(id),to=order.indexOf(targetId);
    order.splice(from,1);order.splice(to,0,id);return send(envelope('queue-reorder',{order}));
  }
  document.addEventListener('change',event=>{if(event.target.matches('[data-completed-period]')){completedPeriod=event.target.value;render();}});
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-queue-action]');if(!button)return;const action=button.dataset.queueAction,item=items().find(i=>i.task.id===button.dataset.taskId);
    if(action==='add'){addTasks();return;}if(action==='retry'&&pending){send(pending).catch(warn);return;}
    if(action==='snooze-all'){snooze(null);return;}
    if(action==='pomodoro'){window.DCCPomodoro?.open(items().find(i=>i.status==='foreground')?.task);return;}
    if(action==='clear-conflict'){setConflict(null);render();return;}
    if(action==='conflict'){const body=form('<p>'+esc(conflict?.message)+'</p><pre>'+esc(JSON.stringify(conflict?.body,null,2))+'</pre>');DCC.overlay.open({kind:'modal',title:'Attempted change',body,actions:[{label:'Close'}]});return;}
    if(!item)return;
    if(action==='details'){const task=DCC.TaskModel.fromBlock(item.task);if(window.DCCTaskWorkspace?.preview)window.DCCTaskWorkspace.preview(task);else if(typeof window.openAddModal==='function')window.openAddModal(task.id,task.title);else {const body=form('<h3>'+esc(task.title)+'</h3><p>'+esc(task.detail||'No task details yet.')+'</p>');DCC.overlay.open({kind:'modal',title:'Task details',body,actions:[{label:'Close'}]});}return;}
    if(['snooze','remind'].includes(action)){snooze(item);return;}
    if(['focus','background','complete','block'].includes(action)){transition(action==='focus'?'start':action==='complete'?'done':action==='block'?'queue-block':'background-start',item).catch(warn);return;}
    if(action==='break-options'){openBreakOptions(item,button);return;}
    if(action==='priority')return; // Shared hold controller owns click and hold.
    if(action==='note'){const body=form('<label>Where you left off<textarea maxlength="4000">'+esc(item.note||'')+'</textarea></label>');modal('Task context',body,()=>send(envelope('queue-note',{taskId:item.task.id,note:body.querySelector('textarea').value})));return;}
    if(['up','down','complete'].includes(action))return; // Shared row/hold controls own these events.
    const map={return:'queue-return',pause:'pause',remove:'queue-remove',unblock:'queue-unblock',dismiss:'queue-dismiss'};
    if(map[action])send(envelope(map[action],{taskId:item.task.id,...(['snooze','dismiss'].includes(action)?{generation:item.generation}:{})})).catch(warn);
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
      send(envelope(item.status==='foreground'&&!item.onBreak?'pause':'queue-return',{taskId:id,...(item.status==='foreground'&&!item.onBreak?{attentionMode:'priority'}:{})})).catch(warn);
    }else if(dest==='wq-needs'){
      send(envelope('pause',{taskId:id,attentionMode:'needs-you'})).catch(warn);
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
  function syncState(){return {pending:!!pending,conflict:conflict?{message:conflict.message||''}:null};}
  window.DCCWorkingQueue={syncState,addTask,render,refresh,tick,activate,send,taskAnchor,taskPool,refreshTaskContext,rememberTaskContext,openBlocked,isBlocked,getState:()=>state};
  // Keep the former rotation navigation entry point. Floating workspace focus()
  // must be migrated to the shared coordinator when that separate feature lands.
  notifySync();
  window.DCCWorkRotation={render,refresh,tick,open:(_from,to)=>{activate();if(to){const row=items().find(i=>i.task.id===(to._blockId||to.id));if(row)transition('start',row);}else addTasks();}};
})();
