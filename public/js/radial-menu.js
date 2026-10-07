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
//     r,             minimum item-circle radius (default 104). The fan grows
//                    past this when a tight arc would otherwise overlap icons,
//                    capped at ~0.42x the smaller viewport side (_radialFitRadius).
//     labelGap,      labels sit at r + labelGap along the spoke (default 46)
//     labelStagger,  alternate label radius +22px so neighboring pills don't
//                    collide near the arc's apexes. Auto-enabled when n > 6;
//                    pass true to force it below that.
//     clampY,        clamp the fan's virtual center vertically so a trigger
//                    near the screen edge still shows the whole fan
//     backdrop,       false keeps the fan non-modal so a nearby form remains
//                    interactive. Defaults to true.
//     fullCircle,   distribute items around 360 degrees with captions inside
//                   touch targets and clamp the whole ring 16px from edges.
//                   Scroll or viewport resize dismisses the anchored menu.
//     onClose
//   }

let _radialTrigger=null;
let _radialOnClose=null;
let _radialEscHandler=null;
let _radialViewportHandler=null;

// Grow the circle so neighbouring icons stay legible. n items spread across
// (a1−a0)° sit 2R·sin(Δθ/2) apart, so when that chord drops below an icon's
// width the icons overlap (the corner FAB's 83° arc packs 8 icons into ~21px
// steps). Instead of shrinking spacing, we fan the SAME items out on a bigger
// radius until the chord clears `minChord`. Never below the caller's r; capped
// at a fraction of the viewport so the fan can't spill off-screen (the
// placement clamps would only flatten it back into a pile if it did).
function _radialFitRadius(baseR,n,a0,a1,minChord,maxFrac){
  let R=baseR;
  if(n>1){
    const stepRad=Math.abs(a1-a0)*Math.PI/180/(n-1);
    const needed=minChord/(2*Math.sin(stepRad/2));
    if(needed>R)R=needed;
  }
  const cap=Math.max(baseR,(maxFrac||0.42)*Math.min(window.innerWidth,window.innerHeight));
  return Math.min(R,cap);
}

function closeRadialMenu(){
  document.querySelectorAll(".dest-radial-backdrop,.dest-radial-item,.dest-radial-label,.dest-radial-cancel").forEach(el=>el.remove());
  const trigger=_radialTrigger;
  if(trigger){trigger.classList.remove("open");trigger.setAttribute("aria-expanded","false");_radialTrigger=null;}
  if(trigger&&trigger.isConnected&&typeof trigger.focus==="function")trigger.focus({preventScroll:true});
  if(_radialEscHandler){document.removeEventListener("keydown",_radialEscHandler);_radialEscHandler=null;}
  if(_radialViewportHandler){
    window.removeEventListener("resize",_radialViewportHandler);
    document.removeEventListener("scroll",_radialViewportHandler,true);
    _radialViewportHandler=null;
  }
  if(_radialOnClose){const cb=_radialOnClose;_radialOnClose=null;try{cb()}catch(e){}}
}

