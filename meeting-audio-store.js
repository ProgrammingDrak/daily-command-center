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

function normalizeExpiry(value, now = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  const max = now + (14 * 24 * 60 * 60 * 1000) + (5 * 60 * 1000);
  if (!Number.isFinite(parsed) || parsed <= now || parsed > max) {
    throw Object.assign(new Error("A valid meeting audio expiry within 14 days is required"), { statusCode: 400 });
  }
  return new Date(parsed).toISOString();
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

function keyFor(slug, workspaceId) {
  return `meetings/hot/${safeSlug(workspaceId)}/${safeSlug(slug)}/audio.m4a`;
}

function requireConfig(env) {
  const config = configFromEnv(env);
  if (!config) throw Object.assign(new Error("Meeting hot-audio storage is not configured"), { statusCode: 503 });
  return config;
}

async function putHotAudio(slug, body, { expiresAt, workspaceId, env = process.env } = {}) {
  const config = requireConfig(env);
  const normalizedExpiry = normalizeExpiry(expiresAt);
  const key = keyFor(slug, workspaceId);
  await clientFor(config).send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: "audio/mp4",
    Metadata: { expires_at: normalizedExpiry },
  }));
  return { provider: "r2", bucket: config.bucket, key, expires_at: normalizedExpiry, bytes: body.length };
}

async function presignHotAudio(ref, { env = process.env, expiresIn = 600, workspaceId } = {}) {
  const config = requireConfig(env);
  if (!ref || !ref.key) throw Object.assign(new Error("Hot audio reference is missing"), { statusCode: 404 });
  const prefix = `meetings/hot/${safeSlug(workspaceId)}/`;
  if (!String(ref.key).startsWith(prefix) || (ref.bucket && ref.bucket !== config.bucket)) {
    throw Object.assign(new Error("Hot audio reference is outside this workspace"), { statusCode: 403 });
  }
  return getSignedUrl(clientFor(config), new GetObjectCommand({
    Bucket: config.bucket,
    Key: ref.key,
  }), { expiresIn });
}

async function deleteHotAudio(ref, { env = process.env, workspaceId } = {}) {
  const config = requireConfig(env);
  if (!ref || !ref.key) return false;
  const prefix = `meetings/hot/${safeSlug(workspaceId)}/`;
  if (!String(ref.key).startsWith(prefix) || (ref.bucket && ref.bucket !== config.bucket)) {
    throw Object.assign(new Error("Hot audio reference is outside this workspace"), { statusCode: 403 });
  }
  await clientFor(config).send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: ref.key,
  }));
  return true;
}

module.exports = { configFromEnv, safeSlug, normalizeExpiry, keyFor, putHotAudio, presignHotAudio, deleteHotAudio };
