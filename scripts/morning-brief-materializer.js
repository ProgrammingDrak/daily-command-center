#!/usr/bin/env node

const http = require("http");
const https = require("https");

function parseArgs(argv) {
  const args = { dryRun: true, sourceDate: null, targetDate: null, baseUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-date") args.sourceDate = argv[++i];
    else if (arg === "--target-date") args.targetDate = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--apply") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function localDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.DCC_TIME_ZONE || process.env.APP_TIME_ZONE || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year").value);
  const m = Number(parts.find((p) => p.type === "month").value);
  const d = Number(parts.find((p) => p.type === "day").value);
  const date = new Date(Date.UTC(y, m - 1, d + offsetDays, 12, 0, 0));
  return date.toISOString().slice(0, 10);
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
        if (res.statusCode >= 400) {
          const err = new Error(json.error || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
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

function printHelp() {
  console.log(`Usage: node scripts/morning-brief-materializer.js [--source-date YYYY-MM-DD] [--target-date YYYY-MM-DD] [--apply]

Source and target both default to today (the morning brief lives under today).
Dry-runs by default. For production, either set DCC_TOKEN, SECRET_DCC_TOKEN,
SECRET_SWEEP_SUITE_TOKEN, or SECRET_PA_TOKEN, or set DCC_USERNAME/DCC_PASSWORD
(SEED_USERNAME/SEED_PASSWORD are accepted as a local fallback).
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const baseUrl = (args.baseUrl || process.env.DCC_BASE_URL || process.env.DCC_API_BASE_URL || "http://localhost:8090").replace(/\/$/, "");
  const token = process.env.DCC_TOKEN || process.env.SECRET_DCC_TOKEN || process.env.SECRET_SWEEP_SUITE_TOKEN || process.env.SECRET_PA_TOKEN || "";
  const username = process.env.DCC_USERNAME || process.env.SEED_USERNAME || "";
  const password = process.env.DCC_PASSWORD || process.env.SEED_PASSWORD || "";
  let cookie = "";
  if (!token && username && password) {
    const login = await requestJson(`${baseUrl}/api/auth/login`, { username, password });
    cookie = cookieHeader(login.headers["set-cookie"]);
    if (!cookie) throw new Error("Login succeeded but no session cookie was returned");
  }
  const targetDate = args.targetDate || localDate(0);
  // Source today's brief by default: the morning brief (build_morning_brief.py)
  // publishes under today's date and carries last night's decisions forward, so
  // today's brief is the single source of approvals. Pass --source-date to
  // materialize straight from an older (e.g. nightly) brief instead.
  const sourceDate = args.sourceDate || localDate(0);
  const response = await requestJson(`${baseUrl}/api/dcc/brief/materialize`, {
    sourceDate,
    targetDate,
    dryRun: args.dryRun,
  }, { token, cookie });
  console.log(JSON.stringify(response.json, null, 2));
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`[morning-brief-materializer] ${err.message}`);
  process.exitCode = 1;
});
