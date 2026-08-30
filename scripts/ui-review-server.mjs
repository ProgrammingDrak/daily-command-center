#!/usr/bin/env node

// Static review server. It never imports production routes or touches a database.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = Number(process.env.PORT || 8099);
const app = express();
app.use(express.json());
const reviewBlocks = new Map();

function localDateKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function liveReviewBlocks() {
  return [...reviewBlocks.values()].filter((block) => !block.deleted_at);
}

const emptyState = {
  ok: true,
  items: [],
  rows: [],
  blocks: [],
  meetings: [],
  tasks: [],
  notes: [],
  friends: [],
  requests: [],
  grants: [],
  posts: [],
  state: {},
  settings: {},
  usage: {},
  summary: {},
  capabilities: {},
};

app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));
app.get("/api/auth/me", (_req, res) => res.json({ ok: true, authenticated: true, user: { id: 1, username: "review", name: "Review User" } }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", database: "fixture", reviewOnly: true }));
app.get("/api/app-config", (_req, res) => res.json({ environment: "review", integrations: {}, features: {} }));
app.get("/api/me", (_req, res) => res.json({
  id: 1,
  username: "review",
  onboardingState: { dailyCommandCenterTour: { version: 2, completedAt: "2026-01-01T00:00:00.000Z" } },
}));
app.get("/api/state/day", (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : localDateKey();
  res.json({
    ...emptyState,
    date,
    schedule: { blocks: [], timeline: [], tasks_couldnt_fit: [], end_time: "17:30" },
  });
});
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": review fixture connected\n\n");
  const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15000);
  req.on("close", () => clearInterval(keepAlive));
});
app.get("/api/blocks", (req, res) => {
  let blocks = liveReviewBlocks();
  if (req.query.date) blocks = blocks.filter((block) => block.date === req.query.date);
  if (req.query.type) {
    const types = new Set(String(req.query.type).split(","));
    blocks = blocks.filter((block) => types.has(block.type));
  }
  res.json(blocks);
});
app.post("/api/blocks", (req, res) => {
  const body = req.body || {};
  const now = new Date().toISOString();
  const existing = body.id ? reviewBlocks.get(String(body.id)) : null;
  if (existing) return res.json(existing);
  const block = {
    id: String(body.id || randomUUID()),
    type: body.type || "block",
    parent_id: body.parent_id || null,
    date: body.date ?? null,
    sort_order: body.sort_order ?? ((reviewBlocks.size + 1) * 1000),
    properties: body.properties || {},
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  reviewBlocks.set(block.id, block);
  res.status(201).json(block);
});
app.patch("/api/blocks/:id", (req, res) => {
  const block = reviewBlocks.get(req.params.id);
  if (!block || block.deleted_at) return res.status(404).json({ error: "Block not found" });
  const next = {
    ...block,
    ...(Object.hasOwn(req.body || {}, "date") ? { date: req.body.date } : {}),
    ...(Object.hasOwn(req.body || {}, "parent_id") ? { parent_id: req.body.parent_id } : {}),
    ...(Object.hasOwn(req.body || {}, "sort_order") ? { sort_order: req.body.sort_order } : {}),
    properties: req.body?.properties || block.properties,
    updated_at: new Date().toISOString(),
  };
  reviewBlocks.set(next.id, next);
  res.json(next);
});
app.delete("/api/blocks/:id", (req, res) => {
  const block = reviewBlocks.get(req.params.id);
  if (!block) return res.status(404).json({ error: "Block not found" });
  const deleted = { ...block, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  reviewBlocks.set(deleted.id, deleted);
  res.json({ id: deleted.id, deleted_at: deleted.deleted_at });
});
let reviewBudgetSettings = {
  period_type: "month",
  capacity_source: "last_income",
  income_cents: 500000,
  income_sources: [{ id: "review-income", name: "Salary", amount_cents: 500000 }],
  necessities: [{ id: "review-rent", name: "Rent", amount_cents: 200000, variable: false }],
  savings: [{ id: "review-savings", name: "Emergency fund", amount_cents: 50000 }],
  discretionary_categories: [],
  current_period: { key: "2026-08", capacity_cents: 0 },
};
const reviewBudgetPurchases = [{ id: 1, title: "Headphones", item: "Headphones", value_cents: 20000, status: "locked", tank_recurring: false }];
let reviewReserveCents = 0;
let reviewBudgetPoints = 50;
const reviewConversions = new Map();
function resetReviewState() {
  reviewBlocks.clear();
  reviewBudgetSettings = {
    period_type: "month",
    capacity_source: "last_income",
    income_cents: 500000,
    income_sources: [{ id: "review-income", name: "Salary", amount_cents: 500000 }],
    necessities: [{ id: "review-rent", name: "Rent", amount_cents: 200000, variable: false }],
    savings: [{ id: "review-savings", name: "Emergency fund", amount_cents: 50000 }],
    discretionary_categories: [],
    current_period: { key: "2026-08", capacity_cents: 0 },
  };
  reviewBudgetPurchases.splice(0, reviewBudgetPurchases.length, { id: 1, title: "Headphones", item: "Headphones", value_cents: 20000, status: "locked", tank_recurring: false });
  reviewReserveCents = 0;
  reviewBudgetPoints = 50;
  reviewConversions.clear();
}
app.post("/api/review/reset", (_req, res) => {
  resetReviewState();
  res.json({ ok: true, reviewOnly: true });
});
function reviewBudgetState() {
  const income = (reviewBudgetSettings.income_sources || []).reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
  const expenses = (reviewBudgetSettings.necessities || []).reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
  const savings = (reviewBudgetSettings.savings || []).reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
  const discretionary = Math.max(0, income - expenses - savings);
  return {
    ...emptyState,
    constants: { bank_units_per_point: 1, bank_unit_cents: 100, cents_per_point: 100, credit_card_categories: [] },
    usage: { period_key: "2026-08", period_banked_cents: reviewReserveCents, prior_period_banked_cents: 0, income_cents: income, necessities_total_cents: expenses, absolute_expenses_cents: expenses, savings_total_cents: savings, capacity_cents: discretionary, discretionary_cents: discretionary, waterline_cents: reviewReserveCents, reserve_unlocked_cents: reviewReserveCents, completed_task_points: 0, completed_task_value_cents: 0, allocated_cents: reviewBudgetPurchases.reduce((sum, row) => sum + row.value_cents, 0), unallocated_cents: Math.max(0, discretionary - reviewReserveCents), overflow_cents: 0 },
    settings: { ...reviewBudgetSettings, income_cents: income },
    funding: { total: 0, sources: [] },
    investments: { total_cents: 0, entries: [] },
    completed_tasks: [],
    categories: [],
    points: reviewBudgetPoints,
    rollover_due: false,
    blocks: reviewBudgetPurchases,
  };
}
app.get("/api/budget/state", (_req, res) => res.json(reviewBudgetState()));
app.post("/api/budget/convert", (req, res) => {
  const key = String(req.body?.source_key || "");
  if (key && reviewConversions.has(key)) return res.json({ duplicate: true, conversion: reviewConversions.get(key), bank_units: reviewConversions.get(key).points });
  const points = Math.min(reviewBudgetPoints, Math.max(0, Math.floor(Number(req.body?.points) || 0)));
  if (!points) return res.status(400).json({ error: "Enter points to convert" });
  const conversion = { points, cents: points * 100 };
  reviewReserveCents += conversion.cents;
  reviewBudgetPoints -= points;
  if (key) reviewConversions.set(key, conversion);
  res.json({ duplicate: false, conversion, bank_units: points });
});
app.put("/api/budget/config", (req, res) => {
  reviewBudgetSettings = { ...reviewBudgetSettings, ...(req.body || {}) };
  if (Array.isArray(reviewBudgetSettings.necessities)) {
    reviewBudgetSettings.necessities = reviewBudgetSettings.necessities.map(row => {
      if (!row.variable) return row;
      const min = Number(row.min_cents) || 0;
      const max = Number(row.max_cents) || 0;
      return { ...row, amount_cents: Math.round((min + max) / 2) };
    });
  }
  res.json(reviewBudgetSettings);
});
app.post("/api/budget/blocks", (req, res) => {
  const body = req.body || {};
  const value = Math.max(0, Math.round(Number(body.amount_cents ?? Number(body.amount) * 100) || 0));
  const row = { id: reviewBudgetPurchases.length + 1, title: body.description || "Planned purchase", item: body.description || "Planned purchase", value_cents: value, status: "locked", tank_recurring: !!body.recurring };
  reviewBudgetPurchases.push(row);
  res.json(row);
});
app.get("/api/budget/vault", (_req, res) => res.json({ items: [], milestones: { items: [], progress: { total: 0 } } }));
app.get("/api/budget/sponsor-link", (_req, res) => res.json({ link: null }));
app.get("/api/pet-home/state", (_req, res) => res.json({
  ...emptyState,
  shareUrl: null,
  home: { pet: { name: "Mochi", base: "sprout", color: "#f2b56b", accessory: "none" }, home: {}, decorCatalog: [], decorCurrency: 0, level: 1, levelProgress: 0 },
  suggestions: [], events: [], visits: [],
}));
app.get("/api/vault/status", (_req, res) => res.json({ status: "review", nodes: 0, edges: 0 }));
app.get("/api/vault/index", (_req, res) => res.json({ nodes: [], edges: [], summary: { nodes: 0, edges: 0 } }));
app.get("/api/vault/nodes", (_req, res) => res.json([]));
app.get("/api/vault/timeline", (_req, res) => res.json({ nodes: [], threads: [], lockedCount: 0 }));
app.get("/api/vault/graph", (_req, res) => res.json({ nodes: [], edges: [] }));
app.get("/api/*", (req, res) => {
  if (req.path.includes("social/feed/publishable") || req.path.includes("social/friends") || req.path.includes("social/rewards/queue") || req.path.includes("access/grants") || req.path.includes("access/granted-to-me")) return res.json([]);
  if (req.path.includes("responsibilities")) return res.json([]);
  if (req.path.includes("tasks/open")) return res.json({ items: [] });
  if (req.path.includes("blocks")) return res.json([]);
  if (req.path.includes("admin")) return res.json({ activity: [], feedback: [], items: [] });
  return res.json(emptyState);
});
app.all("/api/*", (_req, res) => res.json(emptyState));

app.get("/", (_req, res) => res.sendFile(path.join(root, "index.html")));
app.get("/login", (_req, res) => res.sendFile(path.join(root, "login.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(root, "admin.html")));
app.use(express.static(root));

app.listen(port, "127.0.0.1", () => {
  console.log(`UI review server: http://127.0.0.1:${port}`);
});
