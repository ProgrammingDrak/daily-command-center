const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const src = fs.readFileSync(require.resolve('./public/js/shared-tasks'),'utf8');
function fixture(api) {
  const hosts=[], events={};
  const document={readyState:'loading',addEventListener:(name,fn)=>events[name]=fn,querySelectorAll:selector=>selector==='[data-shared-task]'?hosts:[],getElementById:()=>null};
  const ctx={AbortController,setTimeout,clearTimeout,document,window:{DCC:{api:(path,options)=>path.endsWith('/sync')?Promise.resolve({created:0}):api(path,options),dates:{todayKey:()=> '2026-10-21'},esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')}},setInterval(){},isDone:ev=>!!ev.optimistic};
  vm.runInNewContext(src,ctx);return {D:ctx.window.DCC,hosts,events,ctx};
}
const share={id:'occurrence',taskId:'mine',state:'accepted',title:'Workout',participants:[{userId:1,self:true,name:'Me <x>',completed:false,state:'accepted'},{userId:2,name:'Friend',completed:false,state:'accepted'}]};
test('avatar labels and count use own optimistic completion without changing the peer',()=>{
  const {D}=fixture(()=>{}), html=D.SharedTasks.badge(share,{optimistic:true});
  assert.match(html,/1\/2 done/);assert.match(html,/Me &lt;x> \(you\): completed/);assert.match(html,/Friend: not completed/);
  assert.equal((html.match(/aria-hidden="true">✓/g)||[]).length,1);
  assert.equal(share.participants[0].completed,false);
  assert.match(D.SharedTasks.badge({...share,participants:share.participants.map(p=>({...p,completed:true}))}),/All done/);
});
test('failed refresh clears stale identities and marks sharing unavailable, then recovers',async()=>{
  let fail=false;
  const {D,hosts}=fixture(async()=>{if(fail)throw new Error('offline');return {shares:[share]};});
  const host={dataset:{sharedTask:'mine'},_sharedTask:{optimistic:false},setAttribute(){}};hosts.push(host);
  await D.SharedTasks.refresh();assert.match(host.innerHTML,/Friend/);
  fail=true;await D.SharedTasks.refresh();assert.equal(host.innerHTML,'Sharing unavailable');
  fail=false;await D.SharedTasks.refresh();assert.match(host.innerHTML,/0\/2 done/);
});
test('duplicate live events coalesce and never let older requests overwrite newer state',async()=>{
  const resolves=[],calls=[];
  const {D,hosts}=fixture(()=>{calls.push(1);return new Promise(resolve=>resolves.push(resolve));});
  const host={dataset:{sharedTask:'mine'},setAttribute(){}};hosts.push(host);
  const first=D.SharedTasks.refresh();void D.SharedTasks.refresh();void D.SharedTasks.refresh();
  await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,1);resolves.shift()({shares:[share]});await first;await new Promise(r=>setTimeout(r,0));
  assert.equal(calls.length,2);resolves.shift()({shares:[]});await new Promise(r=>setTimeout(r,0));
  assert.equal(host.innerHTML,'Share task');assert.equal(calls.length,2);
});
test('unsafe avatar URL never creates an executable or remote image',()=>{
  const {D}=fixture(()=>{});const html=D.SharedTasks.badge({...share,participants:[{...share.participants[0],avatar:'javascript:alert(1)'}]});
  assert.doesNotMatch(html,/<img|javascript:/);
});
