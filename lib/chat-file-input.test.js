const test = require("node:test");
const assert = require("node:assert/strict");
const { readChatFile } = require("./chat-file-input");

test("ChatGPT file input reads authenticated file parameters without redirects or DCC credentials", async () => {
  const file = {
    file_id: "file-fixture",
    file_name: "fixture.txt",
    download_url: "https://files.oaiusercontent.com/file-fixture?signature=fixture"
  };
  const result = await readChatFile(file, undefined, async (url, options) => {
    assert.equal(url.href, file.download_url);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers, undefined);
    return new Response("private fixture");
  });
  assert.equal(result.bytes.toString(), "private fixture");
  assert.equal(result.meta.mime, "text/plain");

  for (const bad of [
    "https://127.0.0.1/a",
    "https://files.oaiusercontent.com.example.org/a",
    "https://user@files.oaiusercontent.com/a",
    "http://files.oaiusercontent.com/a",
    "https://files.oaiusercontent.com:8443/a"
  ]) {
    await assert.rejects(
      readChatFile({ ...file, download_url: bad }, undefined, () => assert.fail("unexpected network call")),
      /unsupported/
    );
  }
  await assert.rejects(
    readChatFile(
      file,
      undefined,
      async () =>
        new Response("x", {
          headers: { "Content-Length": String(20 * 1024 * 1024) }
        })
    ),
    /10 MB/
  );
  await assert.rejects(
    readChatFile({ ...file, file_name: "fake.png" }, undefined, async () => new Response("not a PNG")),
    /matching contents/
  );
});
