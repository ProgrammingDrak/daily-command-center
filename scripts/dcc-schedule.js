#!/usr/bin/env node
/**
 * dcc-schedule.js — schedule a task into the Daily Command Center from any machine.
 *
 * Zero dependencies (uses built-in fetch; Node 18+). Posts to /api/dcc/quick-task.
 *
 * Config via env (never hardcode secrets):
 *   DCC_BASE_URL   default https://daily-command-center.onrender.com
 *   DCC_PA_TOKEN   bearer token (falls back to SECRET_PA_TOKEN). Required in prod.
 *
 * Usage:
 *   node scripts/dcc-schedule.js --title "Draft board memo" \
 *        --date 2026-06-09 --start 14:00 --duration 45 --priority high \
 *        --detail "Pull Q2 numbers first" --tags work,writing
 *
 *   node scripts/dcc-schedule.js --title "Quick test" --dry-run
 *
 * Flags:
 *   --title <str>        (required) task title
 *   --date <YYYY-MM-DD>  defaults to today (server-side)
 *   --start <HH:MM>      defaults to next quarter hour (server-side)
 *   --duration <min>     default 30
 *   --priority <p>       low|normal|medium|high|urgent  (default medium)
 *   --detail <str>       optional notes
 *   --tags <a,b,c>       optional comma-separated tags
 *   --base <url>         override DCC_BASE_URL
 *   --user-id <n>        owner user id (sent as x-user-id; req'd for token auth).
 *                        Defaults to DCC_USER_ID env, else 1.
 *   --workspace-id <id>  optional workspace id (sent as x-workspace-id).
 *   --dry-run            print the request without sending
 *   --help               show this help
 */
"use strict";

const DEFAULT_BASE = "https://daily-command-center.onrender.com";

// Cold-start tolerance: the DCC may be a free-tier service that spins down when
// idle, so the first request after a quiet period can take ~30-60s to wake. A
// single naked fetch with no timeout will hang or fail on that cold start, which
// looks like "the packet never reached production" on scheduled runs. We warm the
// service with a health ping, then retry the real request with bounded timeouts.
// All knobs are env-overridable.
const REQUEST_TIMEOUT_MS = Number(process.env.DCC_TIMEOUT_MS || 20000);
const WARMUP_TIMEOUT_MS = Number(process.env.DCC_WARMUP_TIMEOUT_MS || 60000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.DCC_MAX_RETRIES || 3));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// Best-effort wake-up ping; never throws.
async function warmup(base) {
  try {
    await fetchWithTimeout(`${base}/api/health`, { method: "GET" }, WARMUP_TIMEOUT_MS);
  } catch { /* health check is advisory only */ }
}

// POST with bounded timeout + retry. Retries network/timeout errors and 5xx /
// 429 (cold-start, transient). Fails fast on 4xx (auth/validation won't improve).
async function postWithRetry(url, opts) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts, REQUEST_TIMEOUT_MS);
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      lastErr = new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS) {
      if (attempt === 1) await warmup(url.replace(/\/api\/.*$/, "")); // wake a sleeping service once
      await sleep(1000 * attempt); // linear backoff: 1s, 2s, ...
    }
  }
  throw lastErr || new Error("request failed");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "dry-run" || key === "help") { out[key] = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) { out[key] = true; }
    else { out[key] = val; i++; }
  }
  return out;
}

function usage() {
  console.log(require("fs").readFileSync(__filename, "utf8")
    .split("\n").filter(l => l.startsWith(" *") || l.startsWith("/**"))
    .map(l => l.replace(/^\/?\*+ ?/, "")).join("\n").trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) { console.error("✗ --title is required (use --help)"); process.exit(2); }

  const base = (args.base || process.env.DCC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const token = process.env.DCC_PA_TOKEN || process.env.SECRET_PA_TOKEN || "";
  const userId = String(args["user-id"] || process.env.DCC_USER_ID || "1");
  const workspaceId = args["workspace-id"] || process.env.DCC_WORKSPACE_ID || "";

  const body = { title };
  if (typeof args.date === "string") body.date = args.date;
  if (typeof args.start === "string") body.start = args.start;
  if (args.duration) body.durationMinutes = parseInt(args.duration, 10);
  if (typeof args.priority === "string") body.priority = args.priority;
  if (typeof args.detail === "string") body.detail = args.detail;
  if (typeof args.tags === "string") body.tags = args.tags.split(",").map(s => s.trim()).filter(Boolean);

  const url = `${base}/api/dcc/quick-task`;

  if (args["dry-run"]) {
    console.log("DRY RUN — would POST:");
    console.log("  URL:", url);
    console.log("  Auth:", token ? "Bearer <token present>" : "(no token set!)");
    console.log("  x-user-id:", userId, workspaceId ? `| x-workspace-id: ${workspaceId}` : "");
    console.log("  Body:", JSON.stringify(body, null, 2));
    return;
  }

  if (!token) {
    console.error("✗ No token. Set DCC_PA_TOKEN (or SECRET_PA_TOKEN) in your env.");
    console.error("  It must match SECRET_PA_TOKEN configured on the DCC server.");
    process.exit(2);
  }

  let res;
  try {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-user-id": userId };
    if (workspaceId) headers["x-workspace-id"] = workspaceId;
    res = await postWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    const reason = e.name === "AbortError" ? `timed out after ${REQUEST_TIMEOUT_MS}ms (is ${base} awake/reachable?)` : e.message;
    console.error(`✗ Request failed: ${reason}`);
    process.exit(1);
  }

  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    console.error(`✗ ${res.status} ${res.statusText}: ${json ? json.error || text : text}`);
    process.exit(1);
  }
  console.log(`✓ Scheduled "${json.title}" on ${json.date} ${json.start}-${json.end} (${json.priority}, ${json.durationMinutes}m)`);
  console.log(`  id: ${json.id}`);
}

main();
