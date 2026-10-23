// Modern shared suggestions are append-only proposals, never scheduled tasks.
// Serialize the append and its receipt so concurrent/lost-response retries are safe.
async function recordSuggestion({pool,share,date,item,requestKey,fingerprint,skeleton}) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:[active]}=await client.query('SELECT id FROM todo_shares WHERE id=$1 AND workspace_id=$2 AND active=TRUE FOR SHARE',[share.id,share.workspace_id]);
    if(!active){const e=new Error('Shared todo list is unavailable');e.statusCode=404;throw e;}
    // A per-share advisory lock handles an identical request retried across midnight
    // before either writer creates/locks the day's row.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shared-suggestion'),$1)",[share.id]);
    const {rows:[prior]}=await client.query('SELECT * FROM todo_task_suggestion_requests WHERE share_id=$1 AND request_key=$2',[share.id,requestKey]);
    if(prior){
      if(prior.fingerprint!==fingerprint){const e=new Error('This request was already used for a different suggestion');e.statusCode=409;throw e;}
      await client.query('COMMIT');return prior.item;
    }
    await client.query(`INSERT INTO dcc_state(date,workspace_id,user_id,state_json,updated_at)
      VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(date,workspace_id) DO NOTHING`,[date,share.workspace_id,share.owner_id||null,skeleton]);
    const {rows:[row]}=await client.query('SELECT state_json FROM dcc_state WHERE date=$1 AND workspace_id=$2 FOR UPDATE',[date,share.workspace_id]);
    const state=row.state_json;
    state.triage=state.triage||{open_items:[],resolved_items:[],cycle_count:0};
    if(!Array.isArray(state.triage.open_items))state.triage.open_items=[];
    const {rows:[count]}=await client.query('SELECT COUNT(*)::int AS n FROM todo_task_suggestion_requests WHERE share_id=$1 AND task_date=$2',[share.id,date]);
    if(count.n>=50 || state.triage.open_items.filter(i=>i&&i.source==='public_share').length>=50){const e=new Error('This list has reached its limit of guest-submitted tasks for the day');e.statusCode=429;throw e;}
    state.triage.open_items.push(item);
    if(state.sweep)state.sweep.open_item_count=state.triage.open_items.length;
    state.last_updated_at=new Date().toISOString();state.last_updated_by='public-todo-triage';
    await client.query('UPDATE dcc_state SET state_json=$3,updated_at=NOW() WHERE date=$1 AND workspace_id=$2',[date,share.workspace_id,state]);
    await client.query('INSERT INTO todo_task_suggestion_requests(share_id,request_key,fingerprint,task_date,item) VALUES($1,$2,$3,$4,$5)',[share.id,requestKey,fingerprint,date,item]);
    await client.query('COMMIT');return item;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
const SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS todo_task_suggestion_requests(
  share_id INTEGER NOT NULL REFERENCES todo_shares(id), request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,task_date DATE NOT NULL,item JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(share_id,request_key));
  CREATE INDEX IF NOT EXISTS idx_todo_suggestion_day ON todo_task_suggestion_requests(share_id,task_date);`;
module.exports={recordSuggestion,SCHEMA_SQL};
