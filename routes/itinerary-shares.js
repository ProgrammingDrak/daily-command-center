const { randomBytes, randomUUID } = require("node:crypto");
const path = require("node:path");
const { foldsIntoItinerary } = require("../public/js/task-model");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS itinerary_day_shares (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  UNIQUE (workspace_id, day)
);
CREATE TABLE IF NOT EXISTS itinerary_contributions (
  id UUID PRIMARY KEY,
  token TEXT NOT NULL REFERENCES itinerary_day_shares(token) ON DELETE CASCADE,
  block_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES itinerary_contributions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment','photo','like')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  image BYTEA,
  mime TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS itinerary_contributions_token ON itinerary_contributions(token, created_at);
`;
const tokenPattern = /^[a-f0-9]{48}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
function visible(row) {
  const p = row.properties || {};
  return foldsIntoItinerary(row) && p.publicVisibility === "public" && !p.guidedDefinitionId &&
    !p.retiredContainerHidden && !["workout","meal","guided"].includes(p.type) && typeof p.title === "string" && p.title.trim();
}
function imageData(photo) {
  const match = typeof photo === "string" && /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=]+)$/i.exec(photo);
  if (!match || match[2].length > 5_066_668) return null;
  const mime = match[1].toLowerCase();
  const image = Buffer.from(match[2], "base64");
  const hex = image.subarray(0, 8).toString("hex");
  const valid = mime === "image/png" ? hex === "89504e470d0a1a0a" :
    mime === "image/jpeg" ? hex.startsWith("ffd8ff") :
    mime === "image/gif" ? /^GIF8[79]a$/.test(image.toString("ascii",0,6)) :
    image.toString("ascii",0,4) === "RIFF" && image.toString("ascii",8,12) === "WEBP";
  return valid && image.length <= 3_800_000 ? {image,mime} : null;
}
function mount(app, {pool}) {
  const api = "/api/public/itinerary";
  const headers = res => res.set({"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Robots-Tag":"noindex, nofollow","X-Content-Type-Options":"nosniff"});
  const wrap = fn => async (req,res,next) => {
    headers(res);
    try { await fn(req,res); } catch (error) { next(error); }
  };
  const writeAllowed = req => req.get("x-dcc-itinerary") === "1" && req.get("sec-fetch-site") !== "cross-site";
  async function owner(req, db = pool) {
    const userId = Number(req.session?.userId);
    if (!Number.isSafeInteger(userId) || userId < 1 || !req.workspaceId) return false;
    return (await db.query("SELECT 1 FROM workspaces WHERE id=$1 AND owner_id=$2",[req.workspaceId,userId])).rows.length > 0;
  }
  async function share(token, db = pool, lock = false) {
    if (!tokenPattern.test(token)) return null;
    return (await db.query(`SELECT s.token,s.workspace_id,to_char(s.day,'YYYY-MM-DD') AS day,w.owner_id
      FROM itinerary_day_shares s JOIN workspaces w ON w.id=s.workspace_id WHERE s.token=$1${lock?" FOR UPDATE OF s":""}`,[token])).rows[0];
  }
  async function blocks(s, db = pool) {
    const {rows} = await db.query(`SELECT id,type,parent_id,properties FROM blocks
      WHERE workspace_id=$1 AND date=$2 AND deleted_at IS NULL AND (user_id IS NULL OR user_id=$3)
      ORDER BY sort_order,id`,[s.workspace_id,s.day,s.owner_id]);
    return rows.filter(visible);
  }
  function photoRow(token, row) {
    return {id:row.id,blockId:row.block_id,author:row.author,caption:row.body,src:api+"/"+token+"/media/"+row.id};
  }
  async function snapshot(s) {
    const rows = await blocks(s);
    const {rows: contributions} = await pool.query(`SELECT c.id,c.block_id,c.parent_id,c.kind,c.author,c.body,
        b.deleted_at IS NOT NULL AS deleted, b.properties->>'publicVisibility' AS visibility
      FROM itinerary_contributions c LEFT JOIN blocks b ON b.id=c.block_id AND b.workspace_id=$2
      WHERE c.token=$1 ORDER BY c.created_at,c.id`,[s.token,s.workspace_id]);
    const active = new Map(rows.map(row => {
      const p=row.properties;
      const time=value=>typeof value==="string" && /^\d{1,2}:\d{2}$/.test(value)?value:"";
      return [row.id,{id:row.id,localId:typeof p.local_id==="string"?p.local_id:row.id,title:p.title,time:time(p.start),end:time(p.end),done:p.done===true||p.status==="done",comments:[],likes:0,photos:[]}];
    }));
    const removed = new Map();
    const photos = [];
    for (const row of contributions) {
      const task = active.get(row.block_id);
      if (row.kind === "photo") {
        if (!row.block_id || task) {
          const photo = photoRow(s.token,row);
          photos.push(photo);
          task?.photos.push(photo);
        }
      } else if (row.kind === "like") {
        if (task) task.likes++;
      } else {
        let thread = task;
        if (!thread && row.deleted && row.visibility === "public") {
          if (!removed.has(row.block_id)) removed.set(row.block_id,{id:row.block_id,title:"Removed task",comments:[]});
          thread = removed.get(row.block_id);
        }
        thread?.comments.push({id:row.id,parentId:row.parent_id,name:row.author,text:row.body});
      }
    }
    return {date:s.day,stops:[...active.values()].sort((a,b)=>(a.time||"99").localeCompare(b.time||"99")),removed:[...removed.values()],photos};
  }
  app.get("/api/itinerary-shares/:date",wrap(async(req,res)=>{
    if (!validDate(req.params.date)) return res.sendStatus(400);
    if (!await owner(req)) return res.sendStatus(403);
    const {rows} = await pool.query("SELECT token FROM itinerary_day_shares WHERE workspace_id=$1 AND day=$2",[req.workspaceId,req.params.date]);
    res.json({key:rows[0]?.token||null});
  }));
  app.post("/api/itinerary-shares/:date",wrap(async(req,res)=>{
    if (!validDate(req.params.date)) return res.sendStatus(400);
    if (!writeAllowed(req) || !await owner(req)) return res.sendStatus(403);
    const {rows} = await pool.query(`INSERT INTO itinerary_day_shares(token,workspace_id,day) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,day) DO UPDATE SET day=EXCLUDED.day RETURNING token`,[randomBytes(24).toString("hex"),req.workspaceId,req.params.date]);
    res.json({key:rows[0].token});
  }));
  app.get("/api/itinerary-journal-photos",wrap(async(req,res)=>{
    if (!await owner(req)) return res.sendStatus(403);
    const {date,blockId}=req.query;
    if (blockId ? typeof blockId!=="string" || blockId.length>255 : typeof date!=="string" || !validDate(date)) return res.sendStatus(400);
    const {rows} = await pool.query(`SELECT s.token, to_char(s.day,'YYYY-MM-DD') AS day, s.workspace_id, w.owner_id
      FROM itinerary_day_shares s JOIN workspaces w ON w.id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.day=COALESCE($2::date,(
        SELECT date FROM blocks WHERE id=$3 AND workspace_id=$1 AND deleted_at IS NULL
      ))`,[req.workspaceId,blockId?null:date,blockId||null]);
    if (!rows.length) return res.json([]);
    const data = await snapshot(rows[0]);
    res.json(data.photos.filter(photo=>!blockId||photo.blockId===blockId));
  }));

  app.get("/shared-itinerary/:token",wrap(async(req,res)=>{
    if (!await share(req.params.token)) return res.sendStatus(404);
    res.set("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.sendFile(path.join(__dirname,"../public/shared-itinerary.html"));
  }));
  app.get(api+"/:token",wrap(async(req,res)=>{
    const s=await share(req.params.token);
    if (!s) return res.sendStatus(404);
    res.json(await snapshot(s));
  }));
  app.get(api+"/:token/media/:id",wrap(async(req,res)=>{
    const s=await share(req.params.token);
    if (!s || !uuidPattern.test(req.params.id)) return res.sendStatus(404);
    const {rows:[row]}=await pool.query("SELECT block_id,image,mime FROM itinerary_contributions WHERE token=$1 AND id=$2 AND kind='photo'",[s.token,req.params.id]);
    if (!row || (row.block_id && !(await blocks(s)).some(block=>block.id===row.block_id))) return res.sendStatus(404);
    res.type(row.mime).send(Buffer.from(row.image));
  }));
  app.post(api+"/:token/contributions",wrap(async(req,res)=>{
    if (!writeAllowed(req)) return res.sendStatus(403);
    const {action,blockId,name,text,parentId,photo}=req.body||{};
    if (!["comment","like","photo"].includes(action) ||
        (blockId != null && (typeof blockId!=="string" || blockId.length>255)) ||
        (action!=="photo" && !blockId) ||
        (parentId != null && (action!=="comment" || !uuidPattern.test(parentId))) ||
        (action!=="like" && (typeof name!=="string" || !name.trim() || name.trim().length>60)) ||
        (action!=="like" && (typeof text!=="string" || text.length>1000)) ||
        (action==="comment" && !text.trim())) return res.sendStatus(400);
    const media = action==="photo" ? imageData(photo) : null;
    if (action==="photo" && !media) return res.sendStatus(415);
    const db = await pool.connect();
    let committed = false;
    let s;
    try {
      await db.query("BEGIN");
      s=await share(req.params.token,db,true);
      if (!s) return res.sendStatus(404);
      if (blockId) {
        const {rows:[block]} = await db.query(`SELECT id,type,properties FROM blocks
          WHERE id=$1 AND workspace_id=$2 AND date=$3 AND deleted_at IS NULL AND (user_id IS NULL OR user_id=$4)
          FOR SHARE`,[blockId,s.workspace_id,s.day,s.owner_id]);
        if (!block || !visible(block)) return res.sendStatus(409);
      }
      if (parentId) {
        const parent = await db.query("SELECT id FROM itinerary_contributions WHERE id=$1 AND token=$2 AND block_id=$3 AND kind='comment'",[parentId,s.token,blockId]);
        if (!parent.rows.length) return res.sendStatus(409);
      }
      const {rows:[count]} = await db.query("SELECT COUNT(*)::int AS total FROM itinerary_contributions WHERE token=$1 AND kind=$2",[s.token,action]);
      if (count.total >= (action==="photo"?30:1000)) return res.sendStatus(409);
      await db.query(`INSERT INTO itinerary_contributions(id,token,block_id,parent_id,kind,author,body,image,mime)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),s.token,blockId||null,parentId||null,action,action==="like"?"":name.trim(),action==="like"?"":text.trim(),media?.image||null,media?.mime||null]);
      await db.query("COMMIT");
      committed=true;
    } finally {
      try { if (!committed) await db.query("ROLLBACK"); } finally { db.release(); }
    }
    res.status(201).json(await snapshot(s));
  }));
}
module.exports = {mount,SCHEMA_SQL,validDate,visible,imageData};
