const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
test(
  "integration login, selected consent, immediate reductions, discovery and disconnect",
  { skip: !process.env.DCC_PGLITE_MODULE && !process.env.DCC_TEST_DATABASE_URL },
  async (t) => {
    const ctx = await require("./test-support/activity-db").createActivityDb();
    t.after(() => ctx.close());
    await ctx.pool.query(require("./conversation-store").FOREGROUND_INDEX_SQL);
    const bytesByKey = new Map();
    ctx.taskAttachmentStore = require("./task-attachment-store").createStore({
      pool: ctx.pool,
      storage: {
        configured: true,
        async put(key, bytes) {
          bytesByKey.set(key, bytes);
        },
        async get(key) {
          return bytesByKey.get(key);
        }
      }
    });
    const app = require("express")();
    app.use(require("express").json());
    app.use(
      require("express-session")({ secret: "synthetic-integration-test-only", resave: false, saveUninitialized: false })
    );
    app.post("/fixture/login", (req, res) => {
      req.session.userId = 1;
      req.session.workspaceId = "ws-1";
      req.session.username = "Test owner";
      res.end();
    });
    const { oauth } = require("./routes/conversation")(app, ctx, {
      enabled: true,
      baseUrl: "https://dcc.example",
      clients: { fixture: { name: "ChatGPT", redirect_uris: ["https://client.example/callback"] } }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;
    const call = (path, options = {}) => fetch(base + path, { redirect: "manual", ...options });
    assert.equal((await call("/connections/conversation")).status, 302);
    const signedOut = await call("/api/me/chat-connections");
    assert.equal(signedOut.status, 401);
    assert.match(signedOut.headers.get("content-type"), /json/);
    const login = await call("/fixture/login", { method: "POST" }),
      cookie = login.headers.get("set-cookie").split(";")[0];
    const request = async (path, body) =>
      call(path, {
        method: "POST",
        headers: { cookie, origin: "https://dcc.example", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body)
      });
    const legacy = await call("/connections/conversation", { headers: { cookie } });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/?settings=connections&connection=chatgpt");
    const api = await call("/api/me/chat-connections", { headers: { cookie } });
    const settings = await api.json();
    assert.deepEqual(
      settings.categories.map(({ id }) => id),
      require("./lib/chat-permissions").categories.map(({ id }) => id)
    );
    assert.deepEqual(settings.grants, []);
    assert.equal(settings.accountId, 1);
    assert.equal(api.headers.get("cache-control"), "no-store");
    const csrf = settings.csrf;
    let html;
    assert.equal(
      (await request("/connections/conversation/preferences", { csrf: "wrong", tasks: "write" })).status,
      403
    );
    assert.equal(
      (await request("/connections/conversation/preferences", { csrf, tasks: "write", repeats: "read" })).status,
      302
    );
    assert.deepEqual(await oauth.preferences({ userId: 1, workspaceId: "ws-1" }), [
      "dcc.tasks.read",
      "dcc.tasks.write",
      "dcc.repeats.read"
    ]);
    const staleAccount = await call("/connections/conversation/preferences", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://dcc.example",
        Accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ csrf, tasks: "write", expectedUserId: 2, expectedWorkspaceId: "ws-2" })
    });
    assert.equal(staleAccount.status, 409);
    const jsonSave = await call("/connections/conversation/preferences", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://dcc.example",
        Accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ csrf, tasks: "write", repeats: "read", expectedUserId: 1, expectedWorkspaceId: "ws-1" })
    });
    assert.equal(jsonSave.status, 200);
    assert.deepEqual(await jsonSave.json(), { ok: true });
    const verifier = crypto.randomBytes(32).toString("base64url");
    const params = {
      client_id: "fixture",
      redirect_uri: "https://client.example/callback",
      resource: "https://dcc.example/mcp/dcc",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      state: "test",
      scope:
        "dcc.tasks.read dcc.tasks.write dcc.repeats.read dcc.repeats.write dcc.itinerary.read dcc.itinerary.write dcc.files.read dcc.files.write dcc.calendar.read"
    };
    const authorize = "/oauth/dcc/authorize?" + new URLSearchParams(params);
    html = await (await call(authorize, { headers: { cookie } })).text();
    assert.match(html, /Allow selected access/);
    // Chosen subset rather than every requested permission becomes the grant.
    const response = await request("/oauth/dcc/authorize", {
      csrf,
      decision: "allow",
      tasks: "write",
      repeats: "off",
      itinerary: "write",
      files: "write",
      calendar: "read"
    });
    assert.equal(response.status, 302);
    const code = new URL(response.headers.get("location")).searchParams.get("code");
    const token = await oauth.token({
      client_id: "fixture",
      redirect_uri: params.redirect_uri,
      resource: params.resource,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier
    });
    assert.deepEqual(
      token.scope.split(" ").sort(),
      "dcc.tasks.read dcc.tasks.write dcc.itinerary.read dcc.itinerary.write dcc.files.read dcc.files.write dcc.calendar.read"
        .split(" ")
        .sort()
    );
    const rpc = async (method, name, args) => {
      const r = await call("/mcp/dcc", {
        method: "POST",
        headers: { authorization: "Bearer " + token.access_token, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: name ? { name, arguments: args || {} } : {} })
      });
      return { status: r.status, body: await r.json() };
    };
    let tools = (await rpc("tools/list")).body.result.tools.map((t) => t.name);
    assert.ok(tools.includes("dcc_tasks"));
    assert.ok(!tools.includes("dcc_repeats"));
    assert.ok(tools.includes("dcc_itinerary"));
    assert.ok(tools.includes("dcc_itinerary_write"));
    assert.ok(tools.includes("dcc_calendar_events"));
    const schemas = (await rpc("tools/list")).body.result.tools;
    const fileTool = schemas.find((entry) => entry.name === "dcc_attach_chat_file");
    assert.deepEqual(fileTool._meta["openai/fileParams"], ["file"]);
    assert.deepEqual(fileTool.securitySchemes, [{ type: "oauth2", scopes: ["dcc.files.write"] }]);

    const tool = async (name, args) => (await rpc("tools/call", name, args)).body.result;
    const date = "2026-11-16";
    const timeZone = "Asia/Tokyo";
    const create = (title, start, end, extra = {}, options = {}) => ({
      action: "create",
      sourceEventId: title,
      input: { title, date, start, end, timeZone, ...extra },
      ...options
    });
    const trip = [
      ["Hiroshima Station", "08:30", "09:00"],
      ["JR Sanyō Line to Miyajimaguchi", "09:00", "09:30"],
      ["JR West Miyajima Ferry", "09:40", "09:50"],
      ["Itsukushima Shrine", "10:05", "11:00"],
      ["Omotesando shopping street", "11:00", "12:45"],
      ["Daishō-in Temple", "13:00", "13:55"],
      ["Momijidani Park", "14:00", "15:00"],
      ["Return ferry and train", "15:30", "16:30"],
      ["Luggage pickup at Urbain Hiroshima Central", "17:00", "17:30"],
      ["Dinner with boss", "18:00", "20:00"]
    ];
    for (const [title, start, end] of trip) {
      const response = await tool("dcc_itinerary_write", create(title, start, end));
      assert.equal(response.structuredContent?.saveStatus, "verified_saved", JSON.stringify(response));
    }
    const trainRequest = create("Nozomi 108 to Shin-Osaka", "21:03", "22:28", {
      travel: {
        origin: "Hiroshima Station",
        destination: "Shin-Osaka",
        method: "Shinkansen",
        serviceNumber: "Nozomi 108",
        durationMinutes: 85,
        reservation: "Reserved"
      },
      location: { label: "Hiroshima Station" }
    });
    const trainResponses = await Promise.all([
      tool("dcc_itinerary_write", trainRequest),
      tool("dcc_itinerary_write", trainRequest)
    ]);
    assert.equal(trainResponses[0].structuredContent?.saveStatus, "verified_saved", JSON.stringify(trainResponses[0]));
    assert.deepEqual(trainResponses[0].structuredContent, trainResponses[1].structuredContent);
    const train = trainResponses[0].structuredContent.activity;
    assert.equal(train.startAt, "2026-11-16T12:03:00.000Z");
    const capcut = create("CapCut video journal", "21:10", "22:15", {
      detail:
        "Review footage. Remove filler. Combine worthwhile clips chronologically. Export at maximum practical quality. Verify and back up before deleting originals."
    });
    const conflict = await tool("dcc_itinerary_write", capcut);
    assert.equal(JSON.parse(conflict.content[0].text).code, "conflict");
    const intentional = await tool("dcc_itinerary_write", { ...capcut, allowOverlapWith: [train.id] });
    assert.equal(intentional.structuredContent?.saveStatus, "verified_saved");

    const read = async () =>
      (await tool("dcc_itinerary", { date, viewingZone: timeZone })).structuredContent.activities;
    const planned = await read();
    assert.equal(planned.length, 12);
    const dinner = planned.find((item) => item.title === "Dinner with boss");
    assert.equal(dinner.start, "18:00");
    assert.equal(dinner.status, "open");
    const edit = {
      action: "update",
      id: dinner.id,
      expectedVersion: dinner.version,
      sourceEventId: "dinner-location",
      input: {
        location: { label: "Fixture restaurant", address: "Hiroshima, Japan", latitude: 34.4, longitude: 132.46 }
      }
    };
    assert.equal(
      (await tool("dcc_itinerary_write", edit)).structuredContent.activity.location.label,
      "Fixture restaurant"
    );
    const stale = await tool("dcc_itinerary_write", { ...edit, sourceEventId: "stale-location" });
    assert.equal(JSON.parse(stale.content[0].text).code, "conflict");
    const park = planned.find((item) => item.title === "Momijidani Park");
    const move = {
      action: "schedule",
      id: park.id,
      expectedVersion: park.version,
      sourceEventId: "adjust-park",
      input: { date, timeZone, start: "14:10", end: "15:00" }
    };
    assert.equal(JSON.parse((await tool("dcc_itinerary_write", move)).content[0].text).code, "conflict");
    assert.equal(
      (await tool("dcc_itinerary_write", { ...move, moveFixed: true })).structuredContent.activity.start,
      "14:10"
    );

    const moveDinner = await tool("dcc_itinerary_write", {
      action: "schedule",
      id: dinner.id,
      expectedVersion: (await read()).find(({ id }) => id === dinner.id).version,
      sourceEventId: "fixture-cross-date",
      moveFixed: true,
      input: { date: "2026-11-17", timeZone, start: "18:00", end: "20:00" }
    });
    assert.equal(moveDinner.structuredContent?.activity.date, "2026-11-17");
    const marker = await ctx.blockDB.getRescheduleTombstone(date, dinner.id, "ws-1");
    assert.equal(marker.properties.rescheduledTo, "2026-11-17");
    assert.equal(marker.properties.publicVisibility, "private");

    const contenders = await Promise.all([
      tool("dcc_itinerary_write", create("Fixture contender A", "20:15", "20:30")),
      tool("dcc_itinerary_write", create("Fixture contender B", "20:15", "20:30"))
    ]);
    assert.equal(contenders.filter((result) => result.structuredContent?.saveStatus === "verified_saved").length, 1);
    assert.equal(
      contenders.filter((result) => result.isError && JSON.parse(result.content[0].text).code === "conflict").length,
      1
    );

    if (!process.env.DCC_PGLITE_MODULE) {
      const writer = await ctx.pool.connect();
      try {
        await writer.query("BEGIN");
        await ctx.blockDB.createBlock(
          {
            id: "fixture-concurrent-browser",
            workspace_id: "ws-1",
            user_id: 1,
            type: "block",
            date,
            properties: { title: "Concurrent browser entry", kind: "task", type: "task", start: "06:33", end: "06:41" }
          },
          writer
        );
        const pending = tool("dcc_itinerary_write", create("Blocked by browser entry", "20:33", "20:41"));
        const waitForQuery = async (pattern) => {
          for (let attempt = 0; attempt < 80; attempt++) {
            const { rows } = await ctx.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
              [pattern]
            );
            if (rows.length) return true;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        };
        const workloadWaiting = await waitForQuery("SELECT id FROM workspaces WHERE id=%");
        await writer.query("COMMIT");
        const conflict = await pending;
        assert.ok(workloadWaiting, "MCP waits for the competing workspace FK holder");
        assert.match(JSON.parse(conflict.content[0].text).error, /fixture-concurrent-browser/);

        const existing = await ctx.blockDB.createBlock({
          id: "fixture-browser-promotion",
          workspace_id: "ws-1",
          user_id: 1,
          type: "block",
          date: null,
          properties: { title: "Promoted from the browser", kind: "task", type: "task" }
        });
        await writer.query("BEGIN");
        await ctx.blockDB.updateBlock(
          existing.id,
          {
            date,
            properties: { ...existing.properties, start: "06:42", end: "06:49" }
          },
          writer
        );
        const edited = tool("dcc_itinerary_write", create("Blocked by existing browser edit", "20:42", "20:49"));
        const rowWaiting = await waitForQuery("SELECT count(*) FROM (SELECT id FROM blocks%FOR NO KEY UPDATE)%");
        await writer.query("COMMIT");
        const editConflict = await edited;
        assert.ok(rowWaiting, "MCP waits for a browser promotion from the undated pool");
        assert.match(JSON.parse(editConflict.content[0].text).error, /fixture-browser-promotion/);
      } catch (error) {
        await writer.query("ROLLBACK");
        throw error;
      } finally {
        writer.release();
      }
    }

    const provider = await ctx.blockDB.createBlock({
      id: "fixture-provider",
      workspace_id: "ws-1",
      user_id: 1,
      type: "block",
      date: "2026-11-10",
      properties: {
        title: "Synthetic provider hold",
        type: "meeting",
        kind: "meeting",
        source: "calendar",
        all_day: true,
        all_day_start: "2026-11-10",
        all_day_end: "2026-11-17"
      }
    });
    assert.ok((await read()).some((entry) => entry.id === provider.id && entry.calendarOwned));
    const allDayConflict = await tool("dcc_itinerary_write", create("Provider hold conflict", "20:45", "21:00"));
    assert.match(JSON.parse(allDayConflict.content[0].text).error, /fixture-provider/);
    const providerEdit = await tool("dcc_itinerary_write", {
      action: "update",
      id: provider.id,
      expectedVersion: (await read()).find(({ id }) => id === provider.id).version,
      sourceEventId: "provider-edit-denied",
      input: { title: "Do not rename" }
    });
    assert.match(JSON.parse(providerEdit.content[0].text).error, /source calendar/);
    assert.equal((await ctx.blockDB.getBlock(provider.id)).properties.title, "Synthetic provider hold");

    const taskResult = await tool("dcc_tasks", {
      action: "create",
      sourceEventId: "unscheduled-private",
      input: { title: "Unscheduled private task" }
    });
    const unscheduled = taskResult.structuredContent.task;
    const limited = { userId: 1, workspaceId: "ws-1", scopes: ["dcc.itinerary.read", "dcc.itinerary.write"] };
    const control = require("./chat-control-store").createChatControlStore(ctx);
    await assert.rejects(
      control.itineraryWrite(
        {
          action: "update",
          id: unscheduled.id,
          expectedVersion: unscheduled.version,
          sourceEventId: "private-update-denied",
          input: { title: "Do not rename" }
        },
        limited
      ),
      /Activity not found/
    );
    assert.ok(
      !(await control.itineraryRead({ date, viewingZone: timeZone }, limited)).activities.some(
        (entry) => entry.id === provider.id
      )
    );

    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE3cAAAAASUVORK5CYII=",
      "base64"
    );
    const upload = {
      action: "upload",
      taskId: train.id,
      id: crypto.randomUUID(),
      filename: "synthetic-ticket.png",
      mime: "image/png",
      base64: image.toString("base64")
    };
    const refused = await tool("dcc_attach_chat_file", {
      taskId: train.id,
      id: upload.id,
      filename: upload.filename,
      file: { file_id: "fixture", download_url: "http://127.0.0.1/private" }
    });
    assert.equal(JSON.parse(refused.content[0].text).code, "not_supported");
    const file = (await tool("dcc_files", upload)).structuredContent;
    assert.equal(file?.saveStatus, "verified_saved");
    assert.deepEqual((await tool("dcc_files", upload)).structuredContent, file);
    assert.equal(
      (await tool("dcc_files", { action: "download", taskId: train.id, id: file.id })).structuredContent.base64,
      upload.base64
    );
    assert.equal(bytesByKey.size, 1);
    assert.equal(
      (await tool("dcc_files", { ...upload, id: crypto.randomUUID(), mime: "application/pdf" })).isError,
      true
    );
    assert.equal((await tool("dcc_files", { action: "download", taskId: dinner.id, id: file.id })).isError, true);

    const completed = await tool("dcc_tasks", {
      action: "complete",
      id: park.id,
      expectedVersion: (await read()).find(({ id }) => id === park.id).version,
      sourceEventId: "reported-park-done"
    });
    assert.equal(completed.structuredContent?.saveStatus, "verified_saved", JSON.stringify(completed));
    assert.equal((await read()).find(({ id }) => id === park.id).status, "done");
    assert.equal((await ctx.blockDB.getBlock(park.id)).properties.completionTimeKnown, false);
    const completedAgain = await tool("dcc_tasks", {
      action: "complete",
      id: park.id,
      expectedVersion: (await read()).find(({ id }) => id === park.id).version,
      sourceEventId: "unintended-second-completion",
      input: { outcome: "Do not overwrite original outcome" }
    });
    assert.equal(JSON.parse(completedAgain.content[0].text).code, "conflict");
    const row = await ctx.blockDB.getBlock(train.id);
    const TaskModel = require("./public/js/task-model");
    assert.ok(TaskModel.foldsIntoItinerary(row));
    assert.equal(TaskModel.fromBlock(row, { deriveEnd: true }).start, "07:03");
    assert.equal(TaskModel.fromBlock(row, { deriveEnd: true }).end, "08:28");
    assert.equal(row.properties.publicVisibility, "private");
    assert.equal(row.properties.startedAt, undefined);
    assert.equal(row.properties.completedAt, undefined);
    assert.ok(!tools.includes("dcc_task"), "legacy all-data readers are not exposed");
    assert.equal((await rpc("tools/call", "dcc_repeats", { action: "list" })).status, 403);
    const status = (await rpc("tools/call", "dcc_connection_status")).body.result.structuredContent;
    assert.equal(status.status, "verified");
    const grant = (await oauth.list({ userId: 1, workspaceId: "ws-1" }))[0];
    assert.ok(grant.last_verified_at);
    assert.equal(
      (
        await request("/connections/conversation/permissions", {
          csrf,
          grantId: grant.id,
          tasks: "read",
          itinerary: "read",
          files: "read"
        })
      ).status,
      302
    );
    tools = (await rpc("tools/list")).body.result.tools.map((t) => t.name);
    assert.ok(!tools.includes("dcc_itinerary_write"));
    assert.ok(!tools.includes("dcc_attach_chat_file"));
    assert.ok(tools.includes("dcc_itinerary"));
    assert.ok(tools.includes("dcc_files"));
    assert.ok(!tools.includes("dcc_calendar_events"));
    assert.equal((await rpc("tools/call", "dcc_itinerary_write", trainRequest)).status, 403);
    const denied = await rpc("tools/call", "dcc_tasks", {
      action: "create",
      sourceEventId: "not-authorized",
      input: { title: "No" }
    });
    assert.equal(denied.body.result.isError, true);
    assert.equal(
      (await request("/connections/conversation/permissions", { csrf, grantId: grant.id, tasks: "write" })).status,
      409
    );
    assert.equal((await request("/connections/conversation/revoke", { csrf, grantId: grant.id })).status, 302);
    assert.equal((await rpc("tools/list")).status, 401);
  }
);
