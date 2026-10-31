// Two presentation states over the canonical queue; history contains navigation only.
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('device') !== 'glasses') return;
  const DCC = window.DCC;
  let root, snapshot, command, busy = false, message = '', selected = null;
  let tree = null, treeRequest = null, treeError = '', treeVersion = 0;
  let suppressClickUntil = 0, backing = false;
  let source = [], sourceLoading = false, sourceError = '', sourceRevision = -1, sourceAt = 0;
  const taskId = () => history.state?.glassesTask || null;
  const active = () => !!document.querySelector('#tab-working-queue.active');
  const esc = text => DCC.esc(String(text ?? ''));
  const items = () => snapshot?.state.queue?.items || [];
  const itemFor = id => items().find(item => item.task.id === id);
  const focus = () => {
    if (!active() || root.closest('[inert]') || document.querySelector('.dcc-overlay')) return;
    const target = taskId() ? root.querySelector('[data-glasses-action="toggle"]') :
      root.querySelector('[data-glasses-id="' + CSS.escape(selected || '') + '"]') || root.querySelector('[data-glasses-action="focus"]');
    target?.focus({preventScroll:true});
    target?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  };
  function back() { if (taskId() && !backing) {backing=true;history.back();} }
  function open(id) {
    selected = id;
    history.replaceState({...history.state,glassesSelected:id},'');
    history.pushState({...history.state,glassesTask:id},'');
    treeVersion++;treeRequest=null;tree = null; treeError = ''; message = ''; draw(); focus();
  }
  function loadTree(id,revision) {
    const token = ++treeVersion;
    treeRequest = {id,revision}; treeError = '';
    DCC.api('/api/working-queue/tasks/'+encodeURIComponent(id)+'/tree',{cache:'no-store',signal:AbortSignal.timeout(15000)})
      .then(value => { if(token === treeVersion) tree = {id,revision,rows:value.rows}; })
      .catch(error => { if(token === treeVersion) treeError = 'Subtasks unavailable: '+error.message; })
      .finally(() => { if(token === treeVersion) {treeRequest = null; draw();} });
  }
  async function loadSource() {
    if(sourceLoading)return;
    sourceLoading=true;sourceError='';
    const revision=snapshot.state.revision,found=new Map();
    try {
      let offset=0;
      do {
        const page=await DCC.api('/api/working-queue/tasks?offset='+offset,{cache:'no-store',signal:AbortSignal.timeout(15000)});
        for(const task of page.tasks)if(task.status!=='done'&&task.type!=='recurring-definition')found.set(task.id,task);
        offset=page.nextOffset;
      } while(offset!=null);
      source=[...found.values()];sourceRevision=revision;sourceAt=Date.now();
    } catch(error) {sourceError='Task list unavailable: '+error.message;}
    finally {sourceLoading=false;draw();}
  }
  function sourceHtml(disabled) {
    if(!sourceLoading&&!sourceError&&(sourceRevision!==snapshot.state.revision||Date.now()-sourceAt>15000))loadSource();
    const queued=new Set(items().map(item=>item.task.id));
    return '<h2 class="gq-source-title">All open tasks</h2><div class="gq-row gq-source" aria-label="All open tasks">'+source.filter(task=>itemFor(task.id)?.status!=='completed').map(task=>
      '<button type="button" class="gq-task" data-glasses-action="add" data-glasses-id="'+esc(task.id)+'" aria-disabled="'+(disabled||queued.has(task.id))+'"><span class="gq-eyebrow">'+(queued.has(task.id)?'In queue':'Select to add')+'</span><h2>'+esc(task.title)+'</h2></button>'
    ).join('')+'</div>'+(sourceLoading?'<p class="gq-hint">Loading tasks…</p>':sourceError?'<p role="status">'+esc(sourceError)+'</p><button type="button" data-glasses-action="reload-source">Retry task list</button>':!source.length?'<p class="gq-hint">No open tasks.</p>':'');
  }
  function subtasks(item) {
    const id = item.task.id, revision = snapshot.state.revision;
    if ((!tree || tree.id !== id || tree.revision !== revision) && !treeRequest && !treeError) loadTree(id,revision);
    if (treeError) return '<p role="status">'+esc(treeError)+'</p><button type="button" data-glasses-action="reload-tree">Retry subtasks</button>';
    if (!tree || tree.id !== id || tree.revision !== revision) return '<p>Loading subtasks…</p>';
    // The existing server hierarchy resolves local IDs, canonical IDs and parent_id.
    // Each row is still projected by TaskModel, including completed children.
    const rows = tree.rows.filter(row => row.id !== id).sort((a,b) => a.sort_order-b.sort_order || String(a.id).localeCompare(String(b.id)));
    return rows.length ? '<h2>Subtasks</h2><ul class="gq-subtasks">'+rows.map(row => {
      const task = DCC.TaskModel.fromBlock(row), done = row.properties.status === 'done' || row.properties.done === true;
      return '<li class="'+(done?'gq-done':'')+'" style="--depth:'+Math.min(4,Math.max(0,(row.depth||1)-1))+'"><span aria-label="'+(done?'Completed':'Open')+'">'+(done?'✓':'○')+'</span> '+esc(task.title)+'</li>';
    }).join('')+'</ul>' : '<p class="gq-empty">No subtasks</p>';
  }
  function draw() {
    if (!root || !snapshot) return;
    const hadFocus = root.contains(document.activeElement), oldAction = document.activeElement?.dataset.glassesAction, oldId = document.activeElement?.dataset.glassesId;
    const scrolls=[...root.querySelectorAll('.gq-row')].map(el=>[el.getAttribute('aria-label'),el.scrollLeft]);
    const id = taskId(), item = itemFor(id);
    if (id && item?.status === 'completed') { back(); return; }
    const {pending,sending,problem,conflict,state} = snapshot;
    const disabled = busy || sending || !!pending || !navigator.onLine;
    const sync = sending ? 'Saving…' : pending ? 'Update saved on this device; awaiting confirmation.' : problem ? 'Unavailable: '+problem : !navigator.onLine ? 'Offline · changes paused' : '';
    const recovery = (pending?'<button type="button" data-queue-action="retry">Retry saved update</button>':'')+
      (conflict?'<p class="wq-conflict">'+esc(conflict.message)+' Review current work before trying again. <button type="button" data-queue-action="clear-conflict">Dismiss conflict</button></p>':'');
    const status = '<p class="gq-status" role="status">'+esc(message || sync)+'</p>'+recovery;
    if(id) {
      if(!item) {
        root.innerHTML = '<section class="gq-detail"><h1>Task unavailable</h1><p>Use Back to return to tasks.</p>'+status+'</section>';
        return;
      }
      const task = DCC.TaskModel.fromBlock(item.task), running = item.status === 'foreground';
      const minutes = running ? Math.max(0,Math.floor((Date.now()-Date.parse(item.task.properties.startedAt))/60000)) : 0;
      root.innerHTML = '<section class="gq-detail" aria-label="Focused task"><p class="gq-eyebrow">'+(running?'Foreground':item.status==='paused'?'Paused':'Timer stopped')+'</p><button type="button" class="gq-task" data-glasses-action="toggle" data-glasses-id="'+esc(id)+'" aria-label="'+esc((running?'Pause timer: ':'Start timer: ')+task.title)+'" aria-pressed="'+running+'" aria-disabled="'+disabled+'"><h1>'+esc(task.title)+'</h1><span class="gq-timer">'+esc(running?'Running · '+minutes+'m this session':'Timer stopped')+'</span></button><p class="gq-saved">'+esc(item.actualMinutes==null?'Saved focused time unknown':item.actualMinutes+'m focused saved')+'</p>'+subtasks(item)+'<p class="gq-hint">Select: '+(running?'pause':'start')+' timer · Swipe right: complete<br>Swipe left: dismiss (stops timer) · Back: tasks</p>'+status+'</section>';
    } else {
      const all = items().filter(item=>item.status!=='completed');
      const priority = state.queue?.priorityOrder || state.queue?.order || [];
      const rank = item => item.status==='foreground'?0:item.needsYou?1:item.status==='queued'?2:3;
      all.sort((a,b)=>rank(a)-rank(b) || (rank(a)===2?priority.indexOf(a.task.id)-priority.indexOf(b.task.id):0));
      selected = selected && all.some(item=>item.task.id===selected) ? selected : all[0]?.task.id;
      root.innerHTML = '<section class="gq-list"><h1>Active queue</h1><div class="gq-row" aria-label="Tasks">'+all.map(item => {
        const task = DCC.TaskModel.fromBlock(item.task);
        return '<button type="button" class="gq-task" data-glasses-action="focus" data-glasses-id="'+esc(item.task.id)+'" aria-disabled="'+disabled+'"><span class="gq-eyebrow">'+esc(item.status==='queued'?'Up next':item.status==='foreground'?'Running':item.status)+'</span><h2>'+esc(task.title)+'</h2></button>';
      }).join('')+'</div>'+(!all.length?'<p class="gq-hint">Select tasks below to add them.</p>':'<p class="gq-hint">Swipe to choose · Select to bring forward</p>')+sourceHtml(disabled)+status+'</section>';
    }
    for(const [label,left] of scrolls) {const row=root.querySelector('[aria-label="'+CSS.escape(label)+'"]');if(row)row.scrollLeft=left;}
    // Preserve task focus through polling, writes and cross-client updates.
    if(hadFocus) {
      const restored=root.querySelector('[data-glasses-action="'+CSS.escape(oldAction||'')+'"][data-glasses-id="'+CSS.escape(oldId||'')+'"]');
      if(restored)restored.focus({preventScroll:true});else focus();
    }
  }
  async function act(intent,id) {
    if(intent === 'reload-source') {sourceError='';sourceRevision=-1;draw();return;}
    if(intent==='add'&&itemFor(id))return;
    if(intent === 'reload-tree') {treeError='';tree=null;draw();return;}
    if(busy || snapshot.sending || snapshot.pending) return;
    const view = taskId(), revision = snapshot.state.revision;
    busy = true; message = ''; draw();
    try {
      const result = await command(intent,id,revision);
      if(!result) return; // A guided-task review was cancelled.
      if(intent==='focus' && taskId()===view && active()) open(id);
      if(intent==='add') {selected=id;message='Added to active queue. Select it to bring forward.';}
      if(['complete','dismiss'].includes(intent) && taskId()===id) back();
    } catch(error) {message=error.message || 'Update not confirmed. Review save status.';}
    finally {busy=false;draw();focus();if(document.querySelector('.dcc-overlay'))setTimeout(focus,320);}
  }
  document.addEventListener('click',event => {
    const button = event.target.closest('[data-glasses-action]');
    if(!button || !root?.contains(button)) return;
    event.preventDefault();event.stopImmediatePropagation();
    if(performance.now()<suppressClickUntil) return;
    suppressClickUntil=performance.now()+350;
    act(button.dataset.glassesAction,button.dataset.glassesId);
  },true);
  document.addEventListener('keydown',event => {
    if(!active() || !root?.contains(event.target) || event.target.closest('[inert]') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const button = event.target.closest('[data-glasses-action]');
    if(button && ['Enter',' '].includes(event.key)) {
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat && performance.now()>=suppressClickUntil) {
        suppressClickUntil=performance.now()+350;act(button.dataset.glassesAction,button.dataset.glassesId);
      }
      return;
    }
    if(taskId() && ['ArrowLeft','ArrowRight'].includes(event.key) && button?.dataset.glassesAction==='toggle') {
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat) act(event.key==='ArrowRight'?'complete':'dismiss',taskId());
      return;
    }
    if(taskId() && event.key==='Escape') {event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)back();return;}
    if(!taskId() && ['focus','add'].includes(button?.dataset.glassesAction) && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();event.stopImmediatePropagation();
      const buttons=[...button.closest('.gq-row').querySelectorAll('[data-glasses-action]')],index=buttons.indexOf(button),next=buttons[index+(event.key==='ArrowRight'?1:-1)];
      if(next){selected=next.dataset.glassesId;next.focus({preventScroll:true});next.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});}
    }
  },true);
  // Enter's browser default must not become a second click in the new detail view.
  document.addEventListener('keyup',event=>{
    if(active() && root?.contains(event.target) && event.target.closest('[data-glasses-action]') && ['Enter',' '].includes(event.key)) {event.preventDefault();event.stopImmediatePropagation();}
  },true);
  document.addEventListener('focusin',event=>{const id=event.target.dataset?.glassesId;if(id)selected=id;});
  window.addEventListener('popstate',()=>{backing=false;selected=history.state?.glassesSelected || selected;treeVersion++;treeRequest=null;tree=null;treeError='';message='';draw();focus();});
  window.addEventListener('online',()=>draw());window.addEventListener('offline',()=>draw());
  window.DCCGlassesQueue = {render(element,value,action){root=element;snapshot=value;command=action;draw();}};
})();
