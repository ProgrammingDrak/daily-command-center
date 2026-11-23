// Full application with disposable in-memory PostgreSQL. No .env or user data.
if(!process.env.DCC_PGLITE_MODULE)throw new Error('Set DCC_PGLITE_MODULE to a local PGlite installation.');
process.env.DCC_WORKING_QUEUE_REVIEW='1';
process.env.DCC_TEST_DATABASE_URL='postgres://synthetic@127.0.0.1:1/synthetic';
process.env.DCC_REVIEW_ACTUAL='1';
process.env.DCC_REVIEW_EXPORT_APP='1';
process.env.DCC_TASK_ACTIONS_REVIEW='1';
const port=Number(process.env.PORT||8114),base='http://127.0.0.1:'+port;
const {default:app}=await import('./ui-review-server.mjs');
if(process.env.DCC_TASK_ACTIONS_QA_FILE)app.get('/qa',(_req,res)=>res.sendFile(process.env.DCC_TASK_ACTIONS_QA_FILE));
const server=await new Promise(resolve=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));});
async function post(url,body={}){
  const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;
}
const today=new Date().toISOString().slice(0,10),past=new Date(Date.now()-86400000).toISOString().slice(0,10);
async function seed(){
  await post('/api/queue-review/reset');
  await post('/api/review/task-actions/options',{delayMs:0});
  async function add(id,title,date,extra={}){return post('/api/blocks',{id,type:'block',date,
    properties:{kind:'task',type:'task',title,local_id:'legacy-'+id,start:date?'09:00':null,end:date?'09:30':null,duration:30,...extra}});}
  await add('qa-itinerary','Itinerary shared parent',today);
  await add('qa-itinerary-child','Itinerary child',today,{subtaskOf:'qa-itinerary'});
  await add('qa-loose','Loose Ends shared parent',past);
  await add('qa-loose-child','Loose Ends child',past,{subtaskOf:'qa-loose'});
  await add('qa-context','Completed parent context',past);
  await post('/api/tasks/qa-context/completion',{completed:true,mutationId:crypto.randomUUID(),taskDate:past,expectedRevision:null});
  await add('qa-context-child','Unfinished child under completed parent',past,{subtaskOf:'qa-context'});
  await add('qa-someday','Someday shared parent',null,{someday:true,kind:'backlog',stage:'Backlog'});
  await add('qa-someday-child','Someday child',null,{someday:true,kind:'backlog',stage:'Backlog',subtaskOf:'qa-someday'});
  await add('qa-whenever','Whenever shared parent',null,{kind:'backlog',stage:'Whenever'});
  await add('qa-whenever-child','Whenever child',null,{kind:'backlog',stage:'Whenever',subtaskOf:'qa-whenever'});
  for(const taskId of ['qa-itinerary','qa-loose','qa-context-child']){
    const state=await (await fetch(base+'/api/working-queue')).json();
    await post('/api/working-queue',{action:'queue-add',taskId,expectedRevision:state.revision,sourceEventId:'fixture:'+crypto.randomUUID(),at:new Date().toISOString()});
  }
  await post('/api/review/task-actions/options',{delayMs:2000});
}
await seed();
app.post('/review-task-actions/reset',async(_req,res)=>{try{await seed();res.json({ok:true});}catch(error){res.status(500).json({error:error.message});}});
console.log('Task action review: '+base+'/?tab=tasks&view=list');
process.on('SIGTERM',()=>server.close());
