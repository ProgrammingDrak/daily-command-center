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
  const task=await require('../activity-store').createActivityStore(ctx).create({title:'DEMO · Morning workout together',date,record},{userId:1,workspaceId:'ws-1'});
  app.get('/api/shared-task-review-info',(_req,res)=>res.json({synthetic:true,storage:'memory',date,taskId:task.taskId}));
};
