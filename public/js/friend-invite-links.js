(function(){
 'use strict';
 const context=window.DCC_ACCOUNT_CONTEXT;
 if(!context?.userId)return;
 const key='dcc-friend-invite:'+context.userId;
 async function load(){
  const el=document.getElementById('friend-invite-links');
  try{
   const links=await DCC.api('/api/friend-invites');
   el.innerHTML='<p>Invite Links establish friendship only. New people set up an account; existing users explicitly add you. Links expire after seven days.</p>'+links.filter(row=>!row.revoked_at&&Date.parse(row.expires_at)>Date.now()).map(row=>'<p>Expires '+DCC.esc(new Date(row.expires_at).toLocaleString())+' <button type="button" class="social-btn" data-friend-invite-revoke="'+DCC.esc(row.id)+'">Revoke link</button></p>').join('');
  }catch(e){el.textContent=e.message;}
 }
 async function create(){
  const el=document.getElementById('friend-invite-links'),button=document.getElementById('friend-invite-create');button.disabled=true;
  try{
   let intent=JSON.parse(sessionStorage.getItem(key)||'null');
   if(!intent){const bytes=crypto.getRandomValues(new Uint8Array(32));intent={actionId:crypto.randomUUID(),token:btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};sessionStorage.setItem(key,JSON.stringify(intent));}
   const result=await DCC.api('/api/friend-invites',{method:'POST',body:intent});await load();
   const field=document.createElement('input');field.readOnly=true;field.value=location.origin+result.path;field.setAttribute('aria-label','Friend Invite Link');el.prepend(field);
   const copy=document.createElement('button');copy.type='button';copy.className='social-btn';copy.textContent='Copy Invite Link';copy.onclick=()=>navigator.clipboard.writeText(field.value).then(()=>{copy.textContent='Copied';}).catch(()=>{field.select();});el.prepend(copy);
  }catch(e){if(e.status===404)sessionStorage.removeItem(key);el.textContent=e.message;}finally{button.disabled=false;}
 }
 document.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.id==='friend-invite-create')return create();
  if(button.id==='social-tab-btn')void load();
  if(button.dataset.friendInviteRevoke){try{await DCC.api('/api/friend-invites/'+encodeURIComponent(button.dataset.friendInviteRevoke)+'/revoke',{method:'POST'});sessionStorage.removeItem(key);await load();}catch(error){document.getElementById('friend-invite-links').textContent=error.message;}}
 });
})();
