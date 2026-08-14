"use strict";

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

let cachedClient = null;
let cachedSignature = null;

function configFromEnv(env = process.env) {
  if (!env.MYCELIUM_R2_ACCESS_KEY_ID || !env.MYCELIUM_R2_SECRET_ACCESS_KEY || !env.MYCELIUM_R2_ENDPOINT) return null;
  return {
    accessKeyId: env.MYCELIUM_R2_ACCESS_KEY_ID,
    secretAccessKey: env.MYCELIUM_R2_SECRET_ACCESS_KEY,
    endpoint: env.MYCELIUM_R2_ENDPOINT,
    region: env.MYCELIUM_R2_REGION || "auto",
    bucket: env.MEETING_AUDIO_R2_BUCKET || env.MYCELIUM_R2_WARM_BUCKET || "mycelium-warm",
  };
}

function safeSlug(value) {
  const slug = String(value || "").trim();
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(slug) || slug.includes("..")) {
    throw Object.assign(new Error("Invalid meeting audio slug"), { statusCode: 400 });
  }
  return slug;
}

function clientFor(config) {
  const signature = [config.accessKeyId, config.endpoint, config.region].join("|");
  if (!cachedClient || cachedSignature !== signature) {
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    cachedSignature = signature;
  }
  return cachedClient;
}

function keyFor(slug) {
  return `meetings/hot/${safeSlug(slug)}/audio.m4a`;
}

function requireConfig(env) {
  const config = configFromEnv(env);
  if (!config) throw Object.assign(new Error("Meeting hot-audio storage is not configured"), { statusCode: 503 });
  return config;
}

async function putHotAudio(slug, body, { expiresAt, env = process.env } = {}) {
  const config = requireConfig(env);
  const key = keyFor(slug);
  await clientFor(config).send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: "audio/mp4",
    Metadata: expiresAt ? { expires_at: String(expiresAt) } : undefined,
  }));
  return { provider: "r2", bucket: config.bucket, key, expires_at: expiresAt || null, bytes: body.length };
}

async function presignHotAudio(ref, { env = process.env, expiresIn = 600 } = {}) {
  const config = requireConfig(env);
  if (!ref || !ref.key) throw Object.assign(new Error("Hot audio reference is missing"), { statusCode: 404 });
  return getSignedUrl(clientFor(config), new GetObjectCommand({
    Bucket: ref.bucket || config.bucket,
    Key: ref.key,
  }), { expiresIn });
}

async function deleteHotAudio(ref, { env = process.env } = {}) {
  const config = requireConfig(env);
  if (!ref || !ref.key) return false;
  await clientFor(config).send(new DeleteObjectCommand({
    Bucket: ref.bucket || config.bucket,
    Key: ref.key,
  }));
  return true;
}

module.exports = { configFromEnv, safeSlug, keyFor, putHotAudio, presignHotAudio, deleteHotAudio };
