// Local fixture only. Never reads dotenv or a production DATABASE_URL.
const path=require('node:path');
const express=require('express');
const {createActivityDb}=require('../test-support/activity-db');
async function start(){
  if(process.env.DCC_RESEARCH_REVIEW!=='1')throw new Error('Enable DCC_RESEARCH_REVIEW=1 with a dedicated localhost test database');
  const ctx=await createActivityDb(),app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.session={userId:1,workspaceId:'ws-1'};req.workspaceId='ws-1';next();});
  app.get('/api/me',(_req,res)=>res.json({userId:1,workspaceId:'ws-1'}));
  app.get('/api/projects',async(_req,res)=>res.json((await require('../project-store').createProjectStore(ctx).listOrganization('ws-1')).projects));
  app.get('/api/health',(_req,res)=>res.json({status:'ok',synthetic:true}));
  require('../routes/research')(app,ctx);require('../routes/wishlists')(app,ctx);
  const bytes=new Map();
  const storage={configured:true,async put(k,v){bytes.set(k,v);},async get(k){return bytes.get(k);}};
  require('../routes/task-attachments')(app,{taskAttachmentStore:require('../task-attachment-store').createStore({...ctx,storage})});
  app.use('/public',express.static(path.join(__dirname,'../public')));
  app.get(['/research','/research.html'],(_req,res)=>res.sendFile(path.join(__dirname,'../research.html')));
  app.get('/wishlists',(_req,res)=>res.sendFile(path.join(__dirname,'../wishlists.html')));
  const server=await new Promise(resolve=>{const s=app.listen(Number(process.env.PORT||8106),'127.0.0.1',()=>resolve(s));});
  console.log('Synthetic research review: http://localhost:'+server.address().port+'/research');
  return {server,ctx,async close(){await new Promise(r=>server.close(r));await ctx.close();}};
}
module.exports={start};
if(require.main===module)start().then(r=>{process.on('SIGTERM',()=>r.close().then(()=>process.exit()));process.on('SIGINT',()=>r.close().then(()=>process.exit()));}).catch(e=>{console.error(e);process.exit(1);});
