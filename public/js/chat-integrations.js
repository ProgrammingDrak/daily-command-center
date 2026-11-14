// A single, account-scoped Connections surface inside DCC's shared overlay.
(function () {
  'use strict';
  const DCC = window.DCC = window.DCC || {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    chatgpt:'<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h5"/>',
    slack:'<path d="M8 3v18M16 3v18M3 8h18M3 16h18"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h3"/>',
    triage:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>'
  };
  const icon = key => '<span class="connection-icon connection-icon--'+key+'"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+paths[key]+'</svg></span>';
  const badge = (label,ok=false) => '<span class="connection-badge'+(ok?' is-connected':'')+'">'+esc(label)+'</span>';
  const button = (action,label,primary=false) => '<button type="button" class="connection-button'+(primary?' is-primary':'')+'" data-action="'+action+'">'+esc(label)+'</button>';
  function choices(categories,scopes) {
    return categories.map(c=>{
      const value=scopes.includes(c.write)?'write':scopes.includes(c.read)?'read':'off';
      return '<div class="connection-permission"><div id="connection-label-'+c.id+'"><strong>'+esc(c.label)+'</strong><small>'+esc(c.description)+'</small></div><div class="connection-levels" role="radiogroup" aria-labelledby="connection-label-'+c.id+'">'+[['off','Off'],['read','Read only'],['write','Full control']].map(([level,label])=>'<label><input type="radio" name="'+c.id+'" value="'+level+'"'+(value===level?' checked':'')+'><span>'+label+'</span></label>').join('')+'</div></div>';
    }).join('');
  }
  async function request(url,options={}) {
    const response=await fetch(url,{...options,headers:{Accept:'application/json',...options.headers},redirect:'error'});
    let data;try{data=await response.json();}catch{throw new Error('Could not load connection settings. Try again.');}
    if(!response.ok)throw new Error(data.error || (response.status===401?'Sign in to DCC to manage connections.':'Could not update this connection.'));
    return data;
  }
  function open(options={}) {
    let handle,closed=false,view='hub',providers=null,chat=null,providerError='',chatError='',selectedId=null,busy=false,message='',generation=0;
    let wizardScopes=null,baselineIds=[];
    const principal=JSON.stringify(window.DCC_ACCOUNT_CONTEXT||null);
    const body=document.createElement('div');body.className='connections';
    const active=()=>chat?.grants.filter(g=>!g.revoked_at)||[];
    const current=()=>active().find(g=>g.id===selectedId)||active()[0];
    const legacy=g=>(g?.scopes||[]).filter(scope=>!chat.categories.some(c=>scope===c.read||scope===c.write));
    const accountCheck=()=>{if(principal!==JSON.stringify(window.DCC_ACCOUNT_CONTEXT||null))throw new Error('Your DCC account changed. Close and reopen Connections.');};
    function frame(title,html) {
      if(closed)return;
      body.innerHTML=html+'<p class="connection-feedback" role="status" aria-live="polite">'+esc(message)+'</p>';
      handle.update({title,body});
    }
    const back=()=>'<button type="button" class="connection-back" data-action="hub">← Connections</button>';
    function row(key,title,description,status,connected=false) {
      return '<button type="button" class="connection-service" data-service="'+key+'">'+icon(key)+'<span class="connection-service-copy"><strong>'+title+'</strong><small>'+description+'</small></span>'+badge(status,connected)+'<span class="connection-chevron" aria-hidden="true">›</span></button>';
    }
    function renderHub() {
      view='hub';
      const linked=active().length>0;
      const slack=providers?.slack,google=providers?.google,triage=providers?.triage;
      frame('Connections','<p class="connection-intro">Your apps, connected to your day.</p><div class="connection-list">'+
        row('chatgpt','ChatGPT','Work with DCC tasks from your chat.',chatError?'Unavailable':!chat?'Loading…':linked?'Connected':chat.enabled&&chat.clientsReady?'Not connected':'Setup needed',linked)+
        row('slack','Slack','Turn message reactions into tasks.',providerError?'Unavailable':!providers?'Loading…':slack?.connected?'Connected':'Not connected',!!slack?.connected)+
        row('calendar','Google Calendar','See your appointments on the itinerary.',providerError||google?.error?'Unavailable':!providers?'Loading…':google?.connected?'Connected':'Not connected',!!google?.connected)+
        '</div><h3 class="connection-section-title">Workflows</h3>'+row('triage','AI triage','Bring email and Slack follow-ups into DCC.',providerError?'Unavailable':!providers?'Loading…':triage?.lastSeenAt?'Receiving updates':'Set up',!!triage?.lastSeenAt)+
        '<p class="connection-footnote">Only connect the apps you use. Each connection stays within your account.</p>');
    }
    function setupDetails(scopes) {
      return '<details class="connection-advanced"><summary>Manual connection details</summary><label>DCC connection URL<input readonly data-server-url value="'+esc(chat.resource)+'"></label>'+button('copy-url','Copy URL')+'<label>Access settings<textarea readonly data-scopes>'+esc(scopes.join(' '))+'</textarea></label>'+button('copy-scopes','Copy access settings')+'<p>Use OAuth in ChatGPT’s custom connector setup. If it asks for a client ID, use the one registered for this DCC server.</p></details>';
    }
    function renderChat() {
      view='chatgpt';
      if(!chat){frame('ChatGPT',back()+'<p class="connection-intro">'+esc(chatError||'Loading connection…')+'</p>'+button('refresh','Try again'));return;}
      const grant=current();selectedId=grant?.id||null;
      const scopes=grant?.scopes||chat.preferences;
      const multiple=active().length>1?'<label class="connection-select-label">Connection<select data-connection>'+active().map((g,i)=>'<option value="'+esc(g.id)+'"'+(g.id===selectedId?' selected':'')+'>Connection '+(i+1)+' · '+esc(new Date(g.created_at).toLocaleDateString())+'</option>').join('')+'</select></label>':'';
      const status=grant?(grant.last_verified_at?'Connected · verified':'Connected · awaiting first use'):'Not connected';
      const legacyOnly=grant&&legacy(grant).length&&!chat.categories.some(c=>scopes.includes(c.read)||scopes.includes(c.write));
      let html=back()+'<div class="connection-hero">'+icon('chatgpt')+'<div><h3>ChatGPT</h3><p>Ask your chat to find, plan and update your tasks.</p></div></div><div class="connection-summary">'+badge(status,!!grant)+(grant?'<span>Last used '+esc(grant.last_verified_at?new Date(grant.last_verified_at).toLocaleString():'not yet')+'</span>':'<span>Choose access, then connect your account.</span>')+'</div>'+multiple;
      if(legacyOnly)html+='<p class="connection-notice">Choose access below, then reconnect to update this connection.</p><details class="connection-advanced"><summary>Current access</summary>'+legacy(grant).map(scope=>'<p>'+esc(chat.legacyDescriptions[scope]||scope)+'</p>').join('')+'</details>';
      const editorScopes=legacyOnly?chat.preferences:scopes;
      html+='<form data-permissions><div class="connection-permissions-head"><div><h3>Permissions</h3><p>Choose what your chat can do in DCC.</p></div><button type="button" class="connection-text-button" data-action="allow-all">Full control for all</button></div>'+choices(chat.categories,editorScopes);
      if(grant&&!legacyOnly&&legacy(grant).length)html+='<details class="connection-advanced"><summary>Earlier permissions on this connection</summary><p>These permissions remain active unless you uncheck them.</p>'+legacy(grant).map(scope=>'<label class="connection-legacy"><input type="checkbox" name="legacy" value="'+esc(scope)+'" checked> '+esc(chat.legacyDescriptions[scope]||scope)+'</label>').join('')+'</details>';
      html+='<p class="connection-footnote">Full control includes editing and recoverable deletion when you ask.</p><div class="connection-actions">'+button(grant&&!legacyOnly?'save':'connect',grant?(legacyOnly?'Update connection':'Save changes'):'Connect ChatGPT',true)+(grant?button('disconnect-confirm','Disconnect'):'')+'</div></form>';
      html+='<details class="connection-advanced"><summary>Connection details</summary><p>Signed in to DCC as '+esc(chat.account)+'.</p>'+(grant?'<p>Client: '+esc(grant.client_id)+'</p>':'')+'<p>Additional access requires authorization in ChatGPT. Reducing access takes effect immediately.</p></details>';
      frame('ChatGPT',html);
    }
    function values() {
      const form=body.querySelector('[data-permissions]');
      const data=new FormData(form),scopes=[];
      for(const c of chat.categories){const level=data.get(c.id)||'off';if(level!=='off')scopes.push(c.read);if(level==='write')scopes.push(c.write);}
      scopes.push(...data.getAll('legacy'));
      return {data:Object.fromEntries(chat.categories.map(c=>[c.id,data.get(c.id)||'off'])),legacy:data.getAll('legacy'),scopes};
    }
    async function post(path,data) {
      accountCheck();
      return request('/connections/conversation/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,csrf:chat.csrf,expectedUserId:chat.accountId,expectedWorkspaceId:chat.workspace})});
    }
    function busyState(on){busy=on;body.querySelectorAll('button,input[type=radio],input[type=checkbox],select').forEach(b=>b.disabled=on);}
    async function act(work) {
      if(busy)return;busyState(true);message='';
      try{await work();}catch(error){message=error.message;const status=body.querySelector('[role="status"]');if(status)status.textContent=message;}
      finally{if(!closed)busyState(false);}
    }
    function renderWizard() {
      view='connect';
      frame('Connect ChatGPT','<button type="button" class="connection-back" data-action="chatgpt">← ChatGPT</button>'+icon('chatgpt')+'<h3 class="connection-wizard-title">Bring DCC into your chat</h3><p class="connection-intro">Your access choices are saved. Finish connecting in ChatGPT, then authorize your DCC account.</p>'+(!chat.enabled||!chat.clientsReady?'<p class="connection-notice">This server is not ready for a new connection yet. Your access choices will be here when setup is complete.</p>':'<ol class="connection-steps"><li><strong>Open ChatGPT’s connector settings</strong><span>Add DCC as a custom connector, or reconnect your existing DCC connector.</span></li><li><strong>Connect your DCC account</strong><span>Use the connection details below, sign in, and review the permissions you chose.</span></li><li><strong>Come back here</strong><span>We’ll check that the connection was authorized.</span></li></ol><div class="connection-actions"><a class="connection-button is-primary" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT ↗</a>'+button('check','Check connection')+'</div>')+setupDetails(wizardScopes));
    }
    async function refresh(target=view) {
      const sequence=++generation;
      const results=await Promise.allSettled([request('/api/me/integrations'),request('/api/me/chat-connections')]);
      if(closed||sequence!==generation)return;
      accountCheck();
      providers=results[0].status==='fulfilled'?results[0].value:null;providerError=results[0].status==='rejected'?results[0].reason.message:'';
      chat=results[1].status==='fulfilled'?results[1].value:null;chatError=results[1].status==='rejected'?results[1].reason.message:'';
      if(target==='chatgpt')renderChat();else if(target==='connect'&&chat)renderWizard();else renderHub();
    }
    body.addEventListener('change',event=>{if(event.target.matches('[data-connection]')){selectedId=event.target.value;renderChat();}});
    body.addEventListener('submit',event=>{if(event.target.matches('[data-permissions]')){event.preventDefault();body.querySelector('[data-action="save"],[data-action="connect"]')?.click();}});
    body.addEventListener('click',event=>{
      const target=event.target.closest('[data-action],[data-service]');if(!target)return;
      const action=target.dataset.action||target.dataset.service;
      if(action==='hub'){message='';renderHub();return;}
      if(action==='chatgpt'){renderChat();return;}
      if(action==='slack'||action==='triage'){
        if(providerError){message=providerError;renderHub();return;}
        const method=action==='slack'?'openSlack':'openTriage';
        window.DCCSetup?.[method]({handle,onBack:()=>{renderHub();act(()=>refresh('hub'));}});view=action;return;
      }
      if(action==='calendar'){
        if(providerError){message=providerError;renderHub();return;}
        view='calendar';const google=providers?.google;
        frame('Google Calendar',back()+'<div class="connection-hero">'+icon('calendar')+'<div><h3>Google Calendar</h3><p>Your appointments on the DCC itinerary.</p></div></div>'+badge(google?.connected?'Connected':'Not connected',!!google?.connected)+(google?.error?'<p class="connection-notice">Calendar status is unavailable. Try again before changing the connection.</p>':google?.connected?'<div class="connection-existing">'+(google.accounts||[]).map(a=>'<p>'+esc(a.email||a.label||'Connected account')+'</p>').join('')+'</div>':'<p class="connection-intro">Connect Google to bring appointments into your itinerary.</p>')+'<a class="connection-button is-primary" href="/api/gcal/auth">'+(google?.connected?'Connect another account':'Connect Google Calendar')+'</a>');return;
      }
      if(action==='allow-all'){body.querySelectorAll('[data-permissions] input[value="write"]').forEach(i=>i.checked=true);return;}
      if(action==='disconnect-confirm'){
        frame('Disconnect ChatGPT',back()+'<h3>Disconnect this connection?</h3><p class="connection-intro">ChatGPT will lose this connection’s access to DCC. Your tasks and recorded time stay in DCC.</p><div class="connection-actions">'+button('disconnect','Disconnect')+button('chatgpt','Keep connection',true)+'</div>');return;
      }
      const submitted=(action==='save'||action==='connect')?values():null;
      act(async()=>{
        if(action==='refresh'){await refresh(view);return;}
        if(action==='copy-url'||action==='copy-scopes'){
          const field=body.querySelector(action==='copy-url'?'[data-server-url]':'[data-scopes]');
          try{await navigator.clipboard.writeText(field.value);message='Copied.';}catch{field.focus();field.select();message='Select and copy the highlighted text.';}
        }
        if(action==='save'||action==='connect'||action==='reconnect'){
          const chosen=action==='reconnect'?{scopes:chat.preferences,data:Object.fromEntries(chat.categories.map(c=>[c.id,chat.preferences.includes(c.write)?'write':chat.preferences.includes(c.read)?'read':'off'])),legacy:[]}:submitted;
          if(!chosen.scopes.length&&action!=='save')throw new Error('Choose at least one permission before connecting.');
          const grant=current();
          if(action==='save'&&grant&&chosen.scopes.every(s=>grant.scopes.includes(s))){await post('permissions',{...chosen.data,legacy:chosen.legacy,grantId:grant.id});message='Permissions updated.';await refresh('chatgpt');}
          else{await post('preferences',{...chosen.data,legacy:[]});wizardScopes=chosen.scopes.filter(s=>chat.categories.some(c=>s===c.read||s===c.write));baselineIds=active().map(g=>g.id);renderWizard();}
        }
        if(action==='check'){
          const updated=await request('/api/me/chat-connections');chat=updated;
          const match=active().find(g=>!baselineIds.includes(g.id)&&wizardScopes.every(s=>g.scopes.includes(s)));
          if(match){selectedId=match.id;message='Connected. Your chat can now use the access you authorized.';renderChat();}
          else message='No new authorization yet. Finish connecting in ChatGPT, then check again.';
        }
        if(action==='disconnect'){await post('revoke',{grantId:selectedId});selectedId=null;message='Disconnected.';await refresh('chatgpt');}
        const status=body.querySelector('.connection-feedback');if(status)status.textContent=message;
      });
    });
    handle=DCC.modal({title:'Connections',anchor:options.anchor,body,onClose:()=>{closed=true;generation++;}});
    handle.el.classList.add('connections-modal');renderHub();
    act(()=>refresh(options.service==='chatgpt'?'chatgpt':'hub'));
    return handle;
  }
  window.DCCConnections={open};
  document.addEventListener('DOMContentLoaded',()=>{
    document.getElementById('dcc-setup-integrations')?.addEventListener('click',event=>{
      document.getElementById('dcc-settings-wrap')?.classList.remove('open');
      document.getElementById('dcc-settings-button')?.setAttribute('aria-expanded','false');
      open({anchor:document.getElementById('dcc-settings-button')||event.currentTarget});
    });
    const url=new URL(location.href);
    if(url.searchParams.get('settings')==='connections')open({service:url.searchParams.get('connection')});
  });
  // Standalone OAuth consent uses the same permission controls, without a hub.
  document.addEventListener('click',event=>{
    if(event.target.closest('[data-select-all]'))document.querySelectorAll('.connections-consent input[value="write"]').forEach(i=>i.checked=true);
  });
})();
