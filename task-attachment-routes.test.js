/* global FormData */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const crypto = require("node:crypto");
const { Blob } = require("node:buffer");
test("transfer concurrency is bounded before buffering and service identity does not authorize files", async t => {
  let entered = 0; const releases=[];
  const store = {configured:true,authorize:async()=>true,list:async()=>[],upload:async()=>{entered++;await new Promise(resolve=>releases.push(resolve));return {id:crypto.randomUUID()};}};
  const app=express(); app.use((req,_res,next)=>{req.session={userId:Number(req.headers['fixture-user'])||undefined};req.workspaceId='ws-1';req.dccServiceAuth={userId:1,workspaceId:'ws-1'};next();});
  require('./routes/task-attachments')(app,{taskAttachmentStore:store});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/tasks/task/attachments`;
  assert.equal((await fetch(base)).status,401);
  const post=()=>{const data=new FormData();data.append('file',new Blob(['Synthetic'],{type:'text/plain'}),'fixture.txt');return fetch(base,{method:'POST',headers:{'fixture-user':'1','X-DCC-Attachment':'1','X-Upload-Id':crypto.randomUUID()},body:data});};
  const first=post(),second=post();
  const waitEntered=async()=>{const deadline=Date.now()+5000;while(entered<2){if(Date.now()>deadline)throw new Error('Uploads did not enter fixture');await new Promise(resolve=>setTimeout(resolve,5));}};
  try {await waitEntered();const blocked=await post();assert.equal(blocked.status,429);assert.match((await blocked.json()).error,/Too many file transfers/);}
  finally {releases.forEach(resolve=>resolve());await Promise.all([first,second]);}
  const third=post();const deadline=Date.now()+5000;while(entered<3){if(Date.now()>deadline)throw new Error('Slots did not release');await new Promise(resolve=>setTimeout(resolve,5));}releases.at(-1)();assert.equal((await third).status,201);
});
test("mutation guards reject missing headers, cross-site requests, foreign origins and extra multipart parts", async t => {
  let authorized = 0;
  const store = {configured:true,authorize:async()=>{authorized++;return true;},list:async()=>[],upload:async()=>({id:crypto.randomUUID()}),remove:async()=>{}};
  const app=express(); app.use((req,_res,next)=>{req.session={userId:1};req.workspaceId='ws-1';next();});
  require('./routes/task-attachments')(app,{taskAttachmentStore:store});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/tasks/task/attachments`;
  const remove=headers=>fetch(`${base}/${crypto.randomUUID()}`,{method:'DELETE',headers});
  assert.equal((await remove({})).status,403);
  assert.equal((await remove({'X-DCC-Attachment':'1','Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await remove({'X-DCC-Attachment':'1',Origin:'https://evil.example'})).status,403);
  assert.equal((await remove({'X-DCC-Attachment':'1'})).status,200);
  assert.equal((await fetch(`${base}/not-a-uuid/download`)).status,400);
  assert.equal(authorized,0,'only uploads pre-authorize; other routes authorize inside the store');
  const data=new FormData();data.append('file',new Blob(['a'],{type:'text/plain'}),'a.txt');data.append('file',new Blob(['b'],{type:'text/plain'}),'b.txt');
  const extra=await fetch(base,{method:'POST',headers:{'X-DCC-Attachment':'1','X-Upload-Id':crypto.randomUUID()},body:data});
  assert.equal(extra.status,400); assert.match((await extra.json()).error,/one file per request/);
  assert.equal(authorized,1);
});
