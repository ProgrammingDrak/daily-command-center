#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");

function parseArgs(argv) {
  const args = { file: "", dryRun: false, baseUrl: "", date: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--date") args.date = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requestJson(url, payload, token) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
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
        if (res.statusCode >= 400) {
          reject(new Error(json.error || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(json);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function packetItems(packet) {
  return []
    .concat(packet.items || [], packet.triage_items || [], packet.needs_attention || [], packet.attention_items || [])
    .filter((item) => item && item.needs_attention !== false);
}

function printHelp() {
  console.log(`Usage: node scripts/triage-check-ingest.js --file packet.json [--dry-run]

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
  const payload = { date: args.date || packet.date, packet };
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, date: payload.date || null, attention_items: packetItems(packet).length }, null, 2));
    return 0;
  }
  const baseUrl = (args.baseUrl || process.env.DCC_BASE_URL || process.env.DCC_API_BASE_URL || "https://daily-command-center-personal.onrender.com").replace(/\/$/, "");
  const token = process.env.DCC_TOKEN || process.env.DCC_API_TOKEN || process.env.SECRET_DCC_TOKEN || process.env.SECRET_SWEEP_SUITE_TOKEN || process.env.SECRET_PA_TOKEN || "";
  const response = await requestJson(`${baseUrl}/api/dcc/triage-check/ingest`, payload, token);
  console.log(JSON.stringify(response, null, 2));
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`[triage-check-ingest] ${err.message}`);
  process.exitCode = 1;
});
