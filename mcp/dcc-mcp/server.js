#!/usr/bin/env node
/**
 * dcc-mcp — a zero-dependency MCP server exposing the Daily Command Center
 * task scheduler as a native tool (`schedule_task`).
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (the MCP stdio convention).
 * No SDK / npm install required — runs anywhere Node 18+ is present.
 *
 * Config (env, set in your MCP client config — never hardcode):
 *   DCC_BASE_URL  default https://daily-command-center.onrender.com
 *   DCC_PA_TOKEN  bearer token (falls back to SECRET_PA_TOKEN). Required.
 */
"use strict";

const DEFAULT_BASE = "https://daily-command-center.onrender.com";
const BASE = (process.env.DCC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
const TOKEN = process.env.DCC_PA_TOKEN || process.env.SECRET_PA_TOKEN || "";

const SERVER_INFO = { name: "dcc-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "schedule_task",
    description:
      "Schedule a task onto a day in the Daily Command Center. Creates a timed " +
      "task block. Defaults: date=today, start=next quarter hour, duration=30m, " +
      "priority=medium (all resolved server-side if omitted).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title (required)." },
        date: { type: "string", description: "Day to schedule on, YYYY-MM-DD. Defaults to today." },
        start: { type: "string", description: "Start time HH:MM (24h). Defaults to next quarter hour." },
        durationMinutes: { type: "integer", description: "Length in minutes. Default 30, min 5." },
        priority: { type: "string", enum: ["low", "normal", "medium", "high", "urgent"], description: "Default medium." },
        detail: { type: "string", description: "Optional notes/body." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function scheduleTask(args) {
  if (!args || typeof args.title !== "string" || !args.title.trim()) {
    throw new Error("title is required");
  }
  if (!TOKEN) {
    throw new Error("No token configured: set DCC_PA_TOKEN (or SECRET_PA_TOKEN) in the MCP server env, matching the DCC server's SECRET_PA_TOKEN.");
  }
  const body = { title: args.title.trim() };
  for (const k of ["date", "start", "priority", "detail"]) {
    if (typeof args[k] === "string") body[k] = args[k];
  }
  if (args.durationMinutes != null) body.durationMinutes = args.durationMinutes;
  if (Array.isArray(args.tags)) body.tags = args.tags;

  const res = await fetch(`${BASE}/api/dcc/quick-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${json ? json.error || text : text}`);
  return json;
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params && params.name;
    if (name !== "schedule_task") return replyError(id, -32602, `Unknown tool: ${name}`);
    try {
      const r = await scheduleTask(params.arguments || {});
      const summary = `Scheduled "${r.title}" on ${r.date} ${r.start}-${r.end} (${r.priority}, ${r.durationMinutes}m). id=${r.id}`;
      return reply(id, { content: [{ type: "text", text: summary }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }

  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, `Internal error: ${e.message}`);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
