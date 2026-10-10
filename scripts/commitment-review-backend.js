// Explicit synthetic review mode only. Never imports server.js, dotenv or db.js.
const { createFixtureDb, canonicalBlockDB } = require('./commitment-test-db.cjs');
const { route } = require('../lib/route-helpers');
module.exports = async function mount(app) {
  const fixture = await createFixtureDb();
  await fixture.pool.query(require('../friend-invite-store').SCHEMA_SQL);
  await fixture.pool.query("CREATE TABLE blocks(id TEXT PRIMARY KEY,type TEXT,parent_id TEXT,date DATE,properties JSONB,workspace_id TEXT,user_id INTEGER,deleted_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW())");
  await fixture.pool.query('CREATE TABLE todo_sponsorships(id SERIAL PRIMARY KEY,workspace_id TEXT,owner_user_id INTEGER,sponsor_user_id INTEGER,sponsor_name TEXT,task_id TEXT,task_date DATE,task_block_id TEXT,task_title TEXT,kind TEXT,reward_title TEXT,note TEXT,value_cents INTEGER,status TEXT,updated_at TIMESTAMPTZ DEFAULT NOW(),accountability_commitment_id TEXT)');
  app.use((req, _res, next) => {
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)dcc_review_user=([0-5])(?:;|$)/);
    const userId = Number(cookie?.[1] || 1);
    req.session = userId ? { userId } : {}; req.workspaceId = 'ws-' + userId; next();
  });
  app.get('/public/js/app-config.js', (req,res) => res.type('js').set('Cache-Control','no-store').send(
    'window.DCC_APP_TIME_ZONE="Etc/UTC";window.DCC_DELTA_SYNC_ENABLED=false;window.DCC_ACCOUNT_CONTEXT=' + JSON.stringify({userId:req.session.userId,workspaceId:req.workspaceId}) + ';'));
  app.post('/review/commitments/reset', route(async () => {
    await fixture.pool.query('TRUNCATE todo_sponsorships,blocks,friendships,accountability_events,accountability_seen,accountability_members,accountability_commitments,friend_invite_links');
    return { synthetic: true, reset: true };
  }));
  app.use('/api/blocks',(req,res,next)=>{
    if(!['POST','PATCH'].includes(req.method))return next();
    const send=res.json.bind(res);
    res.json=body=>{
      if(!body?.id || !body.properties)return send(body);
      fixture.pool.query("INSERT INTO blocks(id,type,parent_id,date,properties,workspace_id,user_id,deleted_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(id) DO UPDATE SET properties=EXCLUDED.properties,date=EXCLUDED.date,deleted_at=EXCLUDED.deleted_at",[body.id,body.type,body.parent_id,body.date,body.properties,req.workspaceId,req.session.userId,body.deleted_at]).then(()=>send(body)).catch(e=>res.status(500).send({error:e.message}));
      return res;
    };next();
  });
  app.get('/api/blocks',route(async req=> (await fixture.pool.query("SELECT *,to_char(date,'YYYY-MM-DD') AS date FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL AND ($2::date IS NULL OR date=$2::date)",[req.workspaceId,req.query.date||null])).rows));
  app.get('/api/me', route(async req => ({...(await fixture.pool.query('SELECT id,username FROM users WHERE id=$1',[req.session.userId])).rows[0], onboardingState:{dailyCommandCenterTour:{version:2,completedAt:'2026-01-01T00:00:00Z'}}})));
  app.get('/api/auth/me', route(async req => ({authenticated:true,user:(await fixture.pool.query('SELECT id,username FROM users WHERE id=$1',[req.session.userId])).rows[0]})));
  for (const path of ['/login','/register']) app.get(path,(_req,res)=>res.sendFile(require('node:path').resolve(__dirname,'../login.html')));
  app.get('/vendor/drake-auth/browser.js',(_req,res)=>res.sendFile(require.resolve('drake-auth/browser')));
  app.post('/api/auth/clerk-sync',(_req,res)=>res.cookie('dcc_review_user','4').json({ok:true}));
  app.get('/api/auth/config',(_req,res)=>res.json({}));
  for (const path of ['/api/auth/login','/api/auth/register']) app.post(path,(_req,res)=>res.cookie('dcc_review_user','4').json({success:true}));
  app.get('/api/health', (_req,res) => res.json({database:'ok',reviewOnly:true}));
  app.use(require('../lib/account-binding'));
  app.get('/api/social/users/lookup', route(async req => {
    const row = (await fixture.pool.query('SELECT id,username FROM users WHERE username=$1',[req.query.q])).rows[0];
    if (!row) throw Object.assign(new Error('Fictional account not found'),{statusCode:404}); return row;
  }));
  const pool=fixture.pool;
const blockFixture={
 ensureDayRoot:async(day,user,ws,q)=>{const id=ws+':'+day;await q.query("INSERT INTO blocks(id,type,properties,date,workspace_id,user_id) VALUES($1,'day_root','{}',$2,$3,$4) ON CONFLICT DO NOTHING",[id,day,ws,user]);return id;},
 getBlockIncludingDeleted:async(id,q)=> (await q.query('SELECT * FROM blocks WHERE id=$1 FOR UPDATE',[id])).rows[0],
 updateBlock:async(id,fields,q)=>{await q.query('UPDATE blocks SET properties=$2 WHERE id=$1',[id,fields.properties]);}
};
const commitmentBounty=require('../routes/social-todo')({get(){},post(){},use(){},delete(){},put(){},patch(){}},{pool,route:require('../lib/route-helpers').route,blockDB:blockFixture,broadcast(){},coerceDateString:require('../lib/route-helpers').coerceDateString,isValidDate:require('../lib/route-helpers').isValidDate,getTodayStr:()=> '2026-10-08'});
  require('../routes/commitments')(app, {pool:fixture.pool,route,blockDB:canonicalBlockDB(pool),commitmentBounty});
  require('../routes/friend-invites')(app,{pool:fixture.pool,route,path:require('node:path'),PROJECT_DIR:require('node:path').resolve(__dirname,'..')});
  const cleanup = async () => { await fixture.cleanup(); process.exit(0); };
  process.once('SIGTERM',cleanup); process.once('SIGINT',cleanup);
};