function openRadialMenu(anchorEl,items,opts){
  opts=opts||{};
  closeRadialMenu();
  hideRadialMenuPreview();
  _radialTrigger=anchorEl;
  _radialOnClose=typeof opts.onClose==="function"?opts.onClose:null;
  anchorEl.classList.add("open");
  anchorEl.setAttribute("aria-expanded","true");
  if(opts.backdrop!==false){
    const backdrop=document.createElement("div");
    backdrop.className="dest-radial-backdrop";
    backdrop.addEventListener("click",closeRadialMenu);
    document.body.appendChild(backdrop);
  }
  const rect=anchorEl.getBoundingClientRect();
  let cx=rect.left+rect.width/2;
  let cy=rect.top+rect.height/2;
  const baseR=opts.r||104,labelGap=opts.labelGap==null?46:opts.labelGap,n=items.length;
  // Fan upward unless the trigger sits too close to the top of the viewport.
  // Callers can override the arc (e.g. the corner FAB fans up-left).
  const up=cy>baseR+80;
  const a0=opts.a0!=null?opts.a0:(up?200:20),a1=opts.a1!=null?opts.a1:(up?340:160); // degrees, y grows down
  // Size the circle to the crowd: a tight arc with many items fans out wider so
  // the 44px icons don't overlap (clampY below uses the grown R so an edge
  // trigger still shows the whole fan).
  const size=opts.fullCircle?(window.innerWidth<=480?60:64):44;
  const R=opts.fullCircle?Math.min(baseR,Math.max(0,(Math.min(window.innerWidth,window.innerHeight)-32-size)/2)):_radialFitRadius(baseR,n,a0,a1,58);
  if(opts.fullCircle){
    const inset=R+size/2+16;
    cx=Math.max(inset,Math.min(cx,window.innerWidth-inset));
    cy=Math.max(inset,Math.min(cy,window.innerHeight-inset));
    _radialViewportHandler=closeRadialMenu;
    window.addEventListener("resize",_radialViewportHandler);
    document.addEventListener("scroll",_radialViewportHandler,true);
  }
  // Above ~6 items even a roomy fan crowds the labels near the arc's apexes;
  // stagger their radii so neighbouring pills don't collide.
  const stagger=opts.labelStagger||n>6;
  if(opts.clampY&&!opts.fullCircle)cy=Math.max(R+56,Math.min(cy,window.innerHeight-R-56));
  const buttons=[];
  items.forEach((d,i)=>{
    const ang=(opts.fullCircle?a0+360*i/n:a0+(a1-a0)*(n===1?0.5:i/(n-1)))*Math.PI/180;
    let x=cx+R*Math.cos(ang);let y=cy+R*Math.sin(ang);
    x=Math.max(30,Math.min(x,window.innerWidth-30));
    y=Math.max(30,Math.min(y,window.innerHeight-30));
    const item=document.createElement("button");
    item.type="button";item.className="dest-radial-item";
    buttons.push(item);
    if(d.title)item.title=d.title;
    if(d.label)item.setAttribute("aria-label",d.label);
    item.innerHTML='<span class="dri-icon">'+d.icon+'</span>';
    if(opts.fullCircle){
      item.classList.add("dest-radial-circle-item");
      item.style.width=size+"px";item.style.height=size+"px";
      const caption=document.createElement("span");
      caption.className="dri-caption";caption.textContent=d.label;item.appendChild(caption);
    }
    item.style.left=(cx-size/2)+"px";item.style.top=(cy-size/2)+"px";
    // Label rides just past its item along the same spoke, so labels fan with
    // the items instead of colliding at the arc's apex.
    const lr=R+labelGap+((stagger&&i%2)?22:0);
    const lx=Math.max(64,Math.min(cx+lr*Math.cos(ang),window.innerWidth-64));
    const ly=Math.max(14,Math.min(cy+lr*Math.sin(ang),window.innerHeight-14));
    const lbl=document.createElement("span");
    lbl.className="dest-radial-label";lbl.textContent=d.label;
    lbl.style.left=lx+"px";lbl.style.top=ly+"px";
    document.body.appendChild(item);if(!opts.fullCircle)document.body.appendChild(lbl);
    requestAnimationFrame(()=>{
      item.style.transitionDelay=(i*28)+"ms";
      lbl.style.transitionDelay=(60+i*28)+"ms";
      item.classList.add("out");lbl.classList.add("out");
      item.style.left=(x-size/2)+"px";item.style.top=(y-size/2)+"px";
    });
    item.addEventListener("click",e=>{
      e.stopPropagation();
      closeRadialMenu();
      if(typeof d.onPick==="function")d.onPick(d,anchorEl);
    });
  });
  if(opts.fullCircle){
    const cancel=document.createElement("button");
    cancel.type="button";cancel.className="dest-radial-cancel";
    cancel.textContent="Cancel";cancel.style.left=cx+"px";cancel.style.top=cy+"px";
    cancel.addEventListener("click",closeRadialMenu);document.body.appendChild(cancel);buttons.push(cancel);
  }
  if(buttons[0])buttons[0].focus({preventScroll:true});
  _radialEscHandler=function(e){
    if(e.key==="Escape"){e.preventDefault();e.stopPropagation();closeRadialMenu();return;}
    const index=buttons.indexOf(document.activeElement);
    const cycle=e.key==="Tab"&&opts.backdrop!==false;
    if(!cycle&&index<0)return;
    let next;
    if(cycle)next=index+(e.shiftKey?-1:1);
    else if(e.key==="ArrowDown"||e.key==="ArrowRight")next=index+1;
    else if(e.key==="ArrowUp"||e.key==="ArrowLeft")next=index-1;
    else if(e.key==="Home")next=0;
    else if(e.key==="End")next=buttons.length-1;
    else return;
    if(buttons.length){e.preventDefault();buttons[(next+buttons.length)%buttons.length].focus({preventScroll:true});}
  };
  document.addEventListener("keydown",_radialEscHandler);
}

// The mini preview: same fan geometry at ~60% scale. Dots are live — entering
// one expands the preview into the real radial via opts.onExpand.
function showRadialMenuPreview(anchorEl,items,opts){
  opts=opts||{};
  hideRadialMenuPreview();
  const rect=anchorEl.getBoundingClientRect();
  const cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
  const n=items.length;
  const up=cy>58+60;
  const a0=up?200:20,a1=up?340:160;
  // Same fit as the real fan (28px dots, so a tighter min-chord), kept a bit
  // smaller than the full radius it promotes into.
  const R=_radialFitRadius(58,n,a0,a1,32,0.3);
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
      // Touch has no mouseenter, so a tap on a preview dot promotes it to the full
      // radial. onExpand → openRadialMenu closes the preview fan first, so a hybrid
      // device firing both mouseenter and click is idempotent.
      dot.addEventListener("click",(e)=>{e.stopPropagation();hideRadialMenuPreview();opts.onExpand()});
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
