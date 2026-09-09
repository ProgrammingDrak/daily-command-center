const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function harness(){
  const source=fs.readFileSync('public/js/schedule-tab.js','utf8');
  const start=source.indexOf('  function timeBlockCollapseKey(');
  const end=source.indexOf('\n\n  const timeBlocks=',start);
  let timer=null,focused=null,opens=0;
  const collapsed=new Set();
  function element(){return {dataset:{},attrs:{},listeners:{},children:[],isConnected:true,
    setAttribute(k,v){this.attrs[k]=v;},
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);},
    appendChild(c){this.children.push(c);},
    focus(){focused=this;},
    fire(k,e={}){for(const f of this.listeners[k]||[])f(e);}
  };}
  const context={viewDate:'2026-09-09',DCC:{TimeBlocks:{rangeLabel:()=> '9 AM - 5 PM'}},
    isCollapsed:key=>collapsed.has(key),document:{createElement:element},
    TIME_BLOCK_DISCLOSURE_ICONS:{expanded:'v',collapsed:'>'},escHtml:s=>s,
    toggleCollapsed:key=>collapsed.has(key)?collapsed.delete(key):collapsed.add(key),
    buildListView(){},wrap:{querySelectorAll:()=>[]},openBlockEditor:()=>opens++,
    QUICK_COMPLETE_HOLD_MS:550,setTimeout:f=>(timer=f,1),clearTimeout:()=>timer=null};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+'\nthis.make=timeBlockDividerEl;',context);
  return {context,make:()=>context.make({id:'work',name:'Work',start:'09:00'},false),
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
  assert.match(toggle.title,/9 AM - 5 PM/);assert.doesNotMatch(toggle.innerHTML,/<small>/);
  h.context.viewDate='2026-09-10';
  assert.equal(h.make().children[0].attrs['aria-expanded'],'true');
});

test('fixed Triage has no collapse or edit controls',()=>{
  const h=harness(),header=h.context.make({id:'triage',name:'Triage',fixed:true},false);
  assert.equal(header.children.length,0);assert.match(header.innerHTML,/Triage/);
});
