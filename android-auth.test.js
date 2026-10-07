const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const createAndroidAuth = require('./lib/android-auth');
const ORIGIN = createAndroidAuth.ORIGIN;
const token = () => crypto.randomBytes(32).toString('base64url');
const digest = v => crypto.createHash('sha256').update(v).digest('base64url');
async function fixture(options={}) {
  let now=1000000;
  const app=express();app.use(express.json());
  app.use(session({name:'dcc_session',secret:'synthetic-auth-test-secret-only',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}}));
  app.post('/test/session',(req,res)=>{Object.assign(req.session,req.body);res.json({ok:true});});
  app.get('/test/me',(req,res)=>res.json({userId:req.session.userId,username:req.session.username,workspaceId:req.session.workspaceId}));
  app.use(createAndroidAuth({enabled:true,certificateFingerprint:Array(32).fill('AA').join(':'),clock:()=>now,...options}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port;
  let cookie='';
  async function request(path,method='GET',body,headers={},useCookie=true) {
    const r=await fetch(base+path,{method,redirect:'manual',headers:{...(useCookie&&cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body ? (typeof body==='string'?body:JSON.stringify(body)):undefined});
    if(useCookie && r.headers.get('set-cookie')) cookie=r.headers.get('set-cookie').split(';')[0];
    return r;
  }
  async function authorize({state=token(),verifier=token(),identity={userId:7,username:'Synthetic user',workspaceId:'synthetic'}}={}) {
    await request('/test/session','POST',identity);
    const r=await request('/auth/android/authorize?'+new URLSearchParams({state,challenge:digest(verifier)}));
    const html=await r.text(); const nonce=html.match(/name="nonce" value="([A-Za-z0-9_-]+)"/)[1];
    return {state,verifier,nonce,html};
  }
  async function approve(flow,headers={origin:ORIGIN}) {
    const r=await request('/auth/android/approve','POST','nonce='+flow.nonce,{'content-type':'application/x-www-form-urlencoded',...headers});
    return {response:r,code:r.headers.get('location') ? new URL(r.headers.get('location')).searchParams.get('code') : null};
  }
  return {request,authorize,approve,advance:n=>now+=n,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('Android auth stays disabled without approved config/certificate',async()=>{
 const f=await fixture({certificateFingerprint:''});try{assert.equal((await f.request('/api/auth/android/config').then(r=>r.json())).enabled,false);assert.deepEqual(await f.request('/.well-known/assetlinks.json').then(r=>r.json()),[]);assert.equal((await f.request('/auth/android/authorize')).status,503);}finally{await f.close();}
});
test('anonymous browser uses existing DCC login with fixed continuation',async()=>{
 const f=await fixture();try{const state=token(),verifier=token();const r=await f.request('/auth/android/authorize?'+new URLSearchParams({state,challenge:digest(verifier)}));assert.equal(r.status,303);const location=new URL(r.headers.get('location'),ORIGIN);assert.equal(location.pathname,'/login');const next=new URL(location.searchParams.get('next'),ORIGIN);assert.equal(next.origin,ORIGIN);assert.equal(next.pathname,'/auth/android/authorize');assert.equal(next.searchParams.get('state'),state);assert.equal((await f.request('/auth/android/authorize?state=x&challenge=x&redirect_uri=https://evil.test')).status,400);}finally{await f.close();}
});
test('browser consent is escaped, CSRF/session/account bound and single use',async()=>{
 const f=await fixture();try{const flow=await f.authorize({identity:{userId:7,username:'<img src=x onerror=alert(1)>',workspaceId:'s'}});assert.ok(flow.html.includes('&lt;img'));assert.ok(!flow.html.includes('<img'));assert.equal((await f.approve(flow,{origin:'https://evil.test'})).response.status,403);assert.equal((await f.approve(flow,{origin:''})).response.status,403);await f.request('/test/session','POST',{userId:8});assert.equal((await f.approve(flow)).response.status,403);const other=await f.authorize();assert.equal((await f.approve(other)).response.status,303);assert.equal((await f.approve(other)).response.status,403);}finally{await f.close();}
});
test('PKCE exchange yields existing session cookie, rejects wrong verifier/state/replay',async()=>{
 const f=await fixture();try{const flow=await f.authorize();const {response,code}=await f.approve(flow);const url=new URL(response.headers.get('location'));assert.equal(url.origin,ORIGIN);assert.equal(url.pathname,'/auth/android/callback');assert.deepEqual([...url.searchParams.keys()].sort(),['code','state']);assert.equal((await f.request('/api/auth/android/exchange','POST',{code,state:flow.state,verifier:token()}, {},false)).status,401);assert.equal((await f.request('/api/auth/android/exchange','POST',{code,state:token(),verifier:flow.verifier},{},false)).status,401);const r=await f.request('/api/auth/android/exchange','POST',{code,state:flow.state,verifier:flow.verifier},{},false);assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});assert.ok(r.headers.get('set-cookie').includes('HttpOnly'));assert.ok(r.headers.get('set-cookie').startsWith('dcc_session='));assert.equal((await f.request('/api/auth/android/exchange','POST',{code,state:flow.state,verifier:flow.verifier},{},false)).status,401);const me=await f.request('/test/me','GET',undefined,{cookie:r.headers.get('set-cookie').split(';')[0]},false).then(r=>r.json());assert.equal(me.userId,7);}finally{await f.close();}
});
test('expired, invalid-origin, extra-field and concurrent exchanges fail safely',async()=>{
 const f=await fixture();try{let flow=await f.authorize();let {code}=await f.approve(flow);const body={code,state:flow.state,verifier:flow.verifier};assert.equal((await f.request('/api/auth/android/exchange','POST',' '.repeat(3000)+JSON.stringify(body),{},false)).status,413);assert.equal((await f.request('/api/auth/android/exchange','POST',body,{origin:'https://evil.test'},false)).status,403);assert.equal((await f.request('/api/auth/android/exchange','POST',{...body,redirect_uri:'https://evil.test'},{},false)).status,400);f.advance(120001);assert.equal((await f.request('/api/auth/android/exchange','POST',body,{},false)).status,401);flow=await f.authorize();({code}=await f.approve(flow));const responses=await Promise.all([1,2].map(()=>f.request('/api/auth/android/exchange','POST',{code,state:flow.state,verifier:flow.verifier},{},false)));assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);}finally{await f.close();}
});
test('expired consent and bounded flow capacity, fallback never reflects code',async()=>{
 const f=await fixture({limit:1});try{const flow=await f.authorize();const query=new URLSearchParams({state:token(),challenge:token()});assert.equal((await f.request('/auth/android/authorize?'+query)).status,429);f.advance(300001);assert.equal((await f.approve(flow)).response.status,403);assert.equal((await f.request('/auth/android/authorize?'+query)).status,200);const r=await f.request('/auth/android/callback?code=secret-test-code');assert.equal(r.status,409);assert.ok(!(await r.text()).includes('secret-test-code'));assert.equal(r.headers.get('referrer-policy'),'no-referrer');}finally{await f.close();}
});
