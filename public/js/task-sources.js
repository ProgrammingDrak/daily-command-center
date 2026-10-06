// Shared browser/server contract. External references are navigation only: never fetched.
// @typedef {{kind: 'slack'|'email'|'image'|'file'|'link', url: string, name: string, mime?: string}} TaskSourceReference
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root){root.DCC=root.DCC||{};root.DCC.TaskSources=api;}
})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const kinds=['slack','email','image','file','link'];
  function safeUrl(raw){
    if(typeof raw!=='string'||raw.length>4096||/[\u0000-\u0020\u007f]/.test(raw))return '';
    try{
      const u=new URL(raw);
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return '';
      const h=u.hostname.toLowerCase();
      // External navigation only; local services and ephemeral download grants are not provenance.
      if(!h.includes('.')||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||h.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(h))return '';
      if((h==='chatgpt.com'||h==='chat.openai.com')&&u.pathname.startsWith('/backend-api/'))return '';
      if(h==='files.oaiusercontent.com'||h.endsWith('.oaiusercontent.com')||h.endsWith('.oaistatic.com'))return '';
      if([...u.searchParams.keys()].some(k=>/^(x-amz-|x-goog-|signature$|sig$|expires$|access_token$|token$)/i.test(k)))return '';
      return u.href;
    }catch(_){return '';}
  }
  function kindFor(url){
    const h=new URL(url).hostname;
    if(h==='slack.com'||h.endsWith('.slack.com'))return 'slack';
    if(h==='mail.google.com'||h==='outlook.office.com'||h==='outlook.live.com')return 'email';
    return 'link';
  }
  function validate(refs){
    if(!Array.isArray(refs)||refs.length>20)throw new Error('Sources must be an array of at most 20 references');
    const seen=new Set();
    return refs.map(ref=>{
      if(!ref||typeof ref!=='object'||!kinds.includes(ref.kind))throw new Error('Invalid source type');
      const url=safeUrl(ref.url);
      if(!url)throw new Error('Use a stable external HTTP or HTTPS link without credentials or temporary download grants');
      if(typeof ref.name!=='string'||!ref.name.trim()||ref.name.length>255||/[\u0000-\u001f\u007f]/.test(ref.name))throw new Error('Source name must contain 1–255 printable characters');
      if(ref.mime!==undefined&&(typeof ref.mime!=='string'||! /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(ref.mime)))throw new Error('Invalid source MIME type');
      if(seen.has(url))throw new Error('This source is already attached');
      seen.add(url);
      return {kind:ref.kind,url,name:ref.name.trim(),...(ref.mime?{mime:ref.mime}: {})};
    });
  }
  function collect(task,legacyUrl){
    const result=[],seen=new Set();
    function add(ref,legacy){
      try{const clean=validate([ref])[0];if(!seen.has(clean.url)){seen.add(clean.url);result.push({...clean,legacy:!!legacy});}}catch(_){
        if(!legacy)result.push({kind:ref&&ref.kind||'link',name:ref&&typeof ref.name==='string'?ref.name.slice(0,255):'Source',unavailable:true,storedUrl:ref&&ref.url});
      }
    }
    if(legacyUrl&&safeUrl(legacyUrl))add({url:legacyUrl,kind:kindFor(safeUrl(legacyUrl)),name:({slack:'Slack',email:'Email'})[kindFor(safeUrl(legacyUrl))]||'Source'},true);
    if(Array.isArray(task&&task.sourceReferences))task.sourceReferences.slice(0,20).forEach(r=>add(r,false));
    return result;
  }
  function render(container,task,legacyUrl,onRemove){
    container.replaceChildren();
    const refs=collect(task,legacyUrl);
    refs.forEach(ref=>{
      const a=document.createElement(ref.unavailable?'span':'a');
      a.className='task-source-pill';
      a.textContent=ref.name+(ref.unavailable?' — unavailable':' ↗');
      if(!ref.unavailable){a.href=ref.url;a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';a.setAttribute('aria-label','Open '+ref.kind+' source: '+ref.name+' (new tab)');a.title=ref.kind+(ref.mime?' · '+ref.mime:'')+' · Opens at the original provider; sign-in may be required';}
      container.appendChild(a);
      if(onRemove&&!ref.legacy){
        const button=document.createElement('button');button.type='button';button.className='task-source-remove';button.textContent='×';button.setAttribute('aria-label','Remove source reference: '+ref.name);
        button.onclick=async function(){button.disabled=true;try{await onRemove(ref);}finally{button.disabled=false;}};
        container.appendChild(button);
      }
    });
    container.hidden=!refs.length;
  }
  function editorOptions(container,task){
    const railId=container.id+'-sources';
    let rail=document.getElementById(railId);
    if(!rail){rail=document.createElement('div');rail.id=railId;rail.className='task-source-rail';rail.setAttribute('aria-label','Task sources');container.before(rail);}
    const dcc=window.DCC||{};
    const url=typeof dcc.taskSourceUrl==='function'?dcc.taskSourceUrl(task):'';
    render(rail,task,url);
    let status=document.getElementById(railId+'-status');
    if(!status){status=document.createElement('p');status.id=railId+'-status';status.setAttribute('role','status');rail.after(status);}
    status.textContent='';
    return {accessibleLabel:'Task notes',stableImagesOnly:true,onAttachmentError:message=>{status.textContent=message;}};
  }
  return {safeUrl,validate,collect,render,kindFor,editorOptions};
});
