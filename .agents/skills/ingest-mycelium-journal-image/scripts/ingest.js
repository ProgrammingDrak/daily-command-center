#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const FormDataCtor = globalThis.FormData;
const BlobCtor = globalThis.Blob;

const DEFAULT_BASE = "https://daily-command-center-production-1d04.up.railway.app";
const REQUEST_TIMEOUT_MS = Number(process.env.DCC_TIMEOUT_MS || 20000);
const WARMUP_TIMEOUT_MS = Number(process.env.DCC_WARMUP_TIMEOUT_MS || 60000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.DCC_MAX_RETRIES || 3));

function usage() {
  return [
    "Usage: ingest.js --image <path> --payload <json-path|-> [--base-url <url>] [--dry-run]",
    "",
    "Payload fields: transcript, classification=journal, confidence, and optional",
    "title, date, classificationRationale, highlights[], lowConfidence[].",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (["--image", "--payload", "--base-url"].includes(arg)) {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".heic": "image/heic", ".gif": "image/gif",
  })[ext] || "application/octet-stream";
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be a JSON object");
  if (typeof payload.transcript !== "string" || !payload.transcript.trim()) throw new Error("payload transcript is required");
  if ((payload.classification || "journal") !== "journal") throw new Error("pilot classification must be journal");
  if (payload.confidence == null || (typeof payload.confidence === "string" && !payload.confidence.trim())) {
    throw new Error("payload confidence is required");
  }
  const confidence = Number(payload.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("payload confidence must be between 0 and 1");
  for (const key of ["highlights", "lowConfidence"]) {
    if (payload[key] != null && !Array.isArray(payload[key])) throw new Error(`${key} must be an array`);
  }
  return { ...payload, classification: "journal", confidence };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function postWithRetry(base, options) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(`${base}/api/vault/journal-image-ingest`, options, REQUEST_TIMEOUT_MS);
      if (response.ok) return response;
      const retryable = response.status >= 500 || [408, 409, 425, 429].includes(response.status);
      if (!retryable) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
      await response.arrayBuffer().catch(() => {});
    } catch (error) { lastError = error; }
    if (attempt < MAX_ATTEMPTS) {
      if (attempt === 1) {
        try { await fetchWithTimeout(`${base}/api/health`, { method: "GET" }, WARMUP_TIMEOUT_MS); } catch {}
      }
      await sleep(1000 * attempt);
    }
  }
  throw lastError || new Error("request failed");
}

async function resolveConnection(args = {}) {
  const configDir = process.env.DCC_CONFIG_DIR || path.join(os.homedir(), ".claude", "dcc");
  const profilesPath = path.join(configDir, "profiles.json");
  let data = {};
  try { data = JSON.parse(await fs.readFile(profilesPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error(`could not read ${profilesPath}: ${error.message}`);
  }
  const profileName = process.env.DCC_PROFILE || data.default;
  const profile = profileName && data.profiles && data.profiles[profileName] || {};
  const token = process.env.DCC_PA_TOKEN || process.env.SECRET_PA_TOKEN || process.env.DCC_TOKEN || process.env.SECRET_DCC_TOKEN || profile.token || "";
  const base = String(
    args.baseUrl || process.env.DCC_BASE_URL || process.env.DCC_API_BASE_URL || profile.base_url || DEFAULT_BASE
  ).replace(/\/+$/, "");
  return { base, token, profile: profileName || null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage() + "\n"); return; }
  if (!args.image || !args.payload) throw new Error("--image and --payload are required");

  const payloadText = args.payload === "-" ? await readStdin() : await fs.readFile(path.resolve(args.payload), "utf8");
  const payload = validatePayload(JSON.parse(payloadText));
  const imagePath = path.resolve(args.image);
  const image = await fs.readFile(imagePath);
  if (image.length > 10 * 1024 * 1024) throw new Error("image is over the 10 MB journal-ingest limit");
  const mime = mimeFor(imagePath);
  if (!mime.startsWith("image/")) throw new Error("image path must use a supported image extension");
  const connection = await resolveConnection(args);
  const { base } = connection;

  if (args.dryRun) {
    process.stdout.write(JSON.stringify({
      dryRun: true,
      base,
      image: path.basename(imagePath),
      bytes: image.length,
      confidence: payload.confidence,
      highlights: (payload.highlights || []).length,
      lowConfidence: (payload.lowConfidence || []).length,
    }, null, 2) + "\n");
    return;
  }

  const { token } = connection;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base);
  if (!token && !local) throw new Error("configure a DCC profile token or set DCC_PA_TOKEN/SECRET_PA_TOKEN for production ingest");

  const form = new FormDataCtor();
  form.append("file", new BlobCtor([image], { type: mime }), path.basename(imagePath));
  for (const key of ["title", "date", "classification", "confidence", "classificationRationale", "transcript"]) {
    if (payload[key] != null && String(payload[key]) !== "") form.append(key, String(payload[key]));
  }
  for (const key of ["highlights", "lowConfidence"]) {
    if (payload[key] != null) form.append(key, JSON.stringify(payload[key]));
  }
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await postWithRetry(base, { method: "POST", headers, body: form });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = null; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${result ? result.error || text : text}`);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Journal ingest failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validatePayload, resolveConnection, postWithRetry };
