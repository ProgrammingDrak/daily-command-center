// One pointer/keyboard press contract for itinerary completion and queue ordering.
(function () {
  'use strict';
  window.DCC.bindHoldAction = function (button, onClick, onHold) {
    if (!button) return;
    let timer=null, press=null, armed=false, cancelled=false, heldKey=null;
    function clear() { clearTimeout(timer);timer=null;armed=false;button.classList.remove('is-holding'); }
    function suppressReleaseClick(pointerId) {
      const block=event=>{
        if(event.detail===0)return;
        if(event.pointerId!=null&&event.pointerId!==pointerId)return;
        event.preventDefault();event.stopImmediatePropagation();document.removeEventListener('click',block,true);
      };
      document.addEventListener('click',block,true);
      setTimeout(()=>document.removeEventListener('click',block,true),800);
    }
    button.addEventListener('pointerdown',event=>{
      if(event.button!==0||button.disabled)return;
      event.stopPropagation();clear();cancelled=false;press={id:event.pointerId,x:event.clientX,y:event.clientY};
      try { button.setPointerCapture(event.pointerId); } catch(_error) {}
      button.classList.add('is-holding');
      timer=setTimeout(()=>{timer=null;if(press&&button.isConnected)armed=true;},550);
    });
    button.addEventListener('pointermove',event=>{
      if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>12){cancelled=true;clear();}
    });
    button.addEventListener('pointerup',event=>{
      if(!press||event.pointerId!==press.id)return;
      const held=armed,id=press.id;press=null;clear();
      if(cancelled||held)suppressReleaseClick(id);
      if(held&&!cancelled&&button.isConnected)onHold?.();
    });
    button.addEventListener('pointercancel',()=>{cancelled=true;press=null;clear();});
    button.addEventListener('lostpointercapture',()=>{press=null;clear();});
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();clear();
      if(cancelled){cancelled=false;return;}
      onClick?.();
    });
    button.addEventListener('keydown',event=>{
      if(!event.shiftKey||!['Enter',' '].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      if(event.repeat||heldKey)return;
      heldKey=event.key;clear();onHold?.();
    });
    button.addEventListener('keyup',event=>{
      if(event.key!==heldKey)return;
      event.preventDefault();event.stopPropagation();heldKey=null;
    });
    button.addEventListener('blur',()=>{press=null;heldKey=null;clear();});
    button.addEventListener('contextmenu',event=>event.preventDefault());
  };
})();
