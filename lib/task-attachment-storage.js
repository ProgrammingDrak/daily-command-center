// Separate namespace and private bucket. No Vault credentials or public URLs.
const { fail, MAX_BYTES } = require("./task-attachment-policy");
function createStorage(env = process.env) {
  const keys = ["DCC_ATTACHMENT_ENDPOINT", "DCC_ATTACHMENT_BUCKET", "DCC_ATTACHMENT_ACCESS_KEY_ID", "DCC_ATTACHMENT_SECRET_ACCESS_KEY"];
  const configured = keys.every(k => !!env[k]);
  let client;
  function sdk() {
    if (!configured) throw fail("Private task/note file storage is not configured", 503);
    const s3 = require("@aws-sdk/client-s3");
    if (!client) client = new s3.S3Client({
      endpoint: env.DCC_ATTACHMENT_ENDPOINT, region: env.DCC_ATTACHMENT_REGION || "auto", forcePathStyle: env.DCC_ATTACHMENT_FORCE_PATH_STYLE !== "0",
      credentials: { accessKeyId: env.DCC_ATTACHMENT_ACCESS_KEY_ID, secretAccessKey: env.DCC_ATTACHMENT_SECRET_ACCESS_KEY },
      requestHandler: { requestTimeout: 60000, connectionTimeout: 5000 }, maxAttempts: 2,
    });
    return s3;
  }
  return {
    configured,
    async put(key, bytes, mime) {
      const { PutObjectCommand } = sdk();
      await client.send(new PutObjectCommand({ Bucket: env.DCC_ATTACHMENT_BUCKET, Key: key, Body: bytes, ContentType: mime }));
    },
    async get(key) {
      const { GetObjectCommand } = sdk();
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: env.DCC_ATTACHMENT_BUCKET, Key: key }));
        // Bound buffering even if a stored object was replaced outside the app.
        const chunks = []; let size = 0;
        for await (const chunk of result.Body) {
          size += chunk.length;
          if (size > MAX_BYTES) { result.Body.destroy(); throw fail("Attachment unavailable", 502); }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } catch (error) {
        if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) throw fail("Stored file is missing", 404);
        throw error;
      }
    },
  };
}
module.exports = { createStorage };
