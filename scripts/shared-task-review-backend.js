// Review-only: synthetic sessions and in-memory PostgreSQL. Never mounted in production.
module.exports = async function mountSharedReview(app,ctx,date) {
  if (process.env.DCC_SHARED_TASK_REVIEW !== '1' || process.env.DCC_ACTIVITY_REVIEW !== '1' || !process.env.DCC_PGLITE_MODULE) throw new Error('Explicit disposable shared-task review mode required');
  ctx.socialStore=require('../social-store');
  ctx.sharedTasks=require('../shared-task-store').createSharedTaskStore(ctx);
  const clients=new Map();
  app.get('/api/events',(req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
    res.write('data: connected\n\n');
    if(!clients.has(req.workspaceId))clients.set(req.workspaceId,new Set());clients.get(req.workspaceId).add(res);
    req.on('close',()=>clients.get(req.workspaceId)?.delete(res));
  });
  ctx.broadcast=(type,data,workspaceId)=>{
    for(const client of clients.get(workspaceId)||[])client.write('data: '+JSON.stringify({type,...data})+'\n\n');
    if(type==='blocks-changed')for(const id of data.blockIds||[])void ctx.sharedTasks.notifyTask(id,workspaceId,ctx.broadcast);
  };
  require('../routes/shared-tasks')(app,ctx);
  app.get('/api/social/friends',async(req,res)=>res.json(await ctx.socialStore.listFriends(req.session.userId)));
  await ctx.pool.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(1,2,'accepted')");
  await ctx.pool.query("UPDATE users SET username=CASE WHEN id=1 THEN 'Morgan-demo' ELSE 'Riley-demo' END WHERE id IN (1,2)");
  const W=require('../public/js/workout-model'), record=W.empty(); record.plan=W.gentleReset(ctx.crypto.randomUUID);
  record.plan.exercises[0].sets[0].weight=123;record.plan.exercises[0].sets[0].reps=45;
  const definition=ctx.crypto.randomUUID();
  const props={kind:'responsibility_item',repeatType:'scheduled',title:'DEMO · Morning workout together',activityTaskType:'workout',estimatedMinutes:20,status:'active',scheduleRule:{version:1,patternType:'calendar',timeZone:'UTC',startDate:date,frequency:'daily',interval:1,times:['07:00'],end:{type:'never'}}};
  await ctx.pool.query("INSERT INTO blocks(id,type,properties,created_at,updated_at,user_id,workspace_id) VALUES($1,'task',$2,NOW(),NOW(),1,'ws-1')",[definition,props]);
  await ctx.pool.query("INSERT INTO task_activity_records(task_id,workspace_id,owner_user_id,task_type,record) VALUES($1,'ws-1',1,'workout',$2)",[definition,record]);
  const repeats=require('../responsibility-store')({blockDB:ctx.blockDB,getTodayStr:()=>date,appTimeZone:'UTC'});
  const [task]=await repeats.materializeDefinitionForDate(definition,{date,userId:1,workspaceId:'ws-1',targetTimeZone:'UTC'});
  app.get('/api/shared-task-review-info',(_req,res)=>res.json({synthetic:true,storage:'memory',date,taskId:task.id,series:true}));
};
