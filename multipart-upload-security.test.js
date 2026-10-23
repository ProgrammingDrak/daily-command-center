"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const multer = require("multer");
const mountVault = require("./routes/vault");
const mountAttachments = require("./routes/task-attachments");

// Exercise real multipart parsing without sockets, production services, or
// expensive exploit payloads. All array indexes are at most 50, even if the
// security limit accidentally disappears in a later dependency upgrade.
const BOUNDARY = "dcc-upload-regression-boundary";
const UPLOAD_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const text = (name, value = "value") => ({ name, value });
const file = (name = "file", value = "fixture") => ({ name, value, filename: "fixture.txt" });

function request(parts, { truncated = false, ...overrides } = {}) {
  const chunks = [];
  for (const part of parts) {
    let disposition = "Content-Disposition: form-data";
    if (part.name !== null) disposition += `; name="${part.name}"`;
    if (part.filename) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${disposition}\r\n${part.filename ? "Content-Type: text/plain\r\n" : ""}\r\n`));
    chunks.push(Buffer.from(part.value), Buffer.from("\r\n"));
  }
  if (!truncated) chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  let reads = 0;
  const pending = [...chunks];
  const req = new Readable({ read() { reads++; this.push(pending.length ? pending.shift() : null); } });
  Object.assign(req, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "content-length": String(chunks.reduce((n, chunk) => n + chunk.length, 0)),
      "x-dcc-attachment": "1",
      "x-upload-id": UPLOAD_ID,
    },
    session: { userId: 1 },
    workspaceId: "ws-fixture",
    params: { blockId: "task-fixture" },
    readCount: () => reads,
  }, overrides);
  return req;
}

async function bounded(req, run) {
  let timer;
  try {
    return await Promise.race([
      new Promise(run),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Multipart fixture did not finish")), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
    req.destroy();
  }
}

function parse(upload, req) {
  return bounded(req, (resolve, reject) => {
    try { upload(req, {}, error => resolve(error)); }
    catch (error) { reject(error); }
  });
}

function mount(module, ctx) {
  const routes = new Map();
  const app = Object.fromEntries(["get", "post", "put", "delete"].map(method => [method, (path, ...handlers) => {
    routes.set(`${method} ${path}`, handlers.at(-1));
  }]));
  module(app, ctx);
  return path => {
    const handler = routes.get(`post ${path}`);
    assert.equal(typeof handler, "function", `Expected mounted POST ${path}`);
    return handler;
  };
}

function invoke(handler, req) {
  return bounded(req, (resolve, reject) => {
    let status = 200;
    const res = {
      set() { return this; },
      status(value) { status = value; return this; },
      json(body) { resolve({ status, body }); return this; },
      redirect(code, location) { resolve({ status: code, location }); return this; },
    };
    Promise.resolve().then(() => handler(req, res)).catch(reject);
  });
}

function vaultFixture({ admin = true } = {}) {
  const writes = [];
  const routes = mount(mountVault, {
    vault: { ready: true, has: () => false, write: async (...args) => { writes.push(args); return {}; } },
    isAdminSession: () => admin,
  });
  return { routes, writes };
}

test("Multer keeps ordinary fields and a file intact at exact part/file size limits", async () => {
  const req = request([text("title", "Fixture title"), text("transcript", "Line one\nLine two"), file("file", "12345678")]);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8, parts: 3, files: 1, fields: 2 } }).single("file");
  assert.ifError(await parse(upload, req));
  assert.equal(req.body.title, "Fixture title");
  assert.equal(req.body.transcript, "Line one\nLine two");
  assert.equal(req.file.originalname, "fixture.txt");
  assert.equal(req.file.mimetype, "text/plain");
  assert.equal(req.file.size, 8);
  assert.deepEqual(req.file.buffer, Buffer.from("12345678"));
});

test("Multer returns bounded upload/field/part limit errors to the caller", async t => {
  const cases = [
    ["file bytes", { fileSize: 8 }, [file("file", "123456789")], "LIMIT_FILE_SIZE"],
    ["file count", { files: 1 }, [file(), file()], "LIMIT_FILE_COUNT"],
    ["field count", { fields: 0 }, [text("title")], "LIMIT_FIELD_COUNT"],
    ["part count", { parts: 1 }, [text("title"), file()], "LIMIT_PART_COUNT"],
    ["field value", { fieldSize: 4 }, [text("title", "12345")], "LIMIT_FIELD_VALUE"],
    ["missing field name", {}, [text(null)], "MISSING_FIELD_NAME"],
  ];
  for (const [label, limits, parts, code] of cases) {
    await t.test(label, async () => {
      const error = await parse(multer({ storage: multer.memoryStorage(), limits }).any(), request(parts));
      assert.ok(error instanceof multer.MulterError);
      assert.equal(error.code, code);
    });
  }
});

test("a truncated multipart file reports an error rather than hanging", async () => {
  const error = await parse(multer({ storage: multer.memoryStorage() }).single("file"), request([file()], { truncated: true }));
  assert.ok(error instanceof Error);
  assert.match(error.message, /Unexpected end of form/);
});

test("every vault multipart route rejects excessive array indexes before any write", async t => {
  for (const path of ["/api/vault/attach", "/api/vault/journal-image-ingest", "/api/vault/notebook-page-ingest", "/api/vault/share"]) {
    await t.test(path, async () => {
      const h = vaultFixture();
      const req = request([text("evidence[50]"), text("evidence[label]", "never converted")]);
      const result = await invoke(h.routes(path), req);
      if (path.endsWith("/share")) {
        assert.deepEqual(result, { status: 303, location: "/?vault_share=err" });
      } else {
        assert.equal(result.status, 400);
        assert.match(result.body.error, /array index too large/i);
      }
      assert.equal(h.writes.length, 0);
      assert.equal(req.body.evidence, undefined, "reject the index before creating the sparse array");
    });
  }
});

test("vault accepts ordinary share fields and the maximum supported evidence index", async () => {
  const h = vaultFixture();
  const req = request([
    text("title", "Fixture"), text("text", "Shared text"), text("url", "https://example.com/fixture"),
    text("evidence[49]", "last"), text("tags[]", "first"), text("tags[]", "second"),
  ]);
  assert.deepEqual(await invoke(h.routes("/api/vault/share"), req), { status: 303, location: "/?vault_share=ok" });
  assert.equal(req.body.evidence.length, 50);
  assert.equal(req.body.evidence[49], "last");
  assert.deepEqual(req.body.tags, ["first", "second"]);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][1].body, "# Fixture\n\nShared text\n\nhttps://example.com/fixture");
});

test("vault malformed field names fail without a write and a later valid request still works", async () => {
  const h = vaultFixture();
  const result = await invoke(h.routes("/api/vault/journal-image-ingest"), request([text(null)]));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /field name missing/i);
  assert.equal(h.writes.length, 0);
  assert.equal((await invoke(h.routes("/api/vault/share"), request([text("text", "still usable")]))).location, "/?vault_share=ok");
  assert.equal(h.writes.length, 1);
});

test("notebook admin authorization happens before multipart is read", async () => {
  const h = vaultFixture({ admin: false });
  const req = request([text("evidence[50]")]);
  const result = await invoke(h.routes("/api/vault/notebook-page-ingest"), req);
  assert.equal(result.status, 403);
  assert.equal(req.readCount(), 0);
  assert.equal(req.body, undefined);
  assert.equal(h.writes.length, 0);
});

test("task and note uploads enforce session/ownership before reading multipart bytes", async t => {
  for (const path of ["/api/tasks/:blockId/attachments", "/api/notes/:blockId/attachments"]) {
    await t.test(path, async () => {
      let authorized = 0;
      let uploaded = 0;
      const routes = mount(mountAttachments, { taskAttachmentStore: {
        configured: true,
        authorize: async () => { authorized++; throw Object.assign(new Error("Not allowed"), { statusCode: 403 }); },
        upload: async () => { uploaded++; },
      } });
      const anonymous = request([file()], { session: {} });
      assert.equal((await invoke(routes(path), anonymous)).status, 401);
      assert.equal(anonymous.readCount(), 0);
      assert.equal(authorized, 0);
      const forbidden = request([file()]);
      assert.equal((await invoke(routes(path), forbidden)).status, 403);
      assert.equal(forbidden.readCount(), 0);
      assert.equal(authorized, 1);
      assert.equal(uploaded, 0);
    });
  }
});

test("task upload parser rejects unexpected parts, releases its slot, and stores a normal file", async () => {
  const writes = [];
  const routes = mount(mountAttachments, { taskAttachmentStore: {
    configured: true,
    authorize: async () => true,
    upload: async (...args) => { writes.push(args); return { id: UPLOAD_ID }; },
  } });
  const handler = routes("/api/tasks/:blockId/attachments");
  for (const parts of [[text("evidence[50]")], [file("wrong-field")], [file(), file()]]) {
    const rejected = await invoke(handler, request(parts));
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /one file per request/i);
    assert.equal(writes.length, 0);
  }
  assert.deepEqual(await invoke(handler, request([file()])), { status: 201, body: { id: UPLOAD_ID } });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][0], { userId: 1, workspaceId: "ws-fixture" });
  assert.equal(writes[0][1], "task-fixture");
  assert.equal(writes[0][2], UPLOAD_ID);
  assert.equal(writes[0][3].filename, "fixture.txt");
  assert.deepEqual(writes[0][4], Buffer.from("fixture"));
});

test("task uploads sanitize WHATWG-decoded multipart filenames before storage", async () => {
  const writes = [];
  const routes = mount(mountAttachments, { taskAttachmentStore: {
    configured: true,
    authorize: async () => true,
    upload: async (...args) => { writes.push(args); return { id: UPLOAD_ID }; },
  } });
  const req = request([{ ...file(), filename: "line%0Aname%22.txt" }]);
  assert.deepEqual(await invoke(routes("/api/tasks/:blockId/attachments"), req), { status: 201, body: { id: UPLOAD_ID } });
  assert.equal(req.file.originalname, "line\nname\".txt", "Multer decodes the browser's escaped header bytes");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][3].filename, "line_name_.txt", "only sanitized metadata reaches the attachment store");
  assert.deepEqual(writes[0][4], Buffer.from("fixture"));
});
