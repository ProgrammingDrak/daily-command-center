const crypto = require('node:crypto');
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS friend_invite_links (
 id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
 action_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
 revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(owner_user_id,action_id)
);`;
const fail = (message, statusCode=400) => Object.assign(new Error(message),{statusCode});
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
function validateToken(token) { if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('Invite unavailable',404); return digest(token); }
function user(value) { if (!Number.isSafeInteger(Number(value)) || Number(value)<1) throw fail('Sign in first',401); return Number(value); }
function createStore({pool}) {
 async function tx(fn) { const q=await pool.connect();try{await q.query('BEGIN');const result=await fn(q);await q.query('COMMIT');return result;}catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();} }
 async function active(q,token,lock=false) {
  const row=(await q.query(`SELECT i.*,u.username FROM friend_invite_links i JOIN users u ON u.id=i.owner_user_id WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW()${lock?' FOR UPDATE OF i':''}`,[validateToken(token)])).rows[0];
  if(!row) throw fail('Invite unavailable or expired. Ask for a new link.',404);return row;
 }
 async function create(owner,input) {
  const ownerId=user(owner), hash=validateToken(input.token);
  if(typeof input.actionId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.actionId))throw fail('A stable action ID is required');
  return tx(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`friend-invite:${ownerId}:${input.actionId}`]);
   const old=(await q.query('SELECT id,token_hash,expires_at,revoked_at FROM friend_invite_links WHERE owner_user_id=$1 AND action_id=$2',[ownerId,input.actionId])).rows[0];
   if(old){if(old.token_hash!==hash)throw fail('Action ID already used',409);if(old.revoked_at||new Date(old.expires_at)<=new Date())throw fail('Invite unavailable',404);return {id:old.id,expiresAt:old.expires_at,path:'/friend-invite/'+input.token};}
   const row=(await q.query('INSERT INTO friend_invite_links(id,owner_user_id,action_id,token_hash) VALUES($1,$2,$3,$4) RETURNING id,expires_at',[crypto.randomUUID(),ownerId,input.actionId,hash])).rows[0];
   return {id:row.id,expiresAt:row.expires_at,path:'/friend-invite/'+input.token};
  });
 }
 async function list(owner) {return (await pool.query('SELECT id,expires_at,revoked_at,created_at FROM friend_invite_links WHERE owner_user_id=$1 ORDER BY created_at DESC',[user(owner)])).rows;}
 async function revoke(owner,id) {const row=(await pool.query('UPDATE friend_invite_links SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND owner_user_id=$2 RETURNING id',[id,user(owner)])).rows[0];if(!row)throw fail('Invite unavailable',404);return row;}
 async function preview(token,viewer) {
  const row=await active(pool,token);
  return {username:row.username,expiresAt:row.expires_at,signedIn:!!viewer,sessionUserId:viewer?Number(viewer):null,self:Number(viewer)===row.owner_user_id};
 }
 async function accept(recipient,token) {
  const recipientId=user(recipient);
  return tx(async q=>{
   const row=await active(q,token,true),owner=row.owner_user_id;
   if(owner===recipientId)throw fail('This is your invite link. Share it with someone else.');
   await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`friend-pair:${Math.min(owner,recipientId)}:${Math.max(owner,recipientId)}`]);
   const edges=(await q.query('SELECT * FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1) FOR UPDATE',[owner,recipientId])).rows;
   if(edges.some(e=>e.status==='blocked'))throw fail('This relationship is unavailable',403);
   if(edges.some(e=>e.status==='accepted'))return {username:row.username,accepted:true,alreadyFriends:true};
   // Creating the link records the inviter's intent; this explicit add is the
   // recipient's consent. It grants friendship only, never task/day access.
   const existing=edges[0];
   if(existing)await q.query("UPDATE friendships SET status='accepted',updated_at=NOW() WHERE requester_id=$1 AND addressee_id=$2",[existing.requester_id,existing.addressee_id]);
   else await q.query("INSERT INTO friendships(requester_id,addressee_id,status) VALUES($1,$2,'accepted')",[owner,recipientId]);
   return {username:row.username,accepted:true,alreadyFriends:false};
  });
 }
 return {create,list,revoke,preview,accept};
}
module.exports={SCHEMA_SQL,createStore};
