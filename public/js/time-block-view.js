// Shared presentation; permissions and persistence belong to the calling view.
(function(root){
  function header(block,options){
    const {document:doc=root.document,collapsed=false,current=false,onToggle,onEdit}=options;
    const el=doc.createElement("div");
    el.className="time-block-divider variant-hairline"+(current?" current":"");
    if(block.id)el.dataset.blockId=block.id;
    const toggle=doc.createElement("button");toggle.type="button";toggle.className="time-block-toggle";
    toggle.dataset.timeBlockToggle=options.key;
    toggle.setAttribute("aria-expanded",String(!collapsed));
    toggle.title=(block.timed&&block.start?root.DCC.TimeBlocks.rangeLabel(block)+" · ":"")+(collapsed?"Expand ":"Collapse ")+block.name;
    const chevron=doc.createElement("span");chevron.className="time-block-chevron";chevron.setAttribute("aria-hidden","true");chevron.textContent=collapsed?"▸":"▾";
    const label=doc.createElement("strong");label.textContent=block.name;
    toggle.append(chevron,label);el.appendChild(toggle);
    let timer=null,start=null,suppress=false;
    const clear=()=>{clearTimeout(timer);timer=null;start=null;};
    toggle.addEventListener("click",()=>{clear();if(suppress){suppress=false;return;}onToggle();});
    if(block.editable&&onEdit){
      const edit=doc.createElement("button");edit.type="button";edit.className="time-block-edit";edit.title="Edit "+block.name;edit.setAttribute("aria-label",edit.title);
      edit.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m16 3 5 5-13 13H3v-5L16 3Z M13 6l5 5"/></svg>';
      edit.addEventListener("click",onEdit);el.appendChild(edit);
      toggle.addEventListener("pointerdown",e=>{if(e.button!==0)return;clear();suppress=false;start={x:e.clientX,y:e.clientY};timer=setTimeout(()=>{clear();if(toggle.isConnected){suppress=true;edit.focus({preventScroll:true});}},550);});
      toggle.addEventListener("pointermove",e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)clear();});
      ["pointerup","pointercancel","pointerleave"].forEach(type=>toggle.addEventListener(type,clear));
      toggle.addEventListener("contextmenu",e=>e.preventDefault());
    }
    return el;
  }
  root.DCC=root.DCC||{};root.DCC.TimeBlockView={header};
})(typeof self!=="undefined"?self:globalThis);
