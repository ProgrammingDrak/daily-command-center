/* global FormData */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const { Blob } = require("node:buffer");
const { createFixtureDb } = require("./scripts/task-attachment-test-db.cjs");
const { createStore, SCHEMA_SQL } = require("./task-attachment-store");
const { validateFile, keyFor, MAX_FILES } = require("./lib/task-attachment-policy");
const actor = { userId: 1, workspaceId: "ws-1" };
const bytes = Buffer.from("Fictional confidential attachment\n");
const meta = validateFile({ originalname: "fixture.txt", mimetype: "text/plain", buffer: bytes });
test("private attachments: real transactions, protected routes, failure recovery and deletion", { skip: !(process.env.DCC_ATTACHMENT_TEST_DATABASE_URL || process.env.DCC_TEST_DATABASE_URL) }, async t => {
  const fixture = await createFixtureDb(); t.after(fixture.cleanup);
  const { pool } = fixture;
  const objects = new Map(); let failPut = false, puts = 0, gets = 0;
  const storage = { configured: true, async put(key, value) { puts++; if (failPut) throw new Error("Fixture storage unavailable"); objects.set(key, Buffer.from(value)); }, async get(key) { gets++; if (!objects.has(key)) throw Object.assign(new Error("Stored file missing"), { statusCode: 404 }); return objects.get(key); } };
  const store = createStore({ pool, storage });
  const id = crypto.randomUUID();
  await t.test("schema reruns safely and failed uploads leave recoverable reservations", async () => {
    await pool.query(SCHEMA_SQL); failPut = true;
    await assert.rejects(store.upload(actor, "task", id, meta, bytes), /storage unavailable/);
    const [pending] = await store.list(actor, "task"); assert.equal(pending.pending, true); assert.equal(pending.id, id);
    assert.equal(objects.size, 0); failPut = false;
    const saved = await store.upload(actor, "task", id, meta, bytes);
    assert.equal(saved.pending, false); assert.equal(objects.size, 1);
    assert.equal(saved.object_key, undefined); assert.equal(saved.url, undefined);
    assert.deepEqual((await store.download(actor, "task", id)).bytes, bytes);
  });
  await t.test("lost acknowledgements and concurrent duplicate retries do not duplicate files", async () => {
    const before = puts;
    await Promise.all([store.upload(actor,"task",id,meta,bytes),store.upload(actor,"task",id,meta,bytes)]);
    assert.equal(puts, before); assert.equal((await store.list(actor, "task")).length, 1);
    const concurrent = crypto.randomUUID(); await Promise.all([store.upload(actor,"task",concurrent,meta,bytes), store.upload(actor,"task",concurrent,meta,bytes)]);
    assert.equal((await pool.query("SELECT count(*) FROM task_attachments WHERE id=$1",[concurrent])).rows[0].count, "1");
    await assert.rejects(store.upload(actor,"task",id,{...meta,sha256:"different"},bytes), e=>e.statusCode===409);
  });
  await t.test("unrelated owners, same-workspace viewers and task swaps cannot read or mutate", async () => {
    const before = gets;
    for (const who of [{userId:2,workspaceId:"ws-2"},{userId:2,workspaceId:"ws-1"},{userId:3,workspaceId:"ws-1"},{userId:1,workspaceId:"ws-2"}]) {
      for (const op of [()=>store.list(who,"task"),()=>store.upload(who,"task",crypto.randomUUID(),meta,bytes),()=>store.download(who,"task",id),()=>store.remove(who,"task",id),()=>store.restore(who,"task",id)]) await assert.rejects(op(),e=>e.statusCode===404);
    }
    await assert.rejects(store.download(actor,"second",id),e=>e.statusCode===404);
    await assert.rejects(store.upload(actor,"root",crypto.randomUUID(),meta,bytes),e=>e.statusCode===404);
    assert.equal(gets,before);
  });
  await t.test("move preserves attachments; deleted parents deny access and undo restores it", async () => {
    await pool.query("UPDATE blocks SET date='2026-10-09' WHERE id='task'"); assert.equal((await store.list(actor,"task")).length,2);
    await pool.query("UPDATE blocks SET deleted_at=NOW() WHERE id='task'");
    await assert.rejects(store.download(actor,"task",id),e=>e.statusCode===404);
    await pool.query("UPDATE blocks SET deleted_at=NULL WHERE id='task'");
    assert.deepEqual((await store.download(actor,"task",id)).bytes,bytes);
  });
  await t.test("removal is idempotent and reversible, does not erase originals or resurrect on upload retry", async () => {
    await Promise.all([store.remove(actor,"task",id),store.remove(actor,"task",id)]);
    await assert.rejects(store.download(actor,"task",id),e=>e.statusCode===404);
    await assert.rejects(store.upload(actor,"task",id,meta,bytes),e=>e.statusCode===409);
    assert.equal(objects.has(keyFor(1,"ws-1","task",id)),true);
    await store.restore(actor,"task",id); await store.restore(actor,"task",id);
    assert.deepEqual((await store.download(actor,"task",id)).bytes,bytes);
  });
  await t.test("corrupt keys, missing originals and replaced bytes fail safely", async () => {
    const key = keyFor(1,"ws-1","task",id);
    await pool.query("UPDATE task_attachments SET object_key='../foreign' WHERE id=$1",[id]);
    await assert.rejects(store.download(actor,"task",id),e=>e.statusCode===404);
    await pool.query("UPDATE task_attachments SET object_key=$1 WHERE id=$2",[key,id]);
    objects.delete(key); await assert.rejects(store.download(actor,"task",id),e=>e.statusCode===404);
    objects.set(key,Buffer.alloc(bytes.length,0x41)); await assert.rejects(store.download(actor,"task",id),e=>e.statusCode===502); objects.set(key,bytes);
  });
  await t.test("independent quick and legacy notes have the same owner-scoped binary lifecycle", async () => {
    for (const parent of ["quick-note","legacy-note"]) {
      const noteId=crypto.randomUUID(); await store.upload(actor,parent,noteId,meta,bytes);
      assert.deepEqual((await store.download(actor,parent,noteId)).bytes,bytes);
      await assert.rejects(store.download({userId:2,workspaceId:"ws-1"},parent,noteId),e=>e.statusCode===404);
      await store.remove(actor,parent,noteId);await assert.rejects(store.download(actor,parent,noteId),e=>e.statusCode===404);
      await store.restore(actor,parent,noteId);assert.deepEqual((await store.download(actor,parent,noteId)).bytes,bytes);
      await pool.query("UPDATE blocks SET deleted_at=NOW() WHERE id=$1",[parent]);
      await assert.rejects(store.download(actor,parent,noteId),e=>e.statusCode===404);
      await pool.query("UPDATE blocks SET deleted_at=NULL WHERE id=$1",[parent]);
    }
  });
  await t.test("limits are serialized for concurrent files and quota includes retained originals", async () => {
    for(let n=2;n<MAX_FILES-1;n++) await store.upload(actor,"task",crypto.randomUUID(),meta,bytes);
    const results = await Promise.allSettled([store.upload(actor,"task",crypto.randomUUID(),meta,bytes),store.upload(actor,"task",crypto.randomUUID(),meta,bytes)]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1); assert.equal(results.find(r=>r.status==="rejected").reason.statusCode,409);
    await store.remove(actor,"task",id); await store.upload(actor,"task",crypto.randomUUID(),meta,bytes);
    await assert.rejects(store.restore(actor,"task",id),e=>e.statusCode===409);
    // Active files alone stay under 200 MB; only the removed originals push the owner over.
    const { rows: [{ active }] } = await pool.query("SELECT COUNT(*)::int AS active FROM task_attachments WHERE user_id=1 AND deleted_at IS NULL");
    const activeSize = Math.min(10485760, Math.floor((200 * 1024 * 1024 - 1024 * 1024) / (active + 1)));
    await pool.query("UPDATE task_attachments SET size=CASE WHEN deleted_at IS NULL THEN $1 ELSE 10485760 END",[activeSize]);
    const { rows: [{ activeBytes }] } = await pool.query("SELECT SUM(size)::bigint AS \"activeBytes\" FROM task_attachments WHERE user_id=1 AND deleted_at IS NULL");
    assert.ok(Number(activeBytes) + bytes.length <= 200 * 1024 * 1024);
    await assert.rejects(store.upload(actor,"second",crypto.randomUUID(),meta,bytes),e=>e.statusCode===409);
    await pool.query("UPDATE task_attachments SET size=$1",[bytes.length]);
  });
  await t.test("actual multipart routes authorize before upload, validate bytes and force safe downloads", async () => {
    const app = express(); app.use(express.json());
    app.use((req,_res,next)=>{req.session={userId:Number(req.headers['fixture-user'])||undefined};req.workspaceId=req.headers['fixture-workspace']||'ws-1';next();});
    require("./routes/task-attachments")(app,{taskAttachmentStore:store});
    const server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api/tasks/second/attachments`;
    const headers = {'fixture-user':'1','X-DCC-Attachment':'1','X-Upload-Id':crypto.randomUUID()};
    const form = (value=bytes,name='fixture.txt',type='text/plain')=>{const fd=new FormData();fd.append('file',new Blob([value],{type}),name);return fd;};
    assert.equal((await fetch(base)).status,401);
    assert.equal((await fetch(base,{headers:{'fixture-user':'2'}})).status,404);
    assert.equal((await fetch(base,{method:'POST',headers:{...headers,origin:'https://evil.example'},body:form()})).status,403);
    assert.equal((await fetch(base,{method:'POST',headers:{'fixture-user':'1'},body:form()})).status,403);
    assert.equal((await fetch(base,{method:'POST',headers,body:form('fake','fake.pdf','application/pdf')})).status,415);
    assert.equal((await fetch(base,{method:'POST',headers,body:form(Buffer.alloc(10485761),'huge.txt')})).status,413);
    const uploaded = await fetch(base,{method:'POST',headers,body:form()}); assert.equal(uploaded.status,201); const file=await uploaded.json();
    const response = await fetch(base+'/'+file.id+'/download',{headers:{'fixture-user':'1'}});
    assert.equal(response.status,200); assert.equal(response.headers.get('x-content-type-options'),'nosniff'); assert.match(response.headers.get('content-disposition'),/^attachment;/); assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    assert.equal((await fetch(base+'/'+file.id+'/download',{headers:{'fixture-user':'3'}})).status,404);
    assert.equal((await fetch(base+'/'+file.id,{method:'DELETE',headers})).status,200);
    assert.equal((await fetch(base+'/'+file.id+'/download',{headers})).status,404);
    assert.equal((await fetch(base+'/'+file.id+'/restore',{method:'POST',headers})).status,200);
    assert.equal((await fetch(base+'/not-a-uuid/download',{headers})).status,400);
    const noteBase=base.replace('/api/tasks/second/','/api/notes/quick-note/');
    const noteUpload=await fetch(noteBase,{method:'POST',headers:{...headers,'X-Upload-Id':crypto.randomUUID()},body:form()});assert.equal(noteUpload.status,201);
    const noteFile=await noteUpload.json();assert.equal((await fetch(noteBase+'/'+noteFile.id+'/download',{headers})).status,200);
    const unconfigured = createStore({pool,storage:{configured:false}});
    await assert.rejects(unconfigured.upload(actor,"second",crypto.randomUUID(),meta,bytes),e=>e.statusCode===503);
  });
});
