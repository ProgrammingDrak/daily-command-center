const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function client() {
  const elements = new Map();
  const handlers = {};
  const mounts = [];
  let failFeedback = false;
  let failActivity = false;
  const rows = [{id:7,user_id:2,display_name:'Synthetic Member',username:'member',created_at:'2026-10-13T12:00:00Z',message:'full\n<literal>',page_path:'/?tab=schedule'}];
  function element(id) {
    if (!elements.has(id)) elements.set(id,{textContent:'',innerHTML:'',disabled:false,hidden:false,setAttribute(){},classList:{add(){},remove(){}},addEventListener(event,fn){ handlers[id+':'+event]=fn; }});
    return elements.get(id);
  }
  const ctx = vm.createContext({
    document:{getElementById:element,addEventListener(event,fn){handlers[event]=fn;}},
    window:{DCC:{collection:{mount(root,opts){root.innerHTML='mounted collection';const instance={root,opts,rows:opts.rows,update(next){this.rows=next;}};mounts.push(instance);return instance;}}}},
    fetch:async url=> {
      const feedback = url.startsWith('/api/admin/feedback');
      if (feedback ? failFeedback : failActivity) return {ok:false,status:500,json:async()=>({error:'private database error'})};
      return {ok:true,status:200,json:async()=>feedback?{feedback:rows,nextCursor:null,summary:{total:1,latestFeedbackAt:rows[0].created_at}}:{activity:[],summary:{}}};
    },AbortController,setTimeout,clearTimeout,Date,
  });
  vm.runInContext(fs.readFileSync(require.resolve('./public/js/admin.js'),'utf8'),ctx);
  async function settle() { for(let i=0;i<12;i++) await Promise.resolve(); }
  return {elements,mounts,rows,async init(){handlers.DOMContentLoaded();await settle();},async refresh(){await handlers['admin-refresh:click']();},setFailure(feedback,activity){failFeedback=feedback;failActivity=activity;}};
}
test('inbox renders author, full multiline message, existing context, and newest-first default',async()=>{
  const c=client(); await c.init();
  const inbox=c.mounts.find(m=>m.root===c.elements.get('feedback-list'));
  assert.ok(inbox);
  assert.equal(inbox.rows[0].author,'Synthetic Member');
  assert.equal(inbox.rows[0].message,'full\n<literal>');
  assert.equal(inbox.rows[0].page_path,'/?tab=schedule');
  assert.equal(inbox.opts.defaultSortDirection,'desc');
  assert.equal(inbox.opts.defaultSortKey,'created_at');
  assert.equal(inbox.opts.columnOrder[0],'message');
  assert.ok(inbox.opts.multilineColumns.includes('message'));
});
test('failed refresh retains readable messages and an actionable error; retry recovers',async()=>{
  const c=client(); await c.init();
  const inbox=c.mounts.find(m=>m.root===c.elements.get('feedback-list'));
  c.setFailure(true,false); await c.refresh();
  assert.equal(inbox.rows.length,1);
  assert.equal(c.elements.get("feedback-list").innerHTML,"mounted collection");
  assert.match(c.elements.get('feedback-status').textContent,/Please try again/);
  assert.doesNotMatch(c.elements.get('feedback-status').textContent,/private/);
  assert.equal(c.elements.get('admin-refresh').disabled,false);
  c.setFailure(false,false);await c.refresh();
  assert.match(c.elements.get('feedback-status').textContent,/Updated/);
});
test('login failures cannot prevent feedback loading',async()=>{
  const c=client();c.setFailure(false,true);await c.init();
  assert.equal(c.elements.get('metric-feedback').textContent,'1');
  assert.ok(c.mounts.some(m=>m.root===c.elements.get('feedback-list')));
});
test('missing author records stay visible with an honest identity fallback',async()=>{
  const c=client();c.rows[0]={id:7,user_id:null,message:'legacy message',created_at:'2026-10-13T12:00:00Z'};await c.init();
  const inbox=c.mounts.find(m=>m.root===c.elements.get('feedback-list'));
  assert.equal(inbox.rows[0].author,'Unknown author');
  assert.equal(inbox.rows[0].page_path,'—');
  assert.equal(inbox.rows[0].message,'legacy message');
});

function submissionClient(isAdmin) {
  const handlers = {};
  const elements = new Map();
  const inbox = {hidden:true};
  let saveFails = false;
  let writes = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id,{value:'Synthetic draft',disabled:false,textContent:'',focus(){},setAttribute(){},classList:{toggle(){}},addEventListener(event,fn){handlers[id+':'+event]=fn;}});
    return elements.get(id);
  }
  const ctx=vm.createContext({document:{getElementById:element,querySelector(){return inbox;},addEventListener(event,fn){handlers[event]=fn;}},window:{},location:{pathname:'/fixture',search:''},setTimeout(){},
    fetch:async url=>{if(url==='/api/me')return {ok:true,json:async()=>({isAdmin})};writes++;return {ok:!saveFails,json:async()=>saveFails?{error:'Please try again'}:{ok:true}};}});
  vm.runInContext(fs.readFileSync(require.resolve('./public/js/feedback.js'),'utf8'),ctx);
  return {inbox,elements,async init(){handlers.DOMContentLoaded();for(let i=0;i<8;i++)await Promise.resolve();},async send(){await handlers['feedback-submit:click']();},fail(){saveFails=true;},writes(){return writes;}};
}
test('dashboard inbox link follows the server admin flag and fails closed for ordinary users',async()=>{
  for (const flag of [true,false,undefined]) {
    const c=submissionClient(flag);await c.init();assert.equal(c.inbox.hidden,flag!==true);
  }
});
test('failed submission retains the draft, and disabled Send prevents duplicate requests',async()=>{
  const c=submissionClient(false);await c.init();c.fail();await c.send();
  assert.equal(c.elements.get('feedback-message').value,'Synthetic draft');
  assert.equal(c.elements.get('feedback-status').textContent,'Please try again');
  assert.equal(c.elements.get('feedback-submit').disabled,false);
  c.elements.get('feedback-submit').disabled=true;await c.send();assert.equal(c.writes(),1);
});
