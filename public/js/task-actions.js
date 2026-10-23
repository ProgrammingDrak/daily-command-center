(function(){
 'use strict';
 const D=window.DCC,P=D.TaskActionPolicy;
 const api=(path,options)=>D.api(path,{...options,headers:{'Content-Type':'application/json',...options?.headers},errorLabel:'Task action failed'});
 function path(owner,id){return '/api/task-view/'+encodeURIComponent(owner)+'/tasks/'+encodeURIComponent(id);}
 function statusText(item){return item.status==='pending'?'Suggestion sent. The task has not changed.':item.status==='applied'?'Saved':item.status==='executing'?'Result awaiting verification. Do not send it again.':item.result?.error||item.status;}
 async function open({owner='self',id,action,changed=()=>{}}){
  let data;
  try{data=await api(path(owner,id));}catch(e){D.toast(e.message,'error');return;}
  const task=data.task,p=task.properties||{},body=document.createElement('div');body.className='task-action-form';
  const actions=P.actions.filter(a=>P.mode(data.modes,a)!=='view');
  const context=document.createElement('p');context.className='task-access-context';context.textContent='Access: '+data.role+'. Suggestions require approval before changing this task.';body.append(context);
  if(data.reactions?.length){const summary=document.createElement('p');summary.textContent=data.reactions.map(r=>r.emoji+' '+r.count+(r.mine?' (you)':'')).join(' · ');body.append(summary);}
  const description=document.createElement('p');description.textContent=p.title||'Task';body.append(description);
  if(!actions.length){body.append(Object.assign(document.createElement('p'),{textContent:'View only. The owner has not enabled task actions.'}));D.modal({title:'Task details',body});return;}
  const select=document.createElement('select');select.setAttribute('aria-label','Task action');
  actions.forEach(a=>select.append(new Option((data.modes[a]==='suggest'?'Suggest: ':'')+P.labels[a],a)));select.value=actions.includes(action)?action:actions[0];body.append(select);
  const fields=document.createElement('div'),status=document.createElement('p');status.setAttribute('role','status');body.append(fields,status);
  let key=crypto.randomUUID(),busy=false;
  const field=(name,label,value,type='text')=>{const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.name=name;input.type=type;input.value=value||'';l.append(input);fields.append(l);if(['date','time'].includes(type)&&window.TimePicker){window.TimePicker.enhance(input);l.querySelector('.tw-field')?.setAttribute('aria-label',label);}return input;};
  function render(){fields.replaceChildren();key=crypto.randomUUID();status.textContent='';
   if(select.value==='edit')field('title','Task title',p.title).maxLength=300;
   if(select.value==='schedule'){field('date','Date',task.date||new Date().toISOString().slice(0,10),'date');field('start','Start',p.start||'09:00','time');field('end','End',p.end||'09:30','time');}
   if(select.value==='delegate')field('who','Waiting on','').maxLength=120;
   if(select.value==='reward')field('title','Reward', '').maxLength=180;
   if(select.value==='react'){const l=document.createElement('label');l.textContent='Reaction';const input=document.createElement('select');input.name='emoji';['👍','🙌','🔥','💪','🎉','❤️'].forEach(e=>input.append(new Option(e,e)));l.append(input);fields.append(l);const state=document.createElement('select');state.name='active';state.setAttribute('aria-label','Reaction state');state.append(new Option('Add reaction','true'),new Option('Remove reaction','false'));fields.append(state);}
   if(select.value==='complete'){const input=document.createElement('select');input.name='completed';input.setAttribute('aria-label','Completion');input.append(new Option('Mark complete','true'),new Option('Reopen task','false'));input.value=task.completed?'false':'true';fields.append(input);}
   if(select.value==='bounty')fields.append(Object.assign(document.createElement('p'),{textContent:'Lock today’s 2× points bounty on this task. Existing daily limits apply; the current interface cannot undo this choice.'}));
   submit.textContent=(data.modes[select.value]==='suggest'?'Send suggestion':'Apply '+P.labels[select.value].toLowerCase());
  }
  const submit=document.createElement('button');submit.type='button';submit.className='dcc-overlay-btn dcc-overlay-btn--primary';body.append(submit);
  select.addEventListener('change',render);fields.addEventListener('input',()=>{key=crypto.randomUUID();});render();
  submit.addEventListener('click',async()=>{if(busy)return;busy=true;submit.disabled=true;select.disabled=true;
   const payload=Object.fromEntries([...fields.querySelectorAll('[name]')].map(el=>[el.name,['active','completed'].includes(el.name)?el.value==='true':el.value]));
   status.textContent='Saving…';
   try{const result=await api(path(owner,id)+'/actions',{method:'POST',body:JSON.stringify({action:select.value,payload,requestKey:key,expectedUpdatedAt:task.updatedAt})});status.textContent=statusText(result);if(result.status==='applied')await changed();if(['pending','applied','executing'].includes(result.status)){submit.disabled=true;select.disabled=true;fields.querySelectorAll('input,select').forEach(el=>el.disabled=true);return;}}
   catch(e){status.textContent=e.message;}finally{busy=false;if(!fields.querySelector(':disabled')){submit.disabled=false;select.disabled=false;}}
  });
  D.modal({title:'Task actions',body,actions:[{label:'Close'}]});
 }
 function attach(row,task,options={}){
  const id=task._blockId||task.blockId;if(!id||task.redacted||options.preview)return;
  if(Object.prototype.hasOwnProperty.call(options,'owner')&&!options.owner)return;
  const owner=options.owner||'self';
  if(owner!=='self'&&!P.actions.some(a=>P.mode(options.modes,a)!=='view'))return;
  const button=document.createElement('button');button.type='button';button.className='task-access-actions';button.textContent='⋯';button.setAttribute('aria-label','Actions and incentives: '+task.title);button.title='Actions, reactions and incentives';
  button.addEventListener('click',e=>{e.stopPropagation();open({owner,id,changed:options.changed||(async()=>{if(window.blockStore)await window.blockStore.handleBlocksChanged({blockIds:[id]});if(typeof window.render==='function')window.render();})});});
  (row.querySelector('.it-list-actions')||row).append(button);
 }
 async function permissions(grantee){
  const grants=await api('/api/access/grants');const grant=(Array.isArray(grants)?grants:grants.grants||[]).find(g=>String(g.grantee_user_id)===String(grantee));if(!grant)throw new Error('Grant unavailable');
  const body=document.createElement('div');body.className='task-action-form';const text=document.createElement('p');text.textContent='Choose each action explicitly. Existing roles and points permissions stay unchanged. View means no new action permission.';body.append(text);
  P.actions.forEach(a=>{const label=document.createElement('label');label.textContent=P.labels[a];const select=document.createElement('select');select.name=a;select.setAttribute('aria-label',P.labels[a]+' permission');P.modes.forEach(mode=>select.append(new Option(mode[0].toUpperCase()+mode.slice(1),mode)));select.value=grant.task_permissions?.[a]||'view';label.append(select);body.append(label);});
  const status=document.createElement('p');status.setAttribute('role','status');body.append(status);
  D.modal({title:'Task action permissions',body,actions:[{label:'Cancel'},{label:'Save permissions',kind:'primary',onClick:async()=>{try{await api('/api/access/grants/'+encodeURIComponent(grantee)+'/task-permissions',{method:'PUT',body:JSON.stringify({permissions:Object.fromEntries([...body.querySelectorAll('select')].map(s=>[s.name,s.value]))})});}catch(e){status.textContent=e.message;return false;}}}]});
 }
 async function review(before=null){
  let {items,next}=await api('/api/task-view/self/suggestions'+(before?'?before='+encodeURIComponent(before):''));const body=document.createElement('div');body.className='task-action-review';
  for(const item of items.filter(x=>x.status==='pending'||x.status==='executing')){
   const entry=document.createElement('section'),title=document.createElement('p');title.textContent=P.labels[item.action]+': '+item.snapshot.title;entry.append(title);
   const value=document.createElement('pre');value.textContent=JSON.stringify(item.payload,null,2);entry.append(value);
   const status=document.createElement('p');status.setAttribute('role','status');entry.append(status);
   if(item.status==='executing')status.textContent='Awaiting outcome verification; retry is disabled.';
   else for(const decision of ['approve','reject']){const b=document.createElement('button');b.type='button';b.textContent=decision==='approve'?'Approve':'Reject';b.addEventListener('click',async()=>{entry.querySelectorAll('button').forEach(b=>b.disabled=true);try{const result=await api('/api/task-view/self/suggestions/'+encodeURIComponent(item.id)+'/review',{method:'POST',body:JSON.stringify({decision})});status.textContent=statusText(result);}catch(e){status.textContent=e.message;entry.querySelectorAll('button').forEach(b=>b.disabled=false);}});entry.append(b);}
   body.append(entry);
  }
  if(next){const more=document.createElement('button');more.textContent='Load more suggestions';more.addEventListener('click',()=>review(next));body.append(more);}
  if(!body.children.length)body.textContent='No task action suggestions awaiting review.';D.modal({title:'Suggested task actions',body});
 }
 document.addEventListener('click',e=>{const button=e.target.closest('[data-task-permissions],[data-task-suggestions-review]');if(!button)return;e.stopPropagation();(button.hasAttribute('data-task-permissions')?permissions(button.dataset.taskPermissions):review()).catch(error=>D.toast(error.message,'error'));});
 D.TaskActions={open,attach,permissions,review};
})();
