// Shared production components in the small coordinator browser harness.
// The full-app queue-card suite separately verifies real note/details persistence.
const fs=require('node:fs'),path=require('node:path');
module.exports=function queueBrowserComponents(){
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const modal=html.slice(html.indexOf('<div class="done-modal-overlay"'),html.indexOf('<!--',html.indexOf('<div class="done-modal-overlay"')+1));
  return modal+`<script>
window.escHtml=DCC.esc;window.showToast=DCC.toast;window.loadNotes=()=>({});window.loadTaskNotesForAnchor=async()=>undefined;window.saveTaskNotes=async()=>{};window.saveNotes=()=>{};
window.noteBlocksForTask=()=>[];window.renderDmActions=()=>{};window.DCC.TaskSources={editorOptions:()=>({})};
window.createBlockEditor=()=>({destroy(){},focus(){},getBlocks:()=>[],toHtml:()=>'',toMarkdown:()=>'',isEmpty:()=>true});
window.openTaskNotes=task=>{const body=document.createElement('div');body.className='add-modal-body';const holder=document.createElement('div');holder.id='add-modal-overlay';body.textContent=task.title;holder.appendChild(body);window.fixtureDetails=task.id;DCC.overlay.open({kind:'modal',title:'Task details',body:holder,actions:[{label:'Close'}]});};
window.bindQuickCompleteControl=(button,quick,notes)=>DCC.bindHoldAction(button,quick,notes);
</script><script src="/public/js/task-priority.js"></script><script src="/public/js/hold-action.js"></script><script src="/public/js/itinerary-card.js"></script><script src="/public/js/completion-modal.js"></script><script src="/public/js/schedule-popover.js"></script><script>
document.getElementById('done-modal-confirm').onclick=confirmDoneModal;
document.getElementById('done-modal-cancel').onclick=closeDoneModal;
document.getElementById('done-modal-close').onclick=closeDoneModal;
</script>`;
};
