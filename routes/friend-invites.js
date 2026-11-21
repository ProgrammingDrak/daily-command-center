module.exports=function mount(app,{pool,route,path,PROJECT_DIR}) {
 const store=require('../friend-invite-store').createStore({pool});
 app.use(['/api/friend-invites','/api/public/friend-invites','/friend-invite'],(_req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');next();});
 app.get('/friend-invite/:token',(_req,res)=>res.sendFile(path.join(PROJECT_DIR,'friend-invite.html')));
 app.use('/api/friend-invites',(req,res,next)=>req.session?.userId?next():res.status(401).json({error:'Sign in first'}));
 app.get('/api/friend-invites',route(req=>store.list(req.session.userId)));
 app.post('/api/friend-invites',route(req=>store.create(req.session.userId,req.body||{})));
 app.post('/api/friend-invites/:id/revoke',route(req=>store.revoke(req.session.userId,req.params.id)));
 app.get('/api/public/friend-invites/:token',route(req=>store.preview(req.params.token,req.session?.userId)));
 app.post('/api/public/friend-invites/:token/accept',(req,res,next)=>req.session?.userId && req.body?.expectedUserId===req.session.userId?next():res.status(409).json({error:'Your account changed. Reload the invitation before adding.'}),route(req=>store.accept(req.session.userId,req.params.token)));
};
