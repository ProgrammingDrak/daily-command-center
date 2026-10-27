// Manual task switching. Reminders are durable; the pet is only presentation.
(function () {
 "use strict";
 const DCC=window.DCC, account=window.DCC_ACCOUNT_CONTEXT;
 if(!DCC || !account?.userId || !account.workspaceId) return;
 const key="dcc-work-rotation:"+account.workspaceId+":"+account.userId;
 let state={revision:0,background:[]},pending=null,inFlight=false,refreshing=null,dialog=null,ticking=false;
 const esc=DCC.esc, sessions=()=>window.DCCWorkSessions;
 try {state=JSON.parse(localStorage.getItem(key)||"null")||state;pending=JSON.parse(localStorage.getItem(key+":pending")||"null");} catch(_e) {}
 function save(value) {if(value.revision<state.revision)return;localStorage.setItem(key,JSON.stringify(value));state=value;}
 function showError(error) {DCC.toast(error.message||"Work update failed","error");}
 function rowFor(task) {return sessions()?.blockFor(task);}
 function apply(result) {
  save(result);
  if(result.blocks?.length && window.blockStore?.acceptWorkRotation) window.blockStore.acceptWorkRotation(result.blocks);
  sessions()?.refresh();render();
 }
 async function refresh() {
  if(refreshing)return refreshing;
  refreshing=DCC.api("/api/work-rotation",{cache:"no-store",signal:AbortSignal.timeout(15000)}).then(result=>{save(result);render();return result;}).finally(()=>{refreshing=null;});
  return refreshing;
 }
 async function sendUnlocked(body) {
  pending=JSON.parse(localStorage.getItem(key+":pending")||"null");
  if(inFlight)throw new Error("A work update is still being saved.");
  if(window.blockStore?.hasPendingWrites?.()) {window.blockStore.flushPending();throw new Error("Wait for your task edits to sync before switching.");}
  if(pending && pending.operationId!==body.operationId)throw new Error("Resolve the pending switch first.");
  // Preserve the exact operation before networking. An ambiguous response is
  // retried with the same identifier, including after a reload.
  localStorage.setItem(key+":pending",JSON.stringify(body));pending=body;inFlight=true;render();
  try {
   const result=await DCC.api("/api/work-rotation",{method:"POST",body,signal:AbortSignal.timeout(15000)});
   localStorage.removeItem(key+":pending");pending=null;apply(result);return result;
  }catch(error){
   if([400,403,404,409].includes(error.status)){localStorage.removeItem(key+":pending");pending=null;await refresh().catch(()=>{});}
   throw error;
  }finally{inFlight=false;render();}
 }
 async function send(body) {
  if(navigator.locks?.request)return navigator.locks.request(key+":send",()=>sendUnlocked(body));
  return sendUnlocked(body);
 }
 function command(action,extra) {return {action,operationId:crypto.randomUUID(),expectedRevision:state.revision,...extra};}
 function active() {return sessions()?.activeTasks() || [];}
 function available() {return sessions()?.availableTasks() || [];}
 function titlePath(task,index) {
  const model=DCC.TaskModel,parts=[],seen=new Set();
  let current=task;
  while(current && !seen.has(current.id)){seen.add(current.id);parts.unshift(current.title||"Task");current=index.get(model?.parentIdOf(current));}
  return parts.join(" › ");
 }
 function backgroundTask(item) {return DCC.TaskModel.fromBlock(item.task,{deriveEnd:true});}
 function open(fromTask,toTask) {
  if(pending){showError(new Error("Resolve the pending switch below first."));return;}
  if(!DCC.overlay)return;
  let chosen=toTask || null,guided=null,busy=false,loading=true,request=0;
  const pool=available(),index=new Map(pool.map(t=>[t.id,t]));
  const body=document.createElement("div");body.className="work-switch-form";
  body.innerHTML='<p data-switch-summary></p><label>Next task<select data-switch-target><option value="">Choose a task</option></select></label><label>Pet check-back for the background task<select data-switch-minutes><option value="">No reminder</option><option value="5">In 5 minutes</option><option value="15" selected>In 15 minutes</option><option value="30">In 30 minutes</option><option value="custom">Custom…</option></select></label><label data-switch-custom hidden>Minutes<input type="number" min="1" max="1440" step="1" value="10"></label><details data-switch-guided hidden><summary>Guided instructions</summary><pre></pre></details><p data-switch-error role="status"></p>';
  const target=body.querySelector('[data-switch-target]'),minutes=body.querySelector('[data-switch-minutes]'),custom=body.querySelector('[data-switch-custom]'),error=body.querySelector('[data-switch-error]'),summary=body.querySelector('[data-switch-summary]');
  summary.textContent=fromTask?titlePath(fromTask,index)+" will stay in the background. Its focused-work timer will pause.":"Bring a background task back into focus.";
  if(!fromTask){minutes.closest("label").hidden=true;minutes.value="";}
  const choices=pool.filter(t=>!t.startedAt && t.id!==fromTask?.id);
  if(toTask && !choices.some(t=>t.id===toTask.id))choices.push(toTask);
  choices.forEach(t=>{const opt=document.createElement("option");opt.value=t.id;opt.textContent=titlePath(t,index);target.appendChild(opt);});
  target.value=chosen?.id || "";
  minutes.addEventListener("change",()=>{custom.hidden=minutes.value!=="custom";});
  async function preview() {
   const generation=++request;chosen=choices.find(t=>String(t.id)===target.value)||null;guided=null;
   const details=body.querySelector('[data-switch-guided]');details.hidden=true;error.textContent="";
   const row=rowFor(chosen) || (toTask && state.background.find(i=>i.task.id===toTask._blockId)?.task);
   if(!row?.properties.guidedDefinitionId)return;
   error.textContent="Loading guided instructions…";
   try {
    const view=await DCC.api("/api/guided/tasks/"+encodeURIComponent(row.id),{cache:"no-store"});
    if(generation!==request)return;
    guided=view;details.hidden=false;details.open=true;details.querySelector("pre").textContent=view.prompt;error.textContent="Review these instructions before switching.";
   }catch(e){if(generation===request)error.textContent=e.message;}
  }
  target.addEventListener("change",preview);
  const handle=DCC.overlay.open({kind:"modal",title:"Switch tasks",body,canClose:()=>!busy,actions:[
   {label:"Cancel",onClick:()=>{request++;}},
   {label:"Switch tasks",kind:"primary",onClick:async()=>{
    if(busy || loading)return false;
    const to=rowFor(chosen) || state.background.find(i=>i.task.id===chosen?._blockId)?.task,from=rowFor(fromTask);
    const remind=minutes.value==="custom"?Number(custom.querySelector("input").value):minutes.value?Number(minutes.value):null;
    if(!to){error.textContent="Choose a task.";return false;}
    if(remind!==null && (!Number.isInteger(remind)||remind<1||remind>1440)){error.textContent="Choose 1–1440 minutes.";return false;}
    if(to.properties.guidedDefinitionId && !guided){error.textContent="Wait for the guided instructions to load.";return false;}
    busy=true;error.textContent="Saving switch…";
    try {
     await send(command("switch",{fromId:from?.id||null,fromStartedAt:from?.properties.startedAt||null,toId:to.id,toWorkStateChangedAt:to.properties.workStateChangedAt||null,remindMinutes:remind,
      ...(guided?{guided:{revision:guided.revision,definitionRevision:guided.definitionRevision,contextVersion:guided.contextVersion}}:{})}));
     return true;
    }catch(e){error.textContent=e.message+(pending?" Use Retry in Background work to check the outcome.":"");return false;}
    finally{busy=false;}
   }}]});
  dialog=handle;
  preview();
  // A successful refresh is required before submitting; no stale offline switch.
  refresh().then(()=>{loading=false;}).catch(e=>{error.textContent="Connect to DCC before switching. "+e.message;});
 }
 function returnTo(item) {
  const running=active();
  if(running.length>1){showError(new Error("Pause other running timers before switching tasks."));return;}
  open(running[0]||null,backgroundTask(item));
 }
 function render() {
  let dock=document.getElementById("background-work-dock");
  if(!dock){const anchor=document.getElementById("active-work-dock");if(!anchor)return;dock=document.createElement("div");dock.id="background-work-dock";dock.className="active-work-dock background-work-dock";anchor.after(dock);}
  dock.hidden=!state.background.length&&!pending;
  const now=Date.now(),index=new Map(available().map(t=>[t.id,t]));
  dock.innerHTML='<div class="active-work-head"><span>Background work</span><small>Waiting time is not focused effort</small></div>'+
   (pending?'<p class="work-switch-pending" role="status">'+(inFlight?'Saving switch…':'Work update pending — check its outcome before switching again.')+' <button type="button" data-rotation-retry '+(inFlight?'disabled':'')+'>Retry</button></p>':'')+
   state.background.map(item=>{
    const due=item.dueAt&&Date.parse(item.dueAt)<=now;
    const wait=Math.max(0,Math.floor((now-Date.parse(item.backgroundSince))/60000));
    const timing=due?'Check back now':item.dueAt?'Check back in '+Math.max(1,Math.ceil((Date.parse(item.dueAt)-now)/60000))+'m':'No reminder';
    return '<div class="active-work-row'+(due?' work-checkback-due':'')+'" data-background-id="'+esc(item.task.id)+'"><span class="active-work-title">'+esc(titlePath(backgroundTask(item),index))+'</span><span class="active-work-time">'+wait+'m in background · '+timing+'</span><button type="button" class="work-action-btn" data-background-action="return">Return</button><button type="button" class="work-detail-btn" data-background-action="snooze">'+(item.dueAt?'Snooze 5m':'Remind in 5m')+'</button><button type="button" class="work-detail-btn" data-background-action="dismiss">Dismiss</button></div>';
   }).join("");
 }
 async function tick() {
  if(document.hidden || inFlight || ticking)return;
  ticking=true;
  try {
   await refresh();
   if(pending || DCC.busyElsewhere?.())return;
   const due=state.background.find(i=>i.dueAt&&Date.parse(i.dueAt)<=Date.now()&&!i.notifiedAt);
   if(!due)return;
   const result=await DCC.api("/api/work-rotation",{method:"POST",signal:AbortSignal.timeout(15000),body:command("claim",{taskId:due.task.id,generation:due.generation})});
   apply(result);
   if(!result.claimed || !state.background.some(i=>i.task.id===due.task.id && i.generation===due.generation))return;
   const reveal=()=>{const el=document.getElementById("background-work-dock");el?.scrollIntoView({block:"nearest",behavior:DCC.reducedMotion?.()?"auto":"smooth"});};
   const text="Time to check back on "+(due.task.properties.title||"your background task")+".";
   if(DCC.PetNudge?.deliverWorkCheckIn)await DCC.PetNudge.deliverWorkCheckIn(text,{open:reveal});
   else DCC.toast(text,"info",60000,{label:"Open",onClick:reveal});
  }catch(_e){/* Keep the last durable reminder visible while disconnected. */}
  finally{ticking=false;}
 }
 document.addEventListener("click",event=>{
  const switchButton=event.target.closest?.("[data-work-switch]");
  if(switchButton){event.preventDefault();event.stopPropagation();const task=available().find(t=>String(t.id)===switchButton.dataset.workSwitch);if(task)open(task);return;}
  const retry=event.target.closest?.("[data-rotation-retry]");
  if(retry&&pending&&!inFlight){send(pending).then(()=>dialog?.close("saved")).catch(showError);return;}
  const button=event.target.closest?.("[data-background-action]");if(!button)return;
  const item=state.background.find(i=>i.task.id===button.closest('[data-background-id]').dataset.backgroundId);if(!item)return;
  if(button.dataset.backgroundAction==="return"){returnTo(item);return;}
  send(command(button.dataset.backgroundAction,{taskId:item.task.id,generation:item.generation,minutes:5})).catch(showError);
 });
 window.addEventListener("storage",event=>{if(event.key===key+":pending"){try{pending=JSON.parse(event.newValue||"null");}catch(_e){}render();}if(event.key===key){try{const value=JSON.parse(event.newValue);if(value && value.revision>=state.revision){state=value;render();}}catch(_e){}}});
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)tick();});
 window.addEventListener("dcc:work-session-changed",()=>refresh().catch(()=>{}));
 window.addEventListener("dcc:data-ready",()=>tick());
 setInterval(tick,15000);
 window.DCCWorkRotation={open,refresh,tick,render};
})();
