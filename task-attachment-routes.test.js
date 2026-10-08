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
