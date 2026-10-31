// Reuse the notes block editor; drafts and saves belong to one account and task.
(function(){
  'use strict';
  if(new URLSearchParams(location.search).get('device')!=='glasses')return;
  const DCC=window.DCC,account=window.DCC_ACCOUNT_CONTEXT;
  if(!account?.userId||!account.workspaceId)return;
  const scope='dcc-glasses-notes:'+account.workspaceId+':'+account.userId+':';
  let tab,storageReady=true;
  try{tab=sessionStorage.getItem(scope+'tab')||crypto.randomUUID();sessionStorage.setItem(scope+'tab',tab);}catch(_e){tab=crypto.randomUUID();storageReady=false;}
  const sessions=new Map();let view=null,generation=0;
  const serialize=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
  const url=id=>'/api/working-queue/tasks/'+encodeURIComponent(id)+'/notes';
  const key=id=>scope+tab+':'+id;
  const sanitize=(html,migration=false)=>window.DOMPurify.sanitize(html||'',{USE_PROFILES:{html:true},FORBID_TAGS:['style','form','button','iframe',...(migration?[]:['input'])],FORBID_ATTR:['style','id','name']});
  function session(id){
    if(sessions.has(id))return sessions.get(id);
    const s={id,note:null,revision:null,dirty:false,saving:false,error:'',conflict:null,timer:null,durable:true,loadVersion:0,recovered:[]};
    try{
      const d=JSON.parse(localStorage.getItem(key(id))||'null');
      if(d?.taskId===id&&typeof d.revision==='string'&&d.note){s.note=d.note;s.revision=d.revision;s.dirty=true;}
      // A closed tab's draft stays discoverable without merging live-tab edits.
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i);if(!k?.startsWith(scope)||k===key(id)||k===scope+'tab')continue;
        const raw=localStorage.getItem(k);let other;try{other=JSON.parse(raw);}catch(_e){continue;}
        if(other?.taskId===id&&typeof other.revision==='string'&&other.note)s.recovered.push({key:k,raw,...other});
      }
    }catch(_e){s.durable=false;}
    sessions.set(id,s);return s;
  }
  function persist(s){
    try{
      if(!storageReady)throw new Error('Session storage unavailable');
      if(s.dirty)localStorage.setItem(key(s.id),serialize({taskId:s.id,revision:s.revision,note:s.note,updatedAt:new Date().toISOString()}));else localStorage.removeItem(key(s.id));
      s.durable=true;
    }catch(_e){s.durable=false;}
  }
  function status(id){
    const rows=id?[sessions.get(id)].filter(Boolean):[...sessions.values()];
    const s=rows.find(x=>x.dirty||x.error);
    if(!s)return rows.some(x=>x.recovered.length)?'A retained notes draft is available. Open notes to recover it.':'';
    const saved=s.durable?'Draft retained on this device.':'Draft kept in this tab only; keep this tab open.';
    return (s.conflict?'Notes changed elsewhere. ':s.error?'Notes not saved. ':s.saving?'Saving notes… ':'Notes waiting to save. ')+saved;
  }
  function update(s){
    if(view?.s===s){
      view.panel.querySelector('[data-notes-status]').textContent=status(s.id)||(s.note?'Notes saved':'Loading notes…');
      const recovery=view.panel.querySelector('[data-notes-recovery]');recovery.replaceChildren();
      const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',fn);recovery.appendChild(b);};
      for(const draft of s.recovered){
        const preview=document.createElement('p');preview.textContent='Retained draft: '+(draft.note.text||'(formatted notes)');recovery.appendChild(preview);
        button('Recover retained draft',()=>{capture();if(s.dirty)return; s.note=draft.note;s.revision=draft.revision;s.dirty=true;s.recoveredSource=draft;s.recovered=[];persist(s);mountEditor(s);load(s);});
      }
      if(s.conflict){
        const p=document.createElement('p');p.textContent='Saved elsewhere: '+(s.conflict.note.text||'Open the saved version to review formatted notes.');recovery.appendChild(p);
        button('Use saved notes',()=>{s.note=s.conflict.note;s.revision=s.conflict.revision;s.dirty=false;s.conflict=null;s.error='';persist(s);mountEditor(s);update(s);});
        button('Replace saved notes with my draft',()=>{s.revision=s.conflict.revision;s.conflict=null;s.error='';persist(s);save(s);});
      }else if(s.error)button('Retry notes save',()=>{s.error='';s.note?save(s):load(s);});
    }
    if(!view)window.DCCWorkingQueue?.render();
  }
  async function save(s){
    clearTimeout(s.timer);
    if(!s.dirty||s.saving||s.conflict||!s.revision)return;
    if(!navigator.onLine){s.error='Offline';update(s);return;}
    const note=structuredClone(s.note),revision=s.revision;s.loadVersion++;s.saving=true;s.error='';update(s);
    try{
      const result=await DCC.api(url(s.id),{method:'PUT',body:{note,expectedRevision:revision},signal:AbortSignal.timeout(15000)});
      s.revision=result.revision;s.dirty=serialize(s.note)!==serialize(note);persist(s);
      if(!s.dirty&&s.recoveredSource){try{if(localStorage.getItem(s.recoveredSource.key)===s.recoveredSource.raw)localStorage.removeItem(s.recoveredSource.key);}catch(_e){}s.recoveredSource=null;}
    }catch(error){
      s.error=error.message||'Save failed';
      if(error.status===409){
        // Fetch for comparison only. Never rebase a user's draft automatically.
        try{s.conflict=await DCC.api(url(s.id),{cache:'no-store',signal:AbortSignal.timeout(15000)});}catch(_e){}
      }
    }finally{s.saving=false;update(s);if(s.dirty&&!s.error&&!s.conflict)s.timer=setTimeout(()=>save(s),300);}
  }
  function blocksFor(note){
    const blocks=note.blocks?.length?note.blocks:window.migrateHtmlToBlocks(sanitize(note.html||DCC.esc(note.text||''),true));
    return blocks.map((b,i)=>({...b,id:'glasses-note-'+i,content:sanitize(b.content)}));
  }
  function noteFrom(editor){const blocks=editor.getBlocks();return {blocks,html:editor.toHtml(),text:editor.toMarkdown()};}
  function capture(){
    if(!view?.editor)return;
    const {s,editor}=view,note=noteFrom(editor),value=serialize(note);
    if(value===view.last)return;
    view.last=value;s.loadVersion++;s.note=note;s.dirty=true;persist(s);update(s);
    clearTimeout(s.timer);s.timer=setTimeout(()=>save(s),500);
  }
  function mountEditor(s){
    if(view?.s!==s)return;
    view.observer?.disconnect();view.editor?.destroy();
    const container=view.panel.querySelector('[data-notes-editor]');
    view.editor=window.createBlockEditor(container,blocksFor(s.note),{imageDisplayUrl:src=>DCC.TaskSources.safeUrl(src),accessibleLabel:'Task notes',placeholder:'Add notes…',stableImagesOnly:true,onAttachmentError:message=>{s.error=message;update(s);}});
    view.last=serialize(noteFrom(view.editor));
    // Include block split/merge, formatting, checkbox and slash-menu changes.
    view.observer=new MutationObserver(capture);view.observer.observe(container,{subtree:true,childList:true,characterData:true});
    view.editor.focusEnd();view.panel.scrollTop=s.scroll||0;
  }
  async function load(s){
    if(s.saving){update(s);return;}
    const token=generation,request=++s.loadVersion;
    try{
      const result=await DCC.api(url(s.id),{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(s.saving||token!==generation||request!==s.loadVersion)return;
      const refreshEditor=!s.dirty&&serialize(s.note)!==serialize(result.note);
      if(s.dirty){
        if(serialize(s.note)===serialize(result.note)){s.dirty=false;s.revision=result.revision;persist(s);}
        else if(s.revision!==result.revision)s.conflict=result;
      }else{s.note=result.note;s.revision=result.revision;}
      s.error='';
      if(token===generation&&view?.s===s&&(!view.editor||refreshEditor))mountEditor(s);
      update(s);if(s.dirty&&!s.conflict)save(s);
    }catch(error){if(token!==generation||request!==s.loadVersion)return;s.error=error.message||'Notes unavailable';if(token===generation&&view?.s===s&&s.note&&!view.editor)mountEditor(s);update(s);}
  }
  function open(id,title){
    close();generation++;const s=session(id),panel=document.createElement('section');
    panel.className='gq-notes';panel.setAttribute('aria-label','Task details and notes');
    panel.innerHTML='<button type="button" data-notes-back>Back to task</button><h1>'+DCC.esc(title)+'</h1><h2>Notes</h2><div data-notes-editor></div><p data-notes-status role="status">Loading notes…</p><div data-notes-recovery></div><p class="gq-hint">Autosaves · Back returns to this task</p>';
    document.body.appendChild(panel);document.getElementById('tab-working-queue').inert=true;
    view={s,panel,editor:null,observer:null,last:null};
    panel.querySelector('[data-notes-back]').addEventListener('click',()=>history.back());
    panel.addEventListener('input',capture);panel.addEventListener('change',capture);
    panel.addEventListener('paste',event=>{
      if(!event.target.closest('[contenteditable]')||!event.clipboardData)return;
      event.preventDefault();event.stopImmediatePropagation();
      const html=event.clipboardData.getData('text/html');
      document.execCommand(html?'insertHTML':'insertText',false,html?sanitize(html):event.clipboardData.getData('text/plain'));capture();
    },true);
    // Do not let task gestures leak through editable text or controls.
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();history.back();}else event.stopPropagation();});
    panel.querySelector('[data-notes-back]').focus();if(s.note)mountEditor(s);load(s);
  }
  function close(){
    if(!view)return;
    capture();const {s,panel,editor,observer}=view;s.loadVersion++;s.scroll=panel.scrollTop;
    observer?.disconnect();editor?.destroy();panel.remove();view=null;generation++;
    document.getElementById('tab-working-queue').inert=false;save(s);
  }
  window.addEventListener('online',()=>{for(const s of sessions.values())save(s);});
  window.addEventListener('beforeunload',event=>{capture();if([...sessions.values()].some(s=>s.dirty&&!s.durable)){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){capture();for(const s of sessions.values())save(s);}});
  window.DCCGlassesNotes={open,close,status,isOpen:()=>!!view};
})();
