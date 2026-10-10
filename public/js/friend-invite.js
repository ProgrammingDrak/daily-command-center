(async function(){
 'use strict';
 const token=location.pathname.split('/').pop(), message=document.getElementById('invite-message'), actions=document.getElementById('invite-actions');
 try {
  const response=await fetch('/api/public/friend-invites/'+encodeURIComponent(token),{credentials:'same-origin',cache:'no-store'});
  const data=await response.json();if(!response.ok)throw new Error(data.error);
  message.textContent=data.self?'This is your invite link. Share it with someone else.':data.username+' invites you to add them as a friend. This link expires '+new Date(data.expiresAt).toLocaleString()+'.';
  if(data.self)return;
  if(!data.signedIn){
   for(const [label,path] of [['Set up and add friend','/register'],['Already use DCC? Sign in and add','/login']]) {const a=document.createElement('a');a.className='social-btn';a.textContent=label;a.href=path+'?next='+encodeURIComponent(location.pathname);actions.append(a);}
  } else {
   const button=document.createElement('button');button.className='social-btn primary';button.textContent='Add '+data.username+' as a friend';actions.append(button);
   button.onclick=async()=>{button.disabled=true;try{const result=await fetch('/api/public/friend-invites/'+encodeURIComponent(token)+'/accept',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedUserId:data.sessionUserId})});const body=await result.json();if(!result.ok)throw new Error(body.error);message.textContent=body.alreadyFriends?'You are already friends. No permissions were added.':'You and '+body.username+' are now friends. No task or coaching access was granted.';button.remove();}catch(e){message.textContent=e.message;button.disabled=false;}};
  }
 }catch(e){message.textContent=e.message||'Could not load the invitation. Reconnect and reload.';}
})();
