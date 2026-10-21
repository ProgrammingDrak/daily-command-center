const { route } = require('../lib/route-helpers');
const { createSharedTaskStore } = require('../shared-task-store');
module.exports = function mount(app,ctx) {
  const store = ctx.sharedTasks || createSharedTaskStore(ctx);
  app.use(['/api/tasks','/api/blocks'],async (req,res,next) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    try {
      await store.guardWrites({userId:req.session?.userId || req.dccServiceAuth?.userId,workspaceId:req.workspaceId});
      next();
    } catch (e) { res.status(e.statusCode || 500).json({error:e.statusCode ? e.message : 'Task access unavailable'}); }
  });
  app.use('/api/shared-tasks',(req,res,next) => {
    res.setHeader('Cache-Control','private, no-store');
    if (!req.session?.userId || !req.workspaceId) return res.status(401).json({error:'Sign in first'});
    req.sharedTaskActor = {userId:req.session.userId,workspaceId:req.workspaceId};
    next();
  });
  const notify = id => store.notify(id,ctx.broadcast).catch(e => console.error('[shared-tasks] refresh failed:',e.message));
  app.get('/api/shared-tasks',route(async req => {
    const date=req.query.date || ctx.getTodayStr();
    if (!require('../public/js/activity-model').validDate(date)) throw Object.assign(new Error('Valid occurrence date required'),{statusCode:400});
    return {shares:await store.list(req.sharedTaskActor,date)};
  }));
  app.get('/api/shared-tasks/preview/:taskId',route(req=>store.preview(req.params.taskId,req.sharedTaskActor)));
  app.post('/api/shared-tasks/invite',route(async req => {
    const result = await store.invite(req.body?.taskId,req.body?.userId,req.sharedTaskActor,{includeInstructions:req.body?.includeInstructions===true,instructionsHash:req.body?.instructionsHash});
    await notify(result.id);
    return result;
  }));
  app.post('/api/shared-tasks/:id/respond',route(async req => {
    const result = await store.respond(req.params.id,req.body?.action,req.sharedTaskActor,req.body?.userId ?? req.session.userId);
    await notify(req.params.id);
    // The leaving participant drops their local indicator immediately too.
    ctx.broadcast('shared-tasks-changed',{},req.workspaceId);
    if (result.taskId) ctx.broadcast('blocks-changed',{action:'shared-task-accept',blockIds:[result.taskId]},req.workspaceId);
    return result;
  }));
};
