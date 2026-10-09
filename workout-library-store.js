const W = require('./public/js/workout-model');
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workout_exercises (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, name_key TEXT NOT NULL, load_mode TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(workspace_id,owner_user_id,name_key)
);
CREATE TABLE IF NOT EXISTS workout_templates (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_user_id INTEGER NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, collection_name TEXT NOT NULL DEFAULT '', variant_name TEXT NOT NULL DEFAULT '', plan JSONB NOT NULL,
 source_template_id TEXT, source_session_id TEXT, revision INTEGER NOT NULL DEFAULT 1,
 archived_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workout_templates_owner ON workout_templates(workspace_id,owner_user_id);
ALTER TABLE task_activity_records ADD COLUMN IF NOT EXISTS last_mutation_id TEXT;
ALTER TABLE task_activity_records ADD COLUMN IF NOT EXISTS last_payload_hash TEXT;
`;
const fail=(s,n=400)=>{throw Object.assign(new Error(s),{statusCode:n});};
const name=(v,required=true)=>{if(typeof v!=='string'||v.length>160||(required&&!v.trim()))fail('A name of up to 160 characters is required');return v.trim();};
function shape(r){return {id:r.id,title:r.title,collection:r.collection_name,variant:r.variant_name,plan:r.plan,sourceTemplateId:r.source_template_id,sourceSessionId:r.source_session_id,revision:r.revision,archived:!!r.archived_at};}
async function readTemplate(q,id,owner){const {rows}=await q.query('SELECT * FROM workout_templates WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 AND archived_at IS NULL',[id,owner.workspaceId,owner.userId]);if(!rows[0])fail('Workout template not found',404);return rows[0];}
function sessionFromTemplate(t){const v=W.empty();v.plan=JSON.parse(JSON.stringify(t.plan));v.provenance={templateId:t.id,templateRevision:t.revision,templateName:t.title,collection:t.collection_name,variant:t.variant_name};return W.validate(v);}
async function checkCatalog(q,plan,owner){const custom=[...new Set(plan.exercises.map(e=>e.catalogExerciseId).filter(x=>x&&!W.CATALOG.some(e=>e.id===x)))];if(!custom.length)return;const {rows}=await q.query('SELECT id FROM workout_exercises WHERE workspace_id=$1 AND owner_user_id=$2 AND id=ANY($3::text[])',[owner.workspaceId,owner.userId,custom]);if(rows.length!==custom.length)fail('Exercise catalog item not found',404);}
function createWorkoutLibrary({pool,crypto=require('node:crypto')}){
  async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  async function catalog(owner){const {rows}=await pool.query('SELECT id,name,load_mode FROM workout_exercises WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY name',[owner.workspaceId,owner.userId]);return [...W.CATALOG.map(e=>({...e,builtin:true})),...rows.map(e=>({id:e.id,name:e.name,loadMode:e.load_mode,builtin:false}))];}
  async function createExercise(body,owner){const n=name(body.name),key=n.toLocaleLowerCase().replace(/\s+/g,' '),mode=body.loadMode||'total';W.measurement({loadMode:mode});if(W.CATALOG.some(e=>e.name.toLowerCase()===key))fail('This exercise already exists; choose it from the catalog',409);const {rows}=await pool.query(`INSERT INTO workout_exercises(id,workspace_id,owner_user_id,name,name_key,load_mode) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(workspace_id,owner_user_id,name_key) DO UPDATE SET name=workout_exercises.name RETURNING *`,[crypto.randomUUID(),owner.workspaceId,owner.userId,n,key,mode]);return {id:rows[0].id,name:rows[0].name,loadMode:rows[0].load_mode,builtin:false};}
  async function list(owner){const {rows}=await pool.query('SELECT * FROM workout_templates WHERE workspace_id=$1 AND owner_user_id=$2 AND archived_at IS NULL ORDER BY collection_name,title',[owner.workspaceId,owner.userId]);return rows.map(shape);}
  async function save(body,owner,id=null){const title=name(body.title),collection=name(body.collection||'',false),variant=name(body.variant||'',false),plan=W.normalizePlan(body.plan);return tx(async q=>{
    await checkCatalog(q,plan,owner);
    if(body.sourceTemplateId)await readTemplate(q,body.sourceTemplateId,owner);
    if(body.sourceSessionId){const {rows}=await q.query("SELECT task_id FROM task_activity_records WHERE task_id=$1 AND workspace_id=$2 AND owner_user_id=$3 AND task_type='workout'",[body.sourceSessionId,owner.workspaceId,owner.userId]);if(!rows.length)fail('Source workout not found',404);}
    if(id){const old=await readTemplate(q,id,owner);if(old.revision!==body.expectedRevision)fail('Template changed elsewhere. Reload before saving',409);const {rows}=await q.query(`UPDATE workout_templates SET title=$4,collection_name=$5,variant_name=$6,plan=$7,revision=revision+1,updated_at=NOW()
 WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 AND revision=$8 RETURNING *`,[id,owner.workspaceId,owner.userId,title,collection,variant,plan,body.expectedRevision]);if(!rows.length)fail('Template changed elsewhere',409);return shape(rows[0]);}
    const {rows}=await q.query(`INSERT INTO workout_templates(id,workspace_id,owner_user_id,title,collection_name,variant_name,plan,source_template_id,source_session_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[crypto.randomUUID(),owner.workspaceId,owner.userId,title,collection,variant,plan,body.sourceTemplateId||null,body.sourceSessionId||null]);return shape(rows[0]);
  });}
  return {catalog,createExercise,list,save,get:async(id,owner)=>shape(await readTemplate(pool,id,owner))};
}
module.exports={SCHEMA_SQL,createWorkoutLibrary,readTemplate,sessionFromTemplate,checkCatalog};
