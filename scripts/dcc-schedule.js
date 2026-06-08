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
 *   --dry-run            print the request without sending
 *   --help               show this help
 */
"use strict";

const DEFAULT_BASE = "https://daily-command-center.onrender.com";

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
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`✗ Request failed: ${e.message}`);
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
