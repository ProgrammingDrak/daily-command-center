const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const path = require("node:path");
const {createActivityDb} = require("./test-support/activity-db");

test("day links persist, scope guest data and preserve nested contributions", {
  skip: !process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE,
}, async () => {
  const db = await createActivityDb();
  const day = "2026-11-08";
  const next = "2026-11-09";
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2uoAAAAASUVORK5CYII=";
  async function serve() {
    const app = express();
    app.use(express.json({limit:"5mb"}));
    app.use((req,_res,next) => {
      req.workspaceId = "ws-1";
      req.session = {userId:Number(req.get("x-test-user"))};
      next();
    });
    require("./routes/itinerary-shares").mount(app,db);
    app.use("/public",express.static(path.join(__dirname,"public")));
    const server = await new Promise(resolve => { const listener=app.listen(0,"127.0.0.1",()=>resolve(listener)); });
    return {base:"http://127.0.0.1:"+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
  }
  let server;
  try {
    for (const [id,date,publicVisibility] of [["coffee",day,"public"],["private",day,"private"],["next",next,"public"]]) {
      await db.blockDB.createBlock({id,type:"block",workspace_id:"ws-1",user_id:1,date,
        properties:{title:id,local_id:id,kind:"task",type:"task",start:"09:00",publicVisibility,detail:"private notes"}});
    }
    server = await serve();
    const request = (url,method="GET",body,user) => fetch(server.base+url,{method,
      headers:{"x-dcc-itinerary":"1","content-type":"application/json",...(user?{"x-test-user":String(user)}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request("/api/itinerary-shares/"+day,"POST",{},3)).status,403);
    const make = async date => {
      const response=await request("/api/itinerary-shares/"+date,"POST",{},1);
      assert.equal(response.status,200);
      return (await response.json()).key;
    };
    const token=await make(day);
    assert.equal(await make(day),token);
    const other=await make(next);
    assert.notEqual(token,other);
    const api="/api/public/itinerary/"+token;
    const read=async()=>request(api).then(res=>res.json());
    const initial=await read();
    assert.deepEqual(initial.stops.map(task=>task.id),["coffee"]);
    assert.equal(JSON.stringify(initial).includes("private notes"),false);
    const contribute=(action,extra={})=>request(api+"/contributions","POST",{action,blockId:"coffee",name:"Guest",text:"Hello",...extra});
    assert.equal((await contribute("comment",{blockId:"private"})).status,409);
    assert.equal((await contribute("comment",{blockId:"next"})).status,409);
    const first=await contribute("comment").then(res=>res.json());
    const parent=first.stops[0].comments[0].id;
    assert.equal((await contribute("comment",{parentId:parent,text:"Nested reply"})).status,201);
    assert.equal((await contribute("photo",{photo:png})).status,201);
    assert.equal((await contribute("photo",{blockId:null,photo:png})).status,201);
    await server.close();
    server=await serve();
    const restored=await read();
    assert.equal(restored.stops[0].comments[1].parentId,parent);
    assert.equal(restored.stops[0].photos.length,1);
    assert.equal(restored.photos.length,2);
    const src=restored.stops[0].photos[0].src;
        const photoResponse = await request(src);
    assert.equal(photoResponse.headers.get("content-type"),"image/png");
    assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()),Buffer.from(png.split(",")[1],"base64"));
    assert.equal((await request(src.replace(token,other))).status,404);
    const ownerDay = await request("/api/itinerary-journal-photos?date="+day,"GET",null,1);
    assert.equal((await ownerDay.json()).length,2);
    const ownerTask = await request("/api/itinerary-journal-photos?blockId=coffee","GET",null,1);
    assert.equal((await ownerTask.json()).length,1);
    assert.equal((await request("/api/itinerary-journal-photos?date="+day)).status,403);
    await db.pool.query("UPDATE blocks SET deleted_at=NOW() WHERE id='coffee'");
    const removed=await read();
    assert.equal(removed.removed[0].comments.length,2);
    assert.equal((await request(src)).status,404);
    await db.pool.query("UPDATE blocks SET deleted_at=NULL WHERE id='coffee'");
    assert.equal((await read()).stops[0].comments.length,2);
    await db.pool.query("UPDATE blocks SET properties=properties || '{\"publicVisibility\":\"private\"}'::jsonb WHERE id='coffee'");
    assert.equal((await request(src)).status,404);
    assert.deepEqual((await read()).stops,[]);
  } finally {
    if (server) await server.close();
    await db.close();
  }
});
