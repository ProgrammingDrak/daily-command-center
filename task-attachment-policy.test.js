const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const policy = require("./lib/task-attachment-policy");
const { createStorage } = require("./lib/task-attachment-storage");
const txt = (name, bytes, mimetype = "text/plain") => ({ originalname: name, buffer: Buffer.from(bytes), mimetype });
test("validate actual type, filename, size and digest", () => {
  const clean = policy.validateFile(txt("../a\r\n.csv", "a,b\n1,2", "text/csv"));
  assert.equal(clean.filename, ".._a__.csv"); assert.equal(clean.size, 7); assert.equal(clean.mime, "text/csv"); assert.match(clean.sha256, /^[a-f0-9]{64}$/);
  for (const [name, bytes, mime] of [
    ["test.pdf", "%PDF-1.4\n%%EOF", "application/pdf"],
    ["test.png", Buffer.from([137,80,78,71,13,10,26,10,0]), "image/png"],
    ["test.jpg", Buffer.from([255,216,255,224,0]), "image/jpeg"],
    ["test.webp", "RIFFxxxxWEBP", "image/webp"],
    ["test.md", "# Fictional fixture", "text/markdown"],
  ]) assert.doesNotThrow(() => policy.validateFile(txt(name, bytes, mime)));
  for (const file of [txt("fake.pdf", "<script>evil</script>", "application/pdf"), txt("file.png", "wrong", "image/png"), txt("evil.svg", "<svg/>", "image/svg+xml"), txt("evil.html", "x", "text/html"), txt("bad.txt", [255,0]), txt("empty.txt", ""), txt("bad.txt", "a", "image/png")]) assert.throws(() => policy.validateFile(file));
  assert.throws(() => policy.validateFile(txt("huge.txt", Buffer.alloc(policy.MAX_BYTES + 1))), error => error.statusCode === 413);
});
test("opaque owner/task scoped keys refuse traversal, foreign ownership and invalid IDs", () => {
  const id = crypto.randomUUID(), actor = { userId: 1, workspaceId: "ws-1" };
  const key = policy.keyFor(1, "ws-1", "task", id);
  assert.ok(!key.includes("ws-1"));
  const row = { id, block_id: "task", object_key: key };
  assert.doesNotThrow(() => policy.assertKey(row, actor));
  for (const key of ["../secret", row.object_key + "/other", policy.keyFor(2, "ws-1", "task", id), policy.keyFor(1, "ws-2", "task", id), policy.keyFor(1, "ws-1", "other", id)]) assert.throws(() => policy.assertKey({ ...row, object_key: key }, actor));
  assert.throws(() => policy.keyFor(1, "ws-1", "task", "../bad"));
});
test("safe forced download disposition retains Unicode without header or path injection", () => {
  const out = policy.disposition('résumé\r\n"/test.pdf');
  assert.ok(!/[\r\n]/.test(out)); assert.match(out, /^attachment; filename="/); assert.match(out, /filename\*=UTF-8''r%C3%A9sum%C3%A9/);
});
test("storage is unavailable by default and does not reuse Vault/public credentials", async () => {
  const storage = createStorage({ MYCELIUM_R2_ACCESS_KEY_ID: "fixture", MYCELIUM_R2_SECRET_ACCESS_KEY: "fixture", MYCELIUM_R2_ENDPOINT: "https://example.invalid", R2_BUCKET: "public" });
  assert.equal(storage.configured, false);
  await assert.rejects(storage.put("x", Buffer.from("x"), "text/plain"), error => error.statusCode === 503);
  await assert.rejects(storage.get("x"), error => error.statusCode === 503);
});

test("S3 adapter uploads bytes without public ACLs and bounds protected retrieval", async t => {
  const objects = new Map();
  const server = http.createServer(async (req,res) => {
    assert.equal(req.headers['x-amz-acl'],undefined);
    const pathname = new URL(req.url,'http://fixture.invalid').pathname;
    if (req.method === 'PUT') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      objects.set(pathname,Buffer.concat(chunks)); res.setHeader('ETag','"fixture"'); res.end();
    } else if (objects.has(pathname)) { res.setHeader('Content-Type','text/plain');res.end(objects.get(pathname)); }
    else { res.statusCode=404;res.setHeader('Content-Type','application/xml');res.end('<Error><Code>NoSuchKey</Code><Message>Missing fixture</Message></Error>'); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const storage = createStorage({DCC_ATTACHMENT_ENDPOINT:`http://127.0.0.1:${server.address().port}`,DCC_ATTACHMENT_BUCKET:'private-fixture',DCC_ATTACHMENT_ACCESS_KEY_ID:'fictional-id',DCC_ATTACHMENT_SECRET_ACCESS_KEY:'fictional-secret'});
  assert.equal(storage.configured,true);
  const bytes=Buffer.from('Synthetic original'); await storage.put('task-attachments/fixture',bytes,'text/plain');
  assert.deepEqual(await storage.get('task-attachments/fixture'),bytes);
  await assert.rejects(storage.get('task-attachments/missing'),e=>e.statusCode===404);
  objects.set('/private-fixture/task-attachments/large',Buffer.alloc(policy.MAX_BYTES+1));
  await assert.rejects(storage.get('task-attachments/large'),e=>e.statusCode===502);
});
