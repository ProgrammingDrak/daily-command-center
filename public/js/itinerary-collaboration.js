(function(){
 'use strict';
 let shell, home, anchorRef=null, anchorLocal=null, opened=false;
 function taskRow(){return [...document.querySelectorAll('#list-view [data-id],#timeline [data-id]')].find(el=>el.dataset.id===anchorLocal || el.dataset.id===anchorRef);}
 function place(){
  if(!shell)return;
  const row=opened&&taskRow();
  if(row){if(shell.previousElementSibling!==row)row.after(shell);shell.classList.add('commitment-inline');}
  else {if(shell.parentElement!==home)home.append(shell);shell.classList.remove('commitment-inline');}
 }
 function refreshChips(){
  if(!window.DCCCommitments)return;
  for(const button of document.querySelectorAll('[data-task-collaborate]')){
   const r=DCCCommitments.records.find(r=>r.role==='owner'&&(r.source_block_id===button.dataset.taskCollaborate || r.source_local_id===button.dataset.taskLocal));
   const label=r?(r.highlighted?'★ ':'')+(DCCCommitments.attention(r)?'● ':'')+'Shared':'Collaborate';
   if(button.textContent!==label)button.textContent=label;
   if(r)button.dataset.linkedCommitment=r.id;else delete button.dataset.linkedCommitment;
  }
  place();
 }
 async function open(button){
  anchorRef=button.dataset.taskCollaborate;anchorLocal=button.dataset.taskLocal;opened=true;place();
  const form=document.getElementById('commitment-create-form');
  form.elements.sourceBlockId.value=anchorRef;
  document.getElementById('commitment-source-label').textContent='Linked to your personal itinerary task. Write the shared outcome explicitly; private title, notes and sources are not copied. Task completion follows its existing checkbox.';
  if(button.dataset.linkedCommitment){shell.querySelector('.commitment-create').hidden=true;await DCCCommitments.select(button.dataset.linkedCommitment);}
  else {DCCCommitments.clear();shell.querySelector('.commitment-create').hidden=false;shell.querySelector('.commitment-create').open=true;form.elements.title.focus();}
  const tools=shell.querySelector('.commitment-inline-tools');
  tools.querySelector('[data-inline-bounty]')?.remove();
  if(typeof window.placeBounty==='function'){
   const bounty=document.createElement('button');bounty.type='button';bounty.className='social-btn';bounty.dataset.inlineBounty=anchorLocal;bounty.textContent='Set my 2× points bounty';tools.append(bounty);
   const note=document.createElement('span');note.className='commitment-bounty-note';note.textContent='Private in-app points; existing daily limit and confirmation apply.';tools.querySelector('.commitment-bounty-note')?.remove();tools.append(note);
  }
  shell.scrollIntoView({block:'nearest'});
 }
 function close(){
  const trigger=taskRow()?.querySelector('[data-task-collaborate]');
  opened=false;anchorRef=null;anchorLocal=null;shell.classList.remove('commitment-inline');home.append(shell);
  shell.querySelector('.commitment-create').hidden=false;
  document.getElementById('commitment-create-form').elements.sourceBlockId.value='';
  document.getElementById('commitment-source-label').textContent='Independent outcome. Starts private.';
  DCCCommitments.clear();trigger?.focus();
 }
 document.addEventListener('DOMContentLoaded',()=>{
  shell=document.getElementById('commitment-workspace');home=document.getElementById('commitment-home');
  const list=document.getElementById('list-view');
  if(list)new MutationObserver(refreshChips).observe(list,{childList:true,subtree:true});
  document.addEventListener('click',async e=>{
   const button=e.target.closest('button');if(!button)return;
   if(button.dataset.taskCollaborate){e.stopPropagation();await open(button);}
   if(button.id==='commitment-close')close();
   if(button.dataset.inlineBounty){e.stopPropagation();window.placeBounty(button.dataset.inlineBounty);}
  },true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&opened&&shell.contains(document.activeElement)){e.stopPropagation();close();}});
  window.addEventListener('dcc:commitment-view',refreshChips);
  document.getElementById('itinerary-collaboration').addEventListener('toggle',e=>{if(e.target.open&&opened)close();});
 });
})();
