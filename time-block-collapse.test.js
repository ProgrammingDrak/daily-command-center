const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function harness(){
  let timer=null,focused=null,opens=0;
  const collapsed=new Set();
  function element(){return {dataset:{},attrs:{},listeners:{},children:[],isConnected:true,
    setAttribute(k,v){this.attrs[k]=v;},
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);},
    append(...items){this.children.push(...items);},
    appendChild(c){this.children.push(c);},
    focus(){focused=this;},
    fire(k,e={}){for(const f of this.listeners[k]||[])f(e);}
  };}
  const context={viewDate:'2026-09-09',DCC:{TimeBlocks:require('./public/js/time-blocks')},
    isCollapsed:key=>collapsed.has(key),document:{createElement:element},
    TIME_BLOCK_DISCLOSURE_ICONS:{expanded:'v',collapsed:'>'},escHtml:s=>s,
    toggleCollapsed:key=>collapsed.has(key)?collapsed.delete(key):collapsed.add(key),
    buildListView(){},wrap:{querySelectorAll:()=>[]},openBlockEditor:()=>opens++,
    QUICK_COMPLETE_HOLD_MS:550,setTimeout:f=>(timer=f,1),clearTimeout:()=>timer=null};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/time-block-view.js','utf8'),context);
  context.make=block=>{const key=context.DCC.TimeBlocks.collapseKey(context.viewDate,block);return context.DCC.TimeBlockView.header(block,{key,collapsed:collapsed.has(key),onToggle:()=>context.toggleCollapsed(key),onEdit:()=>opens++});};
  return {context,make:()=>context.make({id:'work',name:'Work',start:'09:00',end:'17:00',timed:true,editable:true}),
    hold:()=>timer?.(),get pending(){return timer!==null;},get focused(){return focused;},
    get opens(){return opens;},collapsed};
}

test('hold reveals editing without collapsing; the revealed control opens editing',()=>{
  const h=harness(),[toggle,edit]=h.make().children;
  toggle.fire('pointerdown',{button:0,clientX:0,clientY:0});h.hold();
  assert.equal(h.focused,edit);
  toggle.fire('pointerup');toggle.fire('click');
  assert.equal(h.collapsed.size,0);
  edit.fire('click');assert.equal(h.opens,1);
});

test('movement, cancellation, release, and leaving cancel a pending hold',()=>{
  for(const event of ['pointermove','pointercancel','pointerup','pointerleave']){
    const h=harness(),[toggle]=h.make().children;
    toggle.fire('pointerdown',{button:0,clientX:0,clientY:0});
    toggle.fire(event,{clientX:0,clientY:9});
    assert.equal(h.pending,false,event);
  }
});

test('click collapse survives rebuilding, separates dates, and keeps the range in the tooltip',()=>{
  const h=harness();let [toggle]=h.make().children;
  assert.equal(toggle.attrs['aria-expanded'],'true');toggle.fire('click');
  [toggle]=h.make().children;assert.equal(toggle.attrs['aria-expanded'],'false');
  assert.match(toggle.title,/9:00 AM - 5:00 PM/);assert.equal(toggle.children.length,2);
  h.context.viewDate='2026-09-10';
  assert.equal(h.make().children[0].attrs['aria-expanded'],'true');
});

test('permanent blocks collapse but never expose editing or a range',()=>{
  for(const block of [require('./public/js/time-blocks').TRIAGE_BLOCK,require('./public/js/time-blocks').UNPLANNED_BLOCK]){
    const h=harness(),header=h.context.make(block);
    assert.equal(header.children.length,1);
    const toggle=header.children[0];assert.equal(toggle.title,'Collapse '+block.name);
    toggle.fire('click');assert.equal(h.context.make(block).children[0].attrs['aria-expanded'],'false');
    assert.equal(toggle.listeners.pointerdown,undefined);
  }
});
