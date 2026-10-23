// Public suggestion composer uses DCC's overlay controller and shared time picker.
(function(){
  let modal=null,scope=null,draft={},sending=false;
  function key(){return 'dcc-shared-suggestion:'+scope;}
  function save(){try{sessionStorage.setItem(key(),JSON.stringify(draft));}catch(_e){}}
  function updateScope(next){
    if(scope===next)return;
    modal?.close('scope-change');modal=null;scope=next;sending=false;
    try{draft=JSON.parse(sessionStorage.getItem(key())||'{}');}catch(_e){draft={};}
  }
  function open({button,data,api,onSuccess}){
    if(modal)return;
    const requestScope=scope,body=document.createElement('form');body.className='shared-suggestion-form';
    body.innerHTML='<p>Send a suggestion to the owner’s review queue. A suggested time is optional; it does not schedule the task.</p>'+
      '<label>Task name<input id="todo-create-title" class="sub-add-input" name="title" required maxlength="220" placeholder="What needs doing?"></label>'+
      '<div class="shared-suggestion-timing"><label>Duration<select id="todo-create-duration" class="task-add-dur" name="durationMinutes">'+[15,30,45,60,90,120,240].map(n=>'<option value="'+n+'">'+(n<60?n+'m':n/60+'h')+'</option>').join('')+'</select></label>'+
      '<label>Suggested time <small>(optional)</small><input id="todo-create-time" type="time" name="suggestedTime"></label></div>'+
      '<small class="shared-suggestion-zone"></small>'+
      '<details><summary>Your name &amp; note (optional)</summary><label>Your name<input id="todo-create-name" name="visitorName" maxlength="80"></label><label>Note<textarea id="todo-create-note" name="note" maxlength="1000" rows="3"></textarea></label></details>'+
      '<p id="todo-create-status" role="status" aria-live="polite"></p><div class="shared-suggestion-actions"><button type="button" data-cancel>Cancel</button><button id="todo-create-task" class="todo-public-btn primary" type="submit">Send suggestion</button></div>';
    body.querySelector('.shared-suggestion-zone').textContent='Times are in '+(data.timeZone||'the owner’s timezone')+'.';
    const defaults={title:'',durationMinutes:'30',suggestedTime:'',visitorName:data.viewer?.username||'',note:''};
    for(const [name,value] of Object.entries({...defaults,...draft.values}))if(body.elements.namedItem(name))body.elements.namedItem(name).value=value;
    const remember=()=>{draft.values={};body.querySelectorAll('[name]').forEach(el=>draft.values[el.name]=el.value);save();};
    body.addEventListener('input',remember);body.addEventListener('change',remember);
    const handle=window.DCC.overlay.open({kind:'modal',title:'Suggest a Task',anchor:button,body,
      canClose:reason=>!sending||reason==='scope-change',onClose:()=>{if(requestScope===scope)remember();modal=null;}});
    modal=handle;requestAnimationFrame(()=>body.querySelector('[name=title]').focus());
    body.querySelector('[data-cancel]').onclick=()=>handle.close('cancel');
    body.onsubmit=async event=>{
      event.preventDefault();if(sending||!body.reportValidity())return;remember();
      const payload={...draft.values,title:draft.values.title.trim(),date:data.date};
      if(!payload.title)return;
      const encoded=JSON.stringify(payload);
      if(draft.payload!==encoded){draft.payload=encoded;draft.requestKey=crypto.randomUUID();}
      payload.requestKey=draft.requestKey;save();sending=true;
      body.querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=true);
      const status=body.querySelector('[role=status]');status.textContent='Sending…';
      try{
        await api('/api/public/todo-share/'+encodeURIComponent(location.pathname.split('/').filter(Boolean).pop())+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(requestScope!==scope)return;
        sending=false;body.reset();draft={};save();handle.close('success');
        draft={};save();onSuccess();
      }catch(e){if(requestScope!==scope)return;sending=false;body.querySelectorAll('input,select,textarea,button').forEach(el=>el.disabled=false);status.textContent=e.message;}
    };
  }
  window.DCC.SharedTaskSuggestions={open,updateScope};
})();
