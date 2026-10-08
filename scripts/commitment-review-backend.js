// Explicit synthetic review mode only. Never imports server.js, dotenv or db.js.
const { createFixtureDb } = require('./commitment-test-db.cjs');
const { route } = require('../lib/route-helpers');
module.exports = async function mount(app) {
  const fixture = await createFixtureDb();
  app.use((req, _res, next) => {
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)dcc_review_user=([1-5])(?:;|$)/);
    const userId = Number(cookie?.[1] || 1);
    req.session = { userId }; req.workspaceId = 'ws-' + userId; next();
  });
  app.get('/public/js/app-config.js', (req,res) => res.type('js').set('Cache-Control','no-store').send(
    'window.DCC_APP_TIME_ZONE="Etc/UTC";window.DCC_DELTA_SYNC_ENABLED=false;window.DCC_ACCOUNT_CONTEXT=' + JSON.stringify({userId:req.session.userId,workspaceId:req.workspaceId}) + ';'));
  app.post('/review/commitments/reset', route(async () => {
    await fixture.pool.query('TRUNCATE accountability_events,accountability_members,accountability_commitments');
    return { synthetic: true, reset: true };
  }));
  app.get('/api/me', route(async req => ({...(await fixture.pool.query('SELECT id,username FROM users WHERE id=$1',[req.session.userId])).rows[0], onboardingState:{dailyCommandCenterTour:{version:2,completedAt:'2026-01-01T00:00:00Z'}}})));
  app.get('/api/auth/me', route(async req => ({authenticated:true,user:(await fixture.pool.query('SELECT id,username FROM users WHERE id=$1',[req.session.userId])).rows[0]})));
  app.get('/api/health', (_req,res) => res.json({database:'ok',reviewOnly:true}));
  app.use(require('../lib/account-binding'));
  app.get('/api/social/users/lookup', route(async req => {
    const row = (await fixture.pool.query('SELECT id,username FROM users WHERE username=$1',[req.query.q])).rows[0];
    if (!row) throw Object.assign(new Error('Fictional account not found'),{statusCode:404}); return row;
  }));
  require('../routes/commitments')(app, {pool:fixture.pool,route});
  const cleanup = async () => { await fixture.cleanup(); process.exit(0); };
  process.once('SIGTERM',cleanup); process.once('SIGINT',cleanup);
};
