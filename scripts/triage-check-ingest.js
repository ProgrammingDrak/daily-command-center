#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");

function parseArgs(argv) {
  const args = { file: "", dryRun: false, verify: false, baseUrl: "", date: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--date") args.date = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verify") args.verify = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requestJson(url, payload, options = {}) {
  const { token = "", cookie = "" } = options;
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (process.env.DCC_SERVICE_USER_ID) headers["X-User-Id"] = process.env.DCC_SERVICE_USER_ID;
  if (process.env.DCC_SERVICE_WORKSPACE_ID) headers["X-Workspace-Id"] = process.env.DCC_SERVICE_WORKSPACE_ID;
  return new Promise((resolve, reject) => {
    const req = transport.request(parsed, { method: "POST", headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch { json = { error: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(json.error || `HTTP ${res.statusCode}`));
          return;
        }
        resolve({ json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function cookieHeader(setCookie) {
  const cookies = Array.isArray(setCookie) ? setCookie : [];
  return cookies.map((line) => String(line).split(";")[0]).filter(Boolean).join("; ");
}

function packetItems(packet) {
  return []
    .concat(packet.items || [], packet.triage_items || [], packet.needs_attention || [], packet.attention_items || [], packet.sweep_findings || [], packet.reply_findings || [])
    .filter((item) => item && item.needs_attention !== false);
}

function printHelp() {
  console.log(`Usage: node scripts/triage-check-ingest.js --file packet.json [--dry-run | --verify]

For canonical sweep capture send sweep_findings or reply_findings and configure
DCC_SWEEP_CAPTURE_TOKEN (exact sweep scope) or SECRET_SWEEP_SUITE_TOKEN.
--dry-run previews locally; --verify calls the server with rollback.

Packet items are attention-only response candidates. Each item may include:
source, source_id, title, needs_attention_reason, urgency_score, source_url,
draft_url, draft_id, draft_type, recommended_action, deadline.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.file) throw new Error("--file is required");
  const packet = JSON.parse(fs.readFileSync(args.file, "utf8"));
  const capture = Object.hasOwn(packet, "sweep_findings") || Object.hasOwn(packet, "reply_findings");
  if (args.verify && (!capture || args.dryRun)) throw new Error("--verify requires a canonical sweep packet and cannot be combined with --dry-run");
  const payload = { date: args.date || packet.date, packet, ...(args.verify ? {dry_run:true} : {}) };
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, date: payload.date || null, attention_items: packetItems(packet).length }, null, 2));
    return 0;
  }
  const baseUrl = (args.baseUrl || process.env.DCC_BASE_URL || process.env.DCC_API_BASE_URL || "https://daily-command-center-production-1d04.up.railway.app").replace(/\/$/, "");
  const token = capture ? (process.env.DCC_SWEEP_CAPTURE_TOKEN || process.env.SECRET_SWEEP_SUITE_TOKEN || "") :
    (process.env.DCC_TOKEN || process.env.DCC_API_TOKEN || process.env.SECRET_DCC_TOKEN || process.env.SECRET_SWEEP_SUITE_TOKEN || process.env.SECRET_PA_TOKEN || "");
  if (capture && !token) throw new Error("Dedicated Sweep capture token required");
  if (capture) {
    const target = new URL(baseUrl);
    if (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "::1", "[::1]", "localhost"].includes(target.hostname))) {
      throw new Error("Sweep capture requires HTTPS outside loopback");
    }
  }
  const username = process.env.DCC_USERNAME || process.env.SEED_USERNAME || "";
  const password = process.env.DCC_PASSWORD || process.env.SEED_PASSWORD || "";
  let cookie = "";
  if (!token && username && password) {
    const login = await requestJson(`${baseUrl}/api/auth/login`, { username, password });
    cookie = cookieHeader(login.headers && login.headers["set-cookie"]);
    if (!cookie) throw new Error("Login succeeded but no session cookie was returned");
  }
  const response = await requestJson(`${baseUrl}/api/dcc/triage-check/ingest`, payload, { token, cookie });
  if (capture) {
    const { ok, owner, status, task_ids:taskIds, source_ids:sourceIds } = response.json;
    const findings = packet.sweep_findings || packet.reply_findings;
    const statuses = args.verify ? ["dry_run"] : ["merged", "duplicate"];
    if (!ok || !statuses.includes(status) || !Number.isInteger(owner?.userId) || !owner?.workspaceId ||
        !Array.isArray(findings) || !Array.isArray(taskIds) || !Array.isArray(sourceIds) ||
        taskIds.length !== findings.length || sourceIds.length !== findings.length ||
        taskIds.some(id => typeof id !== "string" || !id) ||
        sourceIds.some((id, i) => id !== findings[i].source_id)) {
      throw new Error("DCC did not return a canonical sweep capture receipt");
    }
  }
  console.log(JSON.stringify(response.json, null, 2));
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`[triage-check-ingest] ${err.message}`);
  process.exitCode = 1;
});
