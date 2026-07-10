#!/usr/bin/env node
// Platform dispatcher for the local DB refresh so `npm run db:refresh-local`
// works everywhere: bash on macOS/Linux, PowerShell on Windows. Forwards all
// CLI args through to the platform script.
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const isWin = process.platform === "win32";
const r = isWin
  ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/refresh-local-db.ps1", ...args], { stdio: "inherit" })
  : spawnSync("bash", ["scripts/refresh-local-db.sh", ...args], { stdio: "inherit" });

if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status == null ? 1 : r.status);
