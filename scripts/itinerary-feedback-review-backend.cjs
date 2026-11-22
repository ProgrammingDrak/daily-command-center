// Explicit fictional fixture only. Never imports server.js or production configuration.
module.exports = async function mount(app) {
  const process=require('node:process');
  if(process.env.DCC_ITINERARY_FEEDBACK_REVIEW!=="1")throw Error("Enable the fictional itinerary review explicitly");
  const ctx=await require('../test-support/activity-db').createActivityDb();
  const date=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
  Object.assign(ctx,{APP_TIME_ZONE:'America/New_York',getTodayStr:()=>date,isValidDate:require('../routes/itinerary-shares').validDate,filterLegacyGcalBlocks:rows=>rows,getScheduleBlocks:async()=>[],broadcast(){},broadcastQueueChange(){}});
  app.use((req,_res,next)=>{req.session={userId:1};req.workspaceId='ws-1';next();});
  app.get('/public/js/app-config.js',(_req,res)=>res.type('js').send('window.DCC_APP_TIME_ZONE="America/New_York";window.DCC_DELTA_SYNC_ENABLED=false;window.DCC_ACCOUNT_CONTEXT={userId:1,workspaceId:"ws-1"};'));
  app.get('/api/me',(_req,res)=>res.json({id:1,username:'alex-demo',onboardingState:{dailyCommandCenterTour:{version:2,completedAt:'2026-01-01T00:00:00Z'}}}));
  app.get('/api/auth/me',(_req,res)=>res.json({authenticated:true,user:{id:1,username:'alex-demo'}}));
  app.get('/api/health',(_req,res)=>res.json({database:'ok',reviewOnly:true,feature:'itinerary-feedback'}));
  require('../routes/itinerary-shares').mount(app,ctx);
  require('../routes/blocks')(app,ctx);
  await ctx.blockDB.ensureDayRoot(date,1,'ws-1');
  for (const [id,title,start,end,visibility] of [
    ['feedback-coffee','Coffee and plan the day','09:00','09:30','public'],
    ['feedback-walk','Walk by the river','12:00','12:45','public'],
    ['feedback-dinner','Try the neighborhood ramen spot','18:00','19:00','public'],
    ['feedback-private','PRIVATE fixture appointment','14:00','14:30','private'],
  ]) await ctx.blockDB.createBlock({id,type:'block',workspace_id:'ws-1',user_id:1,date,properties:{kind:'task',type:'task',title,start,end,local_id:id,publicVisibility:visibility,detail:'PRIVATE fixture notes never shared'}});
  const token='403403403403403403403403403403403403403403403403';
  await ctx.pool.query('INSERT INTO itinerary_day_shares(token,workspace_id,day) VALUES($1,$2,$3)',[token,'ws-1',date]);
  async function seedContributions() {
  await ctx.pool.query('DELETE FROM itinerary_contributions WHERE token=$1',[token]);
  const parent=require('node:crypto').randomUUID();
  await ctx.pool.query("INSERT INTO itinerary_contributions(id,token,block_id,kind,author,body) VALUES($1,$2,'feedback-coffee','comment','Blair','Want to meet at the cafe by the park?')",[parent,token]);
  await ctx.pool.query("INSERT INTO itinerary_contributions(id,token,block_id,parent_id,kind,author,body) VALUES($1,$2,'feedback-coffee',$3,'comment','Alex','Yes! I will grab a table outside.')",[require('node:crypto').randomUUID(),token,parent]);
  await ctx.pool.query("INSERT INTO itinerary_contributions(id,token,block_id,kind,author,body) VALUES($1,$2,'feedback-walk','like','','heart')",[require('node:crypto').randomUUID(),token]);
  }
  await seedContributions();
  app.post('/review/feedback/reset',async(_req,res,next)=>{try{await seedContributions();res.json({synthetic:true});}catch(error){next(error);}});
  app.get('/api/feedback-review-info',(_req,res)=>res.json({synthetic:true,date,sharedPath:'/shared-itinerary/'+token}));
  const shutdown=async()=>{await ctx.close();process.exit(0);};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
};
