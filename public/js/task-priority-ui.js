// Small, explicit priority controls. Only the properties bag changes; never run reflow.
(function(){
  'use strict';
  const model=window.DCC.TaskPriority;
  const busy=new Set();
  const esc=value=>window.DCC.esc(String(value==null?'':value));
  function resolve(id,task,rowId){
    rowId=rowId||(task&&task._blockId);
    const anchor=(!task||!rowId)&&typeof taskAnchorById==='function'?taskAnchorById(id):null;
    task=task||(anchor&&anchor.ev);
    rowId=rowId||(anchor&&anchor.blockId)||(task&&task._blockId);
    if(!rowId&&window.blockStore){
      const rows=['block','added_task','schedule_item'].flatMap(type=>window.blockStore.getByType(type)||[]);
      const row=rows.find(b=>b.id===id||(b.properties||{}).local_id===id);
      if(row){rowId=row.id;task=task||window.DCC.TaskModel.fromBlock(row);}
    }
    return {id,task,rowId};
  }
  function writable(ref){return !!(ref.rowId&&window.blockStore&&typeof enqueueRowPropsWrite==='function'&&!(typeof viewMode!=='undefined'&&viewMode==='archive'));}
  function label(value){return value==='Medium'?'⚑':value==='Low'?'↓ Low':'↑ High';}
  function sync(id,value){
    const pools=[typeof scheduled!=='undefined'?scheduled:[],typeof backlog!=='undefined'?backlog:[]];
    pools.forEach(pool=>pool.filter(t=>t.id===id).forEach(t=>{t.taskPriority=value;}));
    document.querySelectorAll('[data-priority-id]').forEach(el=>{
      if(el.dataset.priorityId!==String(id))return;
      el.textContent=label(value);el.dataset.priority=value;
      el.setAttribute('aria-label','Priority: '+value+'. Change priority');
      el.title='Priority: '+value;el.disabled=busy.has(id);
    });
    document.querySelectorAll('[data-priority-select]').forEach(el=>{
      if(el.dataset.prioritySelect!==String(id))return;
      el.value=value;el.disabled=busy.has(id);
    });
  }
  async function save(ref,value,status){
    if(busy.has(ref.id)||!writable(ref))return false;
    const before=model.read(ref.task),next=model.normalize(value);
    busy.add(ref.id);if(ref.task)ref.task.taskPriority=next;sync(ref.id,next);
    if(status)status.textContent='Saving…';
    try{
      let result=await enqueueRowPropsWrite(ref.rowId,props=>({...props,taskPriority:next}),
        block=>({_reportSaveStatus:true,_priorityEdit:{before:block.properties.taskPriority==null?null:block.properties.taskPriority,after:next}}),{rejectOnError:true});
      // A previously queued completion can consume the first full-row request.
      // Only claim success once the returned row contains this attribute too.
      if(result&&!result._savePending&&model.read(result.properties)!==next){
        result=await enqueueRowPropsWrite(ref.rowId,props=>({...props,taskPriority:next}),
          block=>({_reportSaveStatus:true,_priorityEdit:{before:block.properties.taskPriority??null,after:next}}),{rejectOnError:true});
      }
      if(!result||(!result._savePending&&model.read(result.properties)!==next))throw new Error('Priority was not acknowledged');
      if(status)status.textContent=result._savePending?'Queued — will retry when connected':'Saved';
      if(result._savePending&&typeof showToast==='function')showToast('Priority queued — waiting to sync','info');
      return true;
    }catch(error){
      const current=window.blockStore.get(ref.rowId);
      const restored=current?model.read(current.properties):before;
      if(ref.task)ref.task.taskPriority=restored;sync(ref.id,restored);
      if(status)status.textContent='Not saved. Previous priority restored.';
      if(typeof showToast==='function')showToast('Priority was not saved. Try again.','error');
      return false;
    }finally{busy.delete(ref.id);sync(ref.id,model.read(ref.task));refreshList();}
  }
  function refreshList(){if(typeof schedView!=='undefined'&&schedView==='list'&&typeof buildListView==='function')buildListView();}
  function selector(ref){
    const select=document.createElement('select');select.dataset.prioritySelect=ref.id;
    select.setAttribute('aria-label','Task priority');
    ['Low','Medium','High'].forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;select.appendChild(option);});
    select.value=model.read(ref.task);select.disabled=!writable(ref)||busy.has(ref.id);
    return select;
  }
  function mountDetails(id,task,rowId){
    const host=document.getElementById('am-priority');if(!host)return;
    host.replaceChildren();const ref=resolve(id,task,rowId);
    host.hidden=!writable(ref);if(host.hidden)return;
    const label=document.createElement('label');label.textContent='Priority';
    const select=selector(ref);label.appendChild(select);host.appendChild(label);
    const status=document.createElement('span');status.setAttribute('role','status');status.className='priority-save-status';host.appendChild(status);
    select.addEventListener('change',()=>save(ref,select.value,status));
  }
  function cardHtml(task){
    const ref=resolve(task.id,task);if(!writable(ref))return '';
    const value=model.read(task);
    return '<button type="button" class="task-priority-action" data-priority-id="'+esc(task.id)+'" data-priority="'+value+'" aria-label="Priority: '+value+'. Change priority" aria-haspopup="dialog" title="Priority: '+value+'">'+label(value)+'</button>';
  }
  document.addEventListener('click',event=>{
    const opener=event.target.closest('[data-priority-id]');if(!opener)return;
    event.stopPropagation();const ref=resolve(opener.dataset.priorityId);if(!writable(ref))return;
    document.getElementById('task-priority-popover')?.remove();
    const pop=document.createElement('div');pop.id='task-priority-popover';pop.className='task-priority-popover';
    pop.setAttribute('popover','auto');pop.setAttribute('role','dialog');pop.setAttribute('aria-label','Change task priority');
    const label=document.createElement('label');label.textContent='Priority';const select=selector(ref);label.appendChild(select);pop.appendChild(label);
    const hint=document.createElement('small');hint.textContent='Groups the List. Keeps schedule and manual order.';pop.appendChild(hint);
    const status=document.createElement('span');status.setAttribute('role','status');pop.appendChild(status);
    const close=document.createElement('button');close.type='button';close.textContent='Done';close.addEventListener('click',()=>pop.hidePopover());pop.appendChild(close);
    document.body.appendChild(pop);const rect=opener.getBoundingClientRect();
    pop.style.left=Math.max(8,Math.min(rect.left,innerWidth-248))+'px';pop.style.top=Math.max(8,Math.min(rect.bottom+6,innerHeight-180))+'px';
    opener.setAttribute('aria-expanded','true');
    pop.addEventListener('toggle',event=>{if(event.newState==='closed'){opener.setAttribute('aria-expanded','false');const target=opener.isConnected?opener:Array.from(document.querySelectorAll('[data-priority-id]')).find(el=>el.dataset.priorityId===String(ref.id)&&el.getClientRects().length);if(target)target.focus();}});
    select.addEventListener('change',()=>save(ref,select.value,status));pop.showPopover();select.focus();
  });
  window.addEventListener('task-priority-rejected',event=>{
    const rowId=event.detail.id;
    const pools=[typeof scheduled!=='undefined'?scheduled:[],typeof backlog!=='undefined'?backlog:[]];
    pools.flat().filter(t=>t._blockId===rowId).forEach(task=>sync(task.id,model.normalize(event.detail.value)));
    refreshList();
  });
  window.DCCPriorityUI={cardHtml,mountDetails,save,resolve};
})();
