// ======== RADIAL MENU (generic engine) ========
// Extracted from the add-bar destination radial (schedule.js) so any anchor —
// the "+ Add" button, the launcher FAB, a task row's actions trigger — can fan
// out a pick-one radial. The `.dest-radial-*` CSS classes are the generic
// radial classes; they predate the extraction and every consumer shares them.
//
// openRadialMenu(anchorEl, items, opts)
//   items: [{icon, label, onPick(item, anchorEl)}] — availability is the
//   caller's job: build the array fresh at open time so dynamic state (e.g. a
//   task's locked flag) is read when the fan opens.
//   opts: {
//     a0, a1,        arc in degrees (y grows down). Default: fan upward
//                    200→340 when there's room above, else downward 20→160.
//     r,             item-circle radius (default 104)
//     labelGap,      labels sit at r + labelGap along the spoke (default 46)
//     labelStagger,  alternate label radius +22px — use when n > 6 so
//                    neighboring pills don't collide near the arc's apexes
//     clampY,        clamp the fan's virtual center vertically so a trigger
//                    near the screen edge still shows the whole fan
//     onClose
//   }

let _radialTrigger=null;
let _radialOnClose=null;
let _radialEscHandler=null;

function closeRadialMenu(){
  document.querySelectorAll(".dest-radial-backdrop,.dest-radial-item,.dest-radial-label").forEach(el=>el.remove());
  if(_radialTrigger){_radialTrigger.classList.remove("open");_radialTrigger=null;}
  if(_radialEscHandler){document.removeEventListener("keydown",_radialEscHandler);_radialEscHandler=null;}
  if(_radialOnClose){const cb=_radialOnClose;_radialOnClose=null;try{cb()}catch(e){}}
}

function openRadialMenu(anchorEl,items,opts){
  opts=opts||{};
  closeRadialMenu();
  hideRadialMenuPreview();
  _radialTrigger=anchorEl;
  _radialOnClose=typeof opts.onClose==="function"?opts.onClose:null;
  anchorEl.classList.add("open");
  const backdrop=document.createElement("div");
  backdrop.className="dest-radial-backdrop";
  backdrop.addEventListener("click",closeRadialMenu);
  document.body.appendChild(backdrop);
  const rect=anchorEl.getBoundingClientRect();
  const cx=rect.left+rect.width/2;
  let cy=rect.top+rect.height/2;
  const R=opts.r||104,labelGap=opts.labelGap==null?46:opts.labelGap,n=items.length;
  if(opts.clampY)cy=Math.max(R+56,Math.min(cy,window.innerHeight-R-56));
  // Fan upward unless the trigger sits too close to the top of the viewport.
  // Callers can override the arc (e.g. the corner FAB fans up-left).
  const up=cy>R+80;
  const a0=opts.a0!=null?opts.a0:(up?200:20),a1=opts.a1!=null?opts.a1:(up?340:160); // degrees, y grows down
  items.forEach((d,i)=>{
    const ang=(a0+(a1-a0)*(n===1?0.5:i/(n-1)))*Math.PI/180;
    let x=cx+R*Math.cos(ang);let y=cy+R*Math.sin(ang);
    x=Math.max(30,Math.min(x,window.innerWidth-30));
    y=Math.max(30,Math.min(y,window.innerHeight-30));
    const item=document.createElement("button");
    item.type="button";item.className="dest-radial-item";
    if(d.title)item.title=d.title;
    item.innerHTML='<span class="dri-icon">'+d.icon+'</span>';
    item.style.left=(cx-22)+"px";item.style.top=(cy-22)+"px";
    // Label rides just past its item along the same spoke, so labels fan with
    // the items instead of colliding at the arc's apex.
    const lr=R+labelGap+((opts.labelStagger&&i%2)?22:0);
    const lx=Math.max(64,Math.min(cx+lr*Math.cos(ang),window.innerWidth-64));
    const ly=Math.max(14,Math.min(cy+lr*Math.sin(ang),window.innerHeight-14));
    const lbl=document.createElement("span");
    lbl.className="dest-radial-label";lbl.textContent=d.label;
    lbl.style.left=lx+"px";lbl.style.top=ly+"px";
    document.body.appendChild(item);document.body.appendChild(lbl);
    requestAnimationFrame(()=>{
      item.style.transitionDelay=(i*28)+"ms";
      lbl.style.transitionDelay=(60+i*28)+"ms";
      item.classList.add("out");lbl.classList.add("out");
      item.style.left=(x-22)+"px";item.style.top=(y-22)+"px";
    });
    item.addEventListener("click",e=>{
      e.stopPropagation();
      closeRadialMenu();
      if(typeof d.onPick==="function")d.onPick(d,anchorEl);
    });
  });
  _radialEscHandler=function(e){if(e.key==="Escape")closeRadialMenu()};
  document.addEventListener("keydown",_radialEscHandler);
}

// The mini preview: same fan geometry at ~60% scale. Dots are live — entering
// one expands the preview into the real radial via opts.onExpand.
function showRadialMenuPreview(anchorEl,items,opts){
  opts=opts||{};
  hideRadialMenuPreview();
  const rect=anchorEl.getBoundingClientRect();
  const cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
  const R=58,n=items.length;
  const up=cy>R+60;
  const a0=up?200:20,a1=up?340:160;
  items.forEach((d,i)=>{
    const ang=(a0+(a1-a0)*(n===1?0.5:i/(n-1)))*Math.PI/180;
    const x=Math.max(20,Math.min(cx+R*Math.cos(ang),window.innerWidth-20));
    const y=cy+R*Math.sin(ang);
    const dot=document.createElement("span");
    dot.className="dest-radial-item dest-radial-mini";
    dot.innerHTML='<span class="dri-icon">'+d.icon+'</span>';
    dot.style.left=(x-14)+"px";dot.style.top=(y-14)+"px";
    if(typeof opts.onExpand==="function"){
      dot.addEventListener("mouseenter",()=>{hideRadialMenuPreview();opts.onExpand()});
    }
    if(typeof opts.onDotLeave==="function")dot.addEventListener("mouseleave",opts.onDotLeave);
    document.body.appendChild(dot);
    requestAnimationFrame(()=>{dot.style.transitionDelay=(i*20)+"ms";dot.classList.add("out")});
  });
}
function hideRadialMenuPreview(){
  document.querySelectorAll(".dest-radial-mini").forEach(el=>el.remove());
}

window.openRadialMenu=openRadialMenu;
window.closeRadialMenu=closeRadialMenu;
window.showRadialMenuPreview=showRadialMenuPreview;
window.hideRadialMenuPreview=hideRadialMenuPreview;
