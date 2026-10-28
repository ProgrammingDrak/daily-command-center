// Successor of the manual rotation suite: the UI and MCP share this coordinator.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { createConversationStore, FOREGROUND_INDEX_SQL } = require("./conversation-store");
const owner = { userId: 1, workspaceId: "ws-1" },
  uid = () => crypto.randomUUID();
test(
  "Working Queue: durable order, atomic rotation, safeguards and reminders",
  { skip: !process.env.DCC_TEST_DATABASE_URL && !process.env.DCC_PGLITE_MODULE },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    const original = process.env.DCC_CONVERSATION_ENABLED;
    process.env.DCC_CONVERSATION_ENABLED = "true";
    t.after(async () => {
      if (original === undefined) delete process.env.DCC_CONVERSATION_ENABLED;
      else process.env.DCC_CONVERSATION_ENABLED = original;
      await ctx.close();
    });
    await ctx.pool.query(FOREGROUND_INDEX_SQL);
    // Fixed daytime clock: row-count assertions must not depend on crossing UTC midnight.
    let now = Date.parse("2026-10-20T08:00:00Z");
    const store = createConversationStore({ ...ctx, now: () => now, APP_TIME_ZONE: "UTC" });
    const make = (id, properties = {}) =>
      ctx.blockDB.createBlock({
        id,
        type: "block",
        date: "2026-10-20",
        user_id: 1,
        workspace_id: "ws-1",
        properties: { local_id: id, type: "task", title: id, status: "open", duration: 30, ...properties }
      });
    const body = async (action, taskId, extra = {}) => ({
      action,
      ...(taskId ? { taskId } : {}),
      sourceEventId: uid(),
      at: new Date(now).toISOString(),
      expectedRevision: (await store.state(owner)).revision,
      ...extra
    });
    const send = async (action, id, extra = {}) => store.execute(await body(action, id, extra), owner);
    const row = (id) => ctx.blockDB.getBlock(id),
      entry = async (id) => (await store.state(owner)).queue.items.find((i) => i.task.id === id);
    await make("a", { subtaskOf: "umbrella" });
    await make("b");
    await make("c");
    await make("unknown");
    await t.test("add, order, retained context never change nesting, schedule or start clocks", async () => {
      await send("queue-add", "a");
      await send("queue-add", "b");
      await send("queue-add", "c");
      await send("queue-note", "a", { note: "Next: verify the source" });
      await send("queue-reorder", null, { order: ["c", "a", "b"] });
      assert.deepEqual((await store.state(owner)).queue.order, ["c", "a", "b"]);
      assert.equal((await row("a")).properties.startedAt, undefined);
      assert.equal((await row("a")).properties.subtaskOf, "umbrella");
      assert.equal((await row("a")).date, "2026-10-20");
      await assert.rejects(send("queue-reorder", null, { order: ["a", "a", "b"] }), { statusCode: 409 });
    });
    await t.test("repeated switches record only focused intervals; retries cannot restore stale tasks", async () => {
      await send("start", "a");
      now += 10 * 60000;
      const switchBody = await body("start", "b", { remindMinutes: 5 });
      await store.execute(switchBody, owner);
      assert.equal((await row("a")).properties.actualMinutes, 10);
      assert.equal((await entry("a")).note, "Next: verify the source");
      now += 2 * 60000;
      await send("start", "a", { remindMinutes: 1 });
      now += 3 * 60000;
      await send("start", "c");
      assert.equal((await row("a")).properties.actualMinutes, 13);
      assert.equal((await row("b")).properties.actualMinutes, 2);
      const retry = await store.execute(switchBody, owner);
      assert.equal(retry.duplicate, true);
      assert.equal(retry.affectedTasks.find((r) => r.id === "b").properties.startedAt, undefined);
      assert.equal(retry.currentState.foreground[0].id, "c");
      assert.equal((await row("a")).properties.duration, 30);
    });
    await t.test("simultaneous switches serialize with one winner and one ledger segment", async () => {
      now += 60000;
      const a = await body("start", "a"),
        b = { ...a, taskId: "b", sourceEventId: uid() };
      const outcomes = await Promise.allSettled([store.execute(a, owner), store.execute(b, owner)]);
      assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(outcomes.find((x) => x.status === "rejected").reason.statusCode, 409);
      assert.equal((await store.state(owner)).foreground.length, 1);
      assert.equal((await ctx.blockDB.getTaskTimeEntries("c", "ws-1")).length, 1);
    });
    await t.test("durable due claims, snooze generations, dismissal, completion and deletion", async () => {
      now += 60000;
      const active = (await store.state(owner)).foreground[0].id;
      await send("background-start", active, { remindMinutes: 1 });
      now += 2 * 60000;
      const first = await entry(active),
        claim = await body("queue-claim", active, { generation: first.generation });
      const bodies=[claim,{...claim,sourceEventId:uid()}];
      const outcomes = await Promise.allSettled(bodies.map(body=>store.execute(body,owner)));
      assert.equal(outcomes.filter((x) => x.status === "fulfilled" && x.value.claimed).length, 1);
      assert.equal((await store.execute(bodies[outcomes.findIndex(x=>x.status==="fulfilled")], owner)).claimed, false);
      assert.ok(
        (await createConversationStore(ctx).state(owner)).queue.items.find((i) => i.task.id === active).notifiedAt
      );
      await send("queue-snooze", active, { generation: first.generation, remindMinutes: 5 });
      const snoozed = await entry(active);
      assert.notEqual(snoozed.generation, first.generation);
      await assert.rejects(send("queue-dismiss", active, { generation: first.generation }), { statusCode: 409 });
      await send("queue-dismiss", active, { generation: snoozed.generation });
      assert.equal((await entry(active)).dueAt, null);
      assert.equal((await entry(active)).status, "background");
      await send("background-start", active, { remindMinutes: 1 });
      const old = await entry(active);
      await send("done", active);
      assert.equal((await entry(active)).needsYou, false);
      await ctx.blockDB.setTaskCompletion({
        taskRef: active,
        completed: false,
        mutationId: uid(),
        expectedRevision: (await row(active)).properties._completionRevision,
        userId: 1,
        workspaceId: "ws-1"
      });
      assert.equal((await entry(active)).status, "paused");
      await assert.rejects(send("queue-claim", active, { generation: old.generation }), { statusCode: 409 });
      await send("background-start", active, { remindMinutes: 1 });
      await ctx.blockDB.deleteBlock(active);
      assert.equal(await entry(active), undefined);
      await send("queue-note", "c", { note: "reconcile deleted records" });
      assert.ok(!(await store.state(owner)).queue.order.includes(active));
    });
    await t.test("sleep cutoff, blocked state and unknown actuals", async () => {
      await send("start", "c");
      now += 3 * 3600000;
      const paused = await send("queue-block", "c", { remindMinutes: 30 });
      assert.equal((await row("c")).properties.actualMinutes, 51);
      assert.equal(paused.uncertainIntervals.length, 1);
      assert.equal((await entry("c")).status, "blocked");
      await send("queue-unblock", "c");
      assert.equal((await entry("c")).status, "queued");
      assert.equal((await entry("c")).dueAt, null);
      await send("done", "unknown");
      assert.equal((await entry("unknown")).actualMinutes, null);
      assert.equal((await row("unknown")).properties.actualTimeUnknown, true);
    });
    await t.test("legacy metadata adopts additively and rejects revived reminders", async () => {
      await make("legacy", { workStateOperationId: "pause-old", _completionRevision: "new-completion" });
      const qowner = { userId: 2, workspaceId: "ws-2" };
      await ctx.blockDB.createBlock({
        id: "legacy-other",
        type: "block",
        user_id: 2,
        workspace_id: "ws-2",
        properties: { type: "task", title: "legacy", workStateOperationId: "pause-old" }
      });
      await ctx.pool.query("INSERT INTO work_rotations(workspace_id,user_id,state) VALUES($1,$2,$3)", [
        "ws-2",
        2,
        {
          background: {
            "legacy-other": {
              pausedOperationId: "pause-old",
              dueAt: new Date(now - 60000).toISOString(),
              generation: "old-gen"
            }
          },
          operations: []
        }
      ]);
      const adopted = await store.state(qowner);
      assert.equal(adopted.queue.items[0].status, "background");
      assert.equal(adopted.queue.items[0].needsYou, true);
      await store.execute(
        {
          action: "queue-note",
          taskId: "legacy-other",
          note: "adopted",
          sourceEventId: uid(),
          at: new Date(now).toISOString(),
          expectedRevision: 0
        },
        qowner
      );
      const saved = (await ctx.pool.query("SELECT state FROM work_rotations WHERE user_id=2")).rows[0].state;
      assert.equal(saved.version, 2);
      assert.ok(saved.background["legacy-other"]);
      await assert.rejects(send("queue-add", "legacy-other"), { statusCode: 404 });
      await assert.rejects(store.state({ userId: 3, workspaceId: "ws-1" }), { statusCode: 403 });
    });
    await t.test("guided start and completion keep preview revision and prerequisite guards", async () => {
      const guided = require("./guided-store").createGuidedStore({ ...ctx, APP_TIME_ZONE: "UTC" });
      const definition = await guided.saveDefinition(
        {
          id: uid(),
          expectedRevision: 0,
          definition: {
            title: "Review",
            goal: "Confirm sources",
            starterPrompt: "Read the source",
            completionCriteria: "Confirmed outcome",
            checklist: []
          }
        },
        owner
      );
      let view = await guided.createTask({ id: uid(), definitionId: definition.id, date: "2026-10-20" }, owner);
      await assert.rejects(send("start", view.taskId), { statusCode: 409 });
      const preview = (v) => ({
        expectedRevision: v.revision,
        expectedDefinitionRevision: v.definitionRevision,
        expectedContextVersion: v.contextVersion
      });
      await send("start", view.taskId, { guided: preview(view) });
      view = await guided.get(view.taskId, owner);
      now += 60000;
      await assert.rejects(
        send("done", view.taskId, {
          guided: { ...preview(view), expectedRevision: 0, outcome: "confirmed", confirmed: true }
        }),
        { statusCode: 409 }
      );
      assert.ok((await row(view.taskId)).properties.startedAt, "failed outcome transaction rolled back its pause");
      await send("done", view.taskId, { guided: { ...preview(view), outcome: "confirmed", confirmed: true } });
      assert.equal((await guided.get(view.taskId, owner)).session.state, "completed");
      assert.equal((await row(view.taskId)).properties.actualMinutes, 1);
    });
    await t.test("recurring queue completion drains cadence only after commit and retries safely",async()=>{
      await make('repeat-task',{responsibilityId:'repeat-def'});
      await ctx.blockDB.createBlock({id:'repeat-def',type:'block',user_id:1,workspace_id:'ws-1',properties:{kind:'responsibility_item',title:'Recurring work',cadence:'weekly',lastCompletedAt:'2026-10-01T12:00:00Z',openInstanceBlockId:'repeat-task',openInstanceId:'repeat-task',openInstanceDate:'2026-10-20'}});
      const command=await body('done','repeat-task');await store.execute(command,owner);
      let definition=await row('repeat-def');assert.equal(definition.properties.lastCompletedTaskId,'repeat-task');assert.equal(definition.properties.openInstanceBlockId,undefined);
      const timestamp=definition.properties.lastCompletedAt;
      await store.execute(command,owner);definition=await row('repeat-def');assert.equal(definition.properties.lastCompletedAt,timestamp);assert.equal(definition.properties.previousCompletedAt,'2026-10-01T12:00:00Z','retry does not replace the cadence undo value');
      assert.equal((await row('repeat-task')).properties.actualMinutes,undefined);
    });
    await t.test("guided recurring completion returns without waiting on its own row lock",{timeout:5000},async()=>{
      const guided=require('./guided-store').createGuidedStore({...ctx,APP_TIME_ZONE:'UTC'});
      const spec=await guided.saveDefinition({id:uid(),expectedRevision:0,definition:{title:'Recurring guided',goal:'Confirm source',starterPrompt:'Read source',completionCriteria:'Confirm outcome',checklist:[]}},owner);
      const preview=v=>({expectedRevision:v.revision,expectedDefinitionRevision:v.definitionRevision,expectedContextVersion:v.contextVersion});
      for(const repeatType of ['cadence','scheduled']) {
        let view=await guided.createTask({id:uid(),definitionId:spec.id,date:'2026-10-20'},owner);
        const defId=uid(),task=await row(view.taskId);
        await ctx.blockDB.createBlock({id:defId,type:'block',user_id:1,workspace_id:'ws-1',properties:{kind:'responsibility_item',title:'Guided cadence',repeatType,cadence:'weekly',openInstanceBlockId:task.id}});
        await ctx.blockDB.updateBlock(task.id,{properties:{...task.properties,responsibilityId:defId}});
        view=await guided.get(task.id,owner);await send('start',task.id,{guided:preview(view)});now+=60000;view=await guided.get(task.id,owner);
        await send('done',task.id,{guided:{...preview(view),confirmed:true,outcome:'Source confirmed'}});
        assert.equal((await guided.get(task.id,owner)).session.state,'completed');
        const definition=await row(defId);
        if(repeatType==='cadence')assert.equal(definition.properties.lastCompletedTaskId,task.id);
        else assert.equal(definition.properties.openInstanceBlockId,task.id,'scheduled series is not reset by completion');
      }
    });
    await t.test("invalid and future acknowledgements use the shared unattended cutoff",async()=>{
      for(const acknowledgement of ['invalid',new Date(now+86400000).toISOString()]) {
        const id=uid();await make(id);await send('start',id);
        await ctx.pool.query("UPDATE blocks SET properties=properties || $2::jsonb WHERE id=$1",[id,{workCheckInAt:acknowledgement}]);
        now+=3*3600000;const continued=await send('continue',id);
        assert.equal(continued.task.properties.actualMinutes,50);assert.equal(continued.task.properties.startedAt,new Date(now).toISOString());
        assert.equal(continued.entries.length,1,'event stores only the new session rows');
        now+=60000;const paused=await send('pause',id);assert.equal(paused.entries.length,1);assert.equal(paused.task.properties.actualMinutes,51);
      }
    });

    await t.test("normal and replay propagation release the coordinator pool slot first",async()=>{
      let leased=0,propagated=0;
      const observed=createConversationStore({...ctx,now:()=>now,pool:{query:(...args)=>ctx.pool.query(...args),connect:async()=>{
        const q=await ctx.pool.connect();leased++;return {query:(...args)=>q.query(...args),release:()=>{leased--;q.release();}};
      }},blockDB:{...ctx.blockDB,propagateResponsibilityDone:async transition=>{
        assert.equal(leased,0,'cadence side effects must not retain the coordinator pool slot');propagated++;return ctx.blockDB.propagateResponsibilityDone(transition);
      }}});
      await make('release-slot',{responsibilityId:'release-def'});
      await ctx.blockDB.createBlock({id:'release-def',type:'block',user_id:1,workspace_id:'ws-1',properties:{kind:'responsibility_item',title:'Pool test',cadence:'weekly',openInstanceBlockId:'release-slot'}});
      const command=await body('done','release-slot');await observed.execute(command,owner);await observed.execute(command,owner);
      assert.equal(propagated,2);assert.equal(leased,0);assert.equal((await row('release-def')).properties.lastCompletedTaskId,'release-slot');
    });

  }
);
