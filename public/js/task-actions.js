// Shared action lifecycle. Writers retain their existing durable outboxes and
// business rules; every outbox reports capture/acknowledgement/rejection here.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./task-model'));
  else {
    const DCC=root.DCC=root.DCC||{};
    DCC.TaskActionsFactory=factory(DCC.TaskModel);
    DCC.TaskActions=DCC.TaskActionsFactory.create({
      account:()=>root.DCC_ACCOUNT_CONTEXT,
      pool:()=>[
        ...(typeof scheduled!=='undefined'?scheduled:[]),
        ...(typeof backlog!=='undefined'?backlog:[]),
        ...(DCC.Carryover?.rows?.()||[])
      ],
      notify:detail=>root.dispatchEvent(new CustomEvent('dcc:task-action', {detail}))
    });
    DCC.TaskActions.subscribe(()=>DCC.TaskActions.updateDocument(root.document));
  }
})(typeof self!=='undefined'?self:this, function(TM) {
  'use strict';
  const scope=account=>JSON.stringify([account?.userId??null,account?.workspaceId??null]);
  function create({account=()=>null,pool=()=>[],notify=()=>{}}={}) {
    const owner=scope(account()), records=new Map(), listeners=new Set(), operations=new Map(), sources=new Map();
    let sequence=0;
    const active=()=>scope(account())===owner;
    function emit(record) {
      if(!active())return;
      for(const listener of listeners)listener(record);
      notify({token:record?.token,action:record?.action,status:record?.status,targets:record?.targets||[]});
    }
    function capture({token,action,targets,date=null,mutationId=null,source='external'}) {
      if(!active())throw new Error('Task account changed. Reload before continuing.');
      if(!token||!Array.isArray(targets)||!targets.length)return null;
      if(records.has(token))return records.get(token);
      const record={token,action,source,targets:targets.map(t=>typeof t==='string'?{id:t,date}:t),mutationId,
        status:'pending',sequence:++sequence,at:Date.now()};
      records.set(token,record);emit(record);return record;
    }
    function finish(token,status='confirmed') {
      const record=records.get(token);if(!record)return;
      if(status==='rejected'||status==='cancelled')records.delete(token);
      else record.status=status;
      emit({...record,status});
    }
    function stateFor(task) {
      if(!active()||!task)return null;
      const canonical=task._canonicalTaskId||task._blockId||task.__unf?.sourceId||task.taskId||task.id;
      const date=task.__unf?.sourceDate??task._taskDate??task.date??null;
      const ids=new Set([canonical].filter(Boolean).map(String));
      let latest=null;
      for(const record of records.values()) {
        if(!record.targets.some(t=>ids.has(String(t.id))&&(t.date==null||date==null||t.date===date)))continue;
        if(!latest||record.sequence>latest.sequence)latest=record;
      }
      return latest;
    }
    function targetList(id,date,includeChildren=true) {
      const all=[...new Map([...pool(),...[...sources.values()].flatMap(read=>read())].filter(Boolean).map(ev=>[
        ev._blockId||ev.__unf?.sourceId||JSON.stringify([ev.id,ev._taskDate??ev.date??null]),ev
      ])).values()];
      const matches=all.filter(ev=>[ev.id,ev._blockId,ev.__unf?.sourceId].includes(id)&&
        (!date||!(ev.__unf?.sourceDate||ev._taskDate||ev.date)||(ev.__unf?.sourceDate||ev._taskDate||ev.date)===date));
      if(matches.length>1)throw new Error('Task identity is ambiguous');
      const targets=matches.length?(includeChildren?TM.actionTargets(matches[0].id,all,{edge:'subtask'}):matches):[];
      return targets.length?targets.map(ev=>({id:ev._canonicalTaskId||ev._blockId||ev.__unf?.sourceId||ev.id,
        date:ev.__unf?.sourceDate??ev._taskDate??ev.date??date??null})): [{id,date}];
    }
    // Called only AFTER a writer's durable receipt was committed. No second outbox.
    function captureWrite(entry,source='blockstore') {
      if(!entry)return;
      const token=entry._walId;
      if(entry.op==='completion')capture({token,source,action:entry.data.completed?'complete':'reopen',
        targets:entry.meta?.taskTargets||targetList(entry.id,entry.data.taskDate,entry.data.completed),mutationId:entry.data.mutationId});
      else if(entry.op==='delete'||entry.op==='undelete')capture({token,source,action:entry.op==='delete'?'delete':'restore',targets:[{id:entry.id}]});
      else if(entry.op==='batch') {
        const ops=entry.data?.operations||[];
        if(ops.length&&ops.every(op=>op.op==='delete'||op.op==='undelete'))capture({token,source,
          action:ops[0].op==='delete'?'delete':'restore',targets:ops.map(op=>({id:op.id}))});
      }
    }
    function settleMissing(source,activeTokens,rejectedTokens=[]) {
      const activeIds=new Set(activeTokens),rejectedIds=new Set(rejectedTokens);
      for(const record of records.values())if(record.source===source&&record.status==='pending'&&!activeIds.has(record.token)){
        finish(record.token,rejectedIds.has(record.token)?'rejected':'confirmed');
      }
    }
    function run({task,action,write}) {
      if(!active())return Promise.reject(new Error('Task account changed. Reload before continuing.'));
      const key=JSON.stringify([task?._blockId||task?.__unf?.sourceId||task?.id,task?.__unf?.sourceDate??task?._taskDate??task?.date,action]);
      if(operations.has(key))return operations.get(key);
      // Reserve before invoking the writer, including synchronous re-entrant renders.
      let resolve,reject;
      const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
      operations.set(key,promise);
      try {Promise.resolve(write()).then(resolve,reject);}catch(error){reject(error);}
      promise.finally(()=>{if(operations.get(key)===promise)operations.delete(key);}).catch(()=>{});
      return promise;
    }
    function bind(el,task,{done=false}={}) {
      const initialDisplay=el.style.display;
      const controls=el.querySelectorAll?[...el.querySelectorAll('button,input')].map(control=>[control,control.disabled]):[];
      const update=()=>{
        const state=stateFor(task);
        const hidden=state&&(state.action==='delete'||(state.action==='complete'&&!done));
        el.style.display=hidden?'none':initialDisplay;
        const completed=state?.action==='complete'?true:state?.action==='reopen'?false:done;
        el.classList?.toggle('done',!!completed);
        el.querySelector?.('.it-list-check')?.classList.toggle('on',!!completed);
        for(const [control,disabled]of controls)control.disabled=state?.status==='pending'||disabled;
        if(state?.status==='pending')el.setAttribute('aria-busy','true');
        else el.removeAttribute('aria-busy');
      };
      update();
      // One document-level listener updates rows; detached rows never accumulate
      // permanent subscriptions when a list is rebuilt.
      el.__dccTaskActionUpdate=update;
      return el;
    }
    function updateDocument(document) {
      document.querySelectorAll('[data-task-action-row]').forEach(el=>el.__dccTaskActionUpdate?.());
    }
    function projectPool(items) {
      items=Array.isArray(items)?items:[];
      return items.filter(task=>stateFor(task)?.action!=='delete').map(task=>{
        const state=stateFor(task);
        return state?.action==='complete'?{...task,_contextOnly:true,__unf:{...task.__unf,done:true}}:task;
      });
    }
    function readToken(){return [...records.values()].filter(record=>record.status==='confirmed').map(record=>record.token);}
    function reconcile(rows,readTokens=[]) {
      // Only authoritative reads may release an acknowledged projection. Pending
      // intents always outrank snapshots, including another tab's stale refresh.
      for(const [token,record] of records) {
        if(record.status!=='confirmed'||!readTokens.includes(token))continue;
        const matching=record.targets.every(t=>rows.some(row=>row.id===t.id));
        if(matching){records.delete(token);emit({...record,status:'reconciled'});}
      }
    }
    return {capture,captureWrite,finish,settleMissing,stateFor,targetList,run,bind,updateDocument,reconcile,readToken,projectPool,
      registerPool(name,read){sources.set(name,read);return()=>sources.delete(name);},
      subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
      restore(entries){for(const entry of entries)captureWrite(entry);},
      pending:()=>active()?[...records.values()].filter(r=>r.status==='pending'):[]};
  }
  return {create};
});
