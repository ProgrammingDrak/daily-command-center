#!/usr/bin/env node

// Static review server. Optional review backends use explicitly enabled synthetic databases only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import reschedule from "../lib/reschedule.js";
import poolPlacement from "../lib/whenever-placement.js";
import createTaskTiming from "../lib/task-timing.js";
import seedTaskDetailReview from "./task-detail-review-fixtures.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = Number(process.env.PORT || 8099);
const app = express();
app.use(express.json());
if (process.env.DCC_REVIEW_COMMITMENTS === "1") {
  const { default: mountCommitmentReview } = await import("./commitment-review-backend.js");
  await mountCommitmentReview(app);
}
if (process.env.DCC_ACTIVITY_REVIEW === "1") {
  const { default: mountActivityReview } = await import("./activity-review-backend.js");
  await mountActivityReview(app);
}
if (process.env.DCC_REVIEW_TASK_DETAILS === '1') app.use((_req,res,next) => {
  res.setHeader('Content-Security-Policy', "connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'");
  next();
});
const reviewBlocks = new Map();
const meetingReviewFixture = [
  { id: "review-investor", title: "Investor Network Weekly", date: "2026-09-25", status: "ready",
    actions: [
      { id: "review-action-1", text: "Send the revised investor brief", owner: "drake", status: "proposed" },
      { id: "review-action-2", text: "Confirm the updated figures with Ben", owner: "other", status: "proposed" },
    ] },
  { id: "review-notes", title: "Partner planning", date: "2026-09-24", status: "waiting", actions: [] },
  { id: "review-done", title: "Team check-in", date: "2026-09-23", status: "reviewed", actions: [] },
];

function ensureReviewDayRoot(date) {
  const id = `day-root-review-${date}`;
  if (reviewBlocks.has(id)) return reviewBlocks.get(id);
  const now = new Date().toISOString();
  const rootBlock = {
    id,
    type: "day_root",
    parent_id: null,
    date,
    sort_order: 0,
    properties: {},
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  reviewBlocks.set(id, rootBlock);
  return rootBlock;
}

function localDateKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function liveReviewBlocks() {
  return [...reviewBlocks.values()].filter((block) => !block.deleted_at);
}
if (process.env.DCC_REVIEW_TASK_DETAILS === '1') seedTaskDetailReview(reviewBlocks, localDateKey(new Date()));

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
app.get("/api/health", (_req, res) => res.json({ status: "ok", database: "fixture", placementCapabilities: ["timed","all_day","unplanned"], reviewOnly: true }));
app.get("/api/app-config", (_req, res) => res.json({ environment: "review", integrations: {}, features: {} }));
app.get("/api/me", (_req, res) => res.json({
  id: 1,
  username: "review",
  onboardingState: { dailyCommandCenterTour: { version: 2, completedAt: "2026-01-01T00:00:00.000Z" } },
}));
app.get("/api/meetings/reviews", (_req, res) => res.json({ items: meetingReviewFixture.map(row => ({
  id: row.id, title: row.title, date: row.date, status: row.status,
  actionCount: row.actions.length,
  unresolvedCount: row.actions.filter(action => ["proposed", "approved"].includes(action.status)).length,
})) }));
app.get("/api/meetings/:id/automation", (req, res) => {
  const row = meetingReviewFixture.find(item => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "Meeting not found" });
  res.json({ meeting: { id: row.id, title: row.title, date: row.date },
    summary: { markdown: "### Recap\nThe team reviewed the investor brief and next steps.\n\n### Decision\nShare revised figures before the next call." },
    proposedActions: row.actions });
});
app.patch("/api/meetings/:id/actions/:actionId", (req, res) => {
  const action = meetingReviewFixture.find(row => row.id === req.params.id)?.actions.find(row => row.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: "Action not found" });
  action.text = String(req.body.text || "");
  res.json({ ok: true });
});
app.post("/api/meetings/:id/actions/:actionId/dismiss", (req, res) => {
  const action = meetingReviewFixture.find(row => row.id === req.params.id)?.actions.find(row => row.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: "Action not found" });
  action.status = "dismissed";
  res.json({ ok: true });
});
app.post("/api/meetings/:id/actions/approve", (req, res) => {
  const row = meetingReviewFixture.find(item => item.id === req.params.id);
  const action = row?.actions.find(item => (req.body.actionIds || []).includes(item.id));
  if (!action) return res.status(404).json({ error: "Action not found" });
  action.status = "approved";
  action.approvedBlockId = "task-" + action.id;
  res.json({ proposedActions: row.actions, approvedBlocks: [{ id: action.approvedBlockId }] });
});
app.post("/api/meetings/:id/actions/:actionId/place", (req, res) => {
  const action = meetingReviewFixture.find(row => row.id === req.params.id)?.actions
    .find(row => row.approvedBlockId === req.params.actionId);
  if (!action) return res.status(404).json({ error: "Approved task not found" });
  action.status = "placed";
  action.placedDate = req.body.date;
  res.json({ ok: true });
});
app.post("/api/meetings/:id/review/finish", (req, res) => {
  const row = meetingReviewFixture.find(item => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "Meeting not found" });
  if (row.actions.some(action => ["proposed", "approved"].includes(action.status))) {
    return res.status(409).json({ error: "Decide every proposed action before finishing" });
  }
  row.status = "reviewed";
  res.json({ ok: true });
});
app.get("/api/state/archives", (_req,res)=>res.json({"2026-09-12":{date:"2026-09-12"}}));
app.get("/api/state/upcoming", (_req,res)=>res.json([]));
app.get("/api/state/tomorrow", (_req,res)=>res.json(null));
app.get("/api/state/day", (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : localDateKey();
  const timeBlocks = [
    { id: "review-morning", name: "Morning Workout", start: "06:30", end: "09:00", activeDays: ["mon", "tue", "wed", "thu", "fri"] },
    { id: "review-clever", name: "Clever", start: "09:00", end: "17:30", activeDays: ["mon", "tue", "wed", "thu", "fri"] },
    { id: "review-post-work", name: "Post Work", start: "17:30", end: "19:00", activeDays: ["mon", "tue", "wed", "thu", "fri"] },
    { id: "review-evening", name: "Evening", start: "19:00", end: "22:00", activeDays: ["mon", "tue", "wed", "thu", "fri"] },
    { id: "review-bedtime", name: "Bedtime", start: "22:00", end: "24:00", activeDays: ["mon", "tue", "wed", "thu", "fri"] },
  ];
  res.json({
    ...emptyState,
    date,
    schedule: { timeBlocks, blocks: timeBlocks, timeline: [], tasks_couldnt_fit: [], end_time: "17:30" },
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
  if (req.query.date) ensureReviewDayRoot(String(req.query.date));
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
// Placement preview uses the same subtree and property transformation as production.
app.post("/api/blocks/:id/reschedule",(req,res)=>{
  try{
    const parent=reviewBlocks.get(req.params.id);
    if(!parent)return res.status(404).json({error:"Block not found"});
    if(req.body.placement?.kind==="pool_date"){
      const planned=poolPlacement.plan(parent,liveReviewBlocks(),req.body);
      const blocks=planned.moves.map(move=>({...reviewBlocks.get(move.id),date:move.date,parent_id:move.parentId===undefined?reviewBlocks.get(move.id).parent_id:move.parentId,properties:move.properties}));
      blocks.forEach(row=>reviewBlocks.set(row.id,row));
      return res.json({moved:planned.ids,blocks,created:[],targetDate:req.body.targetDate});
    }
    if(req.body.placement?.kind!=="unplanned")return res.status(400).json({error:"Unsupported review placement"});
    const ids=reschedule.collectSubtreeBlockIds(liveReviewBlocks(),parent);
    const blocks=ids.map(id=>{const row=reviewBlocks.get(id);return {...row,date:req.body.targetDate,parent_id:id===parent.id?null:row.parent_id,properties:reschedule.unplannedProperties(row,parent.id,req.body.placement.durations)};});
    blocks.forEach(row=>reviewBlocks.set(row.id,row));
    res.json({moved:ids,blocks,created:[],targetDate:req.body.targetDate});
  }catch(error){res.status(error.statusCode||400).json({error:error.message});}
});
app.get("/api/public/todo-share/:token",(req,res)=>{
  const date=req.query.date||localDateKey();
  const tasks=liveReviewBlocks().filter(row=>row.type==="block"&&(row.date===date||(!row.date&&row.properties.triageBlock))).map(row=>{
    const p=row.properties,redacted=p.publicVisibility==="private";
    return {id:p.local_id||row.id,blockId:row.id,title:redacted?"Private task":p.title,detail:redacted?"":p.notes,start:p.start,end:p.end,untimed:!p.start,triageBlock:!!p.triageBlock,wrapId:p.wrapId,subtaskOf:p.subtaskOf,status:p.completed||p.status==="done"?"done":"open",itemType:"task",durationMinutes:p.duration,redacted};
  });
  res.json({date,tasks,blocks:[{id:"work",name:"Clever",start:"09:00",end:"17:30",activeDays:["mon","tue","wed","thu","fri"]}],workspaceName:"Review itinerary",calendars:[],capabilities:{},updatedAt:new Date().toISOString()});
});
// Exercise the actual work-session domain against the disposable review store.
const reviewTiming = createTaskTiming({
  pool: { query: async () => ({ rows: [] }) },
  blockDB: {
    getBlock: async id => reviewBlocks.get(id),
    getBlockIncludingDeleted: async id => reviewBlocks.get(id),
    getTaskTimeEntries: async id => liveReviewBlocks().filter(row => row.type === "time_entry" && row.properties.blockId === id),
    updateBlock: async (id, patch) => { const row = { ...reviewBlocks.get(id), ...patch }; reviewBlocks.set(id, row); return row; },
    createBlock: async input => { const row = { id: randomUUID(), ...input }; reviewBlocks.set(row.id, row); return row; },
    deleteBlock: async id => { const row = reviewBlocks.get(id); row.deleted_at = new Date().toISOString(); return row; },
    ensureDayRoot: async date => ensureReviewDayRoot(date).id,
  },
});
app.post("/api/blocks/:id/work", async (req, res) => {
  try {
    const block = reviewBlocks.get(req.params.id);
    if (!block) return res.status(404).json({ error: "Block not found" });
    const operation = req.body.action === "start" ? reviewTiming.startWork : reviewTiming.pauseWork;
    await operation({ block, atMs: Date.parse(req.body.at), actionId: req.body.actionId, actor: "review" });
    res.json({ block: reviewBlocks.get(block.id) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get("/api/blocks/:id/work", async (req, res) => {
  const block = reviewBlocks.get(req.params.id);
  if (!block) return res.status(404).json({ error: "Block not found" });
  res.json({ block, sessions: await reviewTiming.getSessions(block) });
});
// Synthetic completion adapter for preview only; production ownership/CAS and
// persistence are covered by the canonical completion route/domain tests.
app.post('/api/tasks/:id/completion', async (req,res) => {
  const block=liveReviewBlocks().find(row=>row.id===req.params.id||row.properties.local_id===req.params.id);
  if(!block)return res.status(404).json({error:'Synthetic task not found'});
  try {
    const operation=req.body.completed?reviewTiming.completeWork:reviewTiming.reopenWork;
    await operation({block,actionId:req.body.mutationId,actor:'review'});
    res.json({ok:true,task:reviewBlocks.get(block.id),affectedTasks:[],persistenceTarget:'task_row',revision:'review',duplicate:false});
  }catch(error){res.status(400).json({error:error.message});}
});
app.get('/api/blocks/:id', (req,res) => {
  const block=reviewBlocks.get(req.params.id);
  if(!block||block.deleted_at)return res.status(404).json({error:'Synthetic block not found'});
  res.json(block);
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
function reviewReimbursementFixtures() {
  return [
  {
    id: "review-reimbursement-dinner",
    title: "Birthday dinner",
    detail: "Dinner and tip at Northstar Cafe.",
    direction: "owed_to_me",
    totalCents: 14400,
    purchaseDate: "2026-09-26",
    paidViaMethod: "credit_card",
    paidViaDetail: "Chase Sapphire",
    repayToMethod: "venmo",
    repayToDetail: "@review-user",
    splitMode: "equal",
    status: "partial",
    dueCents: 9600,
    paidCents: 4800,
    outstandingCents: 4800,
    viewerRole: "owner",
    balanceKind: "receivable",
    shareUrl: "/reimburse/review-dinner-token",
    participants: [
      { id: "review-self", name: "Review User", isSelf: true, shareCents: 4800, paidCents: 0, outstandingCents: 0, status: "included", payments: [] },
      { id: "review-alex", name: "Alex", isSelf: false, shareCents: 4800, paidCents: 0, outstandingCents: 4800, status: "outstanding", payments: [] },
      { id: "review-sam", name: "Sam", isSelf: false, shareCents: 4800, paidCents: 4800, outstandingCents: 0, status: "paid", payments: [{ id: "review-payment", amountCents: 4800, method: "zelle", methodDetail: "Paid Saturday" }] },
    ],
  },
  {
    id: "review-reimbursement-tickets",
    title: "Concert tickets",
    detail: "Morgan bought both tickets.",
    direction: "i_owe",
    totalCents: 18000,
    purchaseDate: "2026-09-20",
    paidViaMethod: "credit_card",
    paidViaDetail: "Morgan's card",
    repayToMethod: "cash_app",
    repayToDetail: "$morgan",
    counterpartyName: "Morgan",
    splitMode: "amount",
    status: "outstanding",
    dueCents: 9000,
    paidCents: 0,
    outstandingCents: 9000,
    viewerRole: "owner",
    balanceKind: "payable",
    shareUrl: "/reimburse/review-tickets-token",
    participants: [
      { id: "review-ticket-self", name: "Review User", isSelf: true, shareCents: 9000, paidCents: 0, outstandingCents: 9000, status: "outstanding", payments: [] },
    ],
  },
  ];
}
let reviewReimbursements = reviewReimbursementFixtures();
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
  reviewReimbursements = reviewReimbursementFixtures();
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
app.get("/api/reimbursements", (_req, res) => res.json({ reimbursements: reviewReimbursements }));
app.post("/api/reimbursements", (req, res) => {
  const id = `review-reimbursement-${randomUUID()}`;
  const totalCents = Math.max(1, Number(req.body?.totalCents) || 0);
  reviewReimbursements.unshift({
    id,
    title: req.body?.title || "Review reimbursement",
    detail: req.body?.detail || "",
    direction: req.body?.direction || "owed_to_me",
    totalCents,
    purchaseDate: req.body?.purchaseDate || null,
    paidViaMethod: req.body?.paidViaMethod || "other",
    paidViaDetail: req.body?.paidViaDetail || "",
    repayToMethod: req.body?.repayToMethod || "other",
    repayToDetail: req.body?.repayToDetail || "",
    splitMode: req.body?.splitMode || "equal",
    status: "outstanding",
    dueCents: totalCents,
    paidCents: 0,
    outstandingCents: totalCents,
    viewerRole: "owner",
    balanceKind: req.body?.direction === "i_owe" ? "payable" : "receivable",
    shareUrl: `/reimburse/${id}-token`,
    participants: [{ id: `${id}-person`, name: "Review person", isSelf: false, shareCents: totalCents, paidCents: 0, outstandingCents: totalCents, status: "outstanding", payments: [] }],
  });
  res.status(201).json({ reimbursement: { id } });
});
app.post("/api/reimbursements/:id/payments", (req, res) => {
  const item = reviewReimbursements.find((row) => row.id === req.params.id);
  const person = item?.participants.find((row) => row.id === req.body?.participantId);
  if (!item || !person) return res.status(404).json({ error: "Reimbursement not found" });
  const amount = Math.min(person.outstandingCents, Math.max(0, Number(req.body?.amountCents) || 0));
  person.paidCents += amount;
  person.outstandingCents -= amount;
  person.status = person.outstandingCents ? "partial" : "paid";
  person.payments.push({ id: randomUUID(), amountCents: amount, method: req.body?.method || "other", methodDetail: req.body?.methodDetail || "" });
  item.paidCents += amount;
  item.outstandingCents -= amount;
  item.status = item.outstandingCents ? "partial" : "settled";
  res.json({ payment: { id: randomUUID(), remainingCents: person.outstandingCents } });
});
app.delete("/api/reimbursements/:id", (req, res) => {
  reviewReimbursements = reviewReimbursements.filter((row) => row.id !== req.params.id);
  res.json({ archived: true });
});
app.get("/api/public/reimbursements/:token", (req, res) => {
  const item = req.params.token.includes("tickets") ? reviewReimbursements[1] : reviewReimbursements[0];
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json({
    signedIn: false,
    reimbursement: {
      ...item,
      ownerName: "Review User",
      shareActive: true,
      viewerParticipantId: null,
      participants: item.participants.map((person) => ({
        id: person.id,
        name: person.name,
        shareCents: person.shareCents,
        paidCents: person.paidCents,
        outstandingCents: person.outstandingCents,
        status: person.status,
        isSelf: person.isSelf,
        accountBound: false,
        available: true,
      })),
    },
  });
});
app.post("/api/public/reimbursements/:token/payments", (req, res) => {
  const item = req.params.token.includes("tickets") ? reviewReimbursements[1] : reviewReimbursements[0];
  const person = item?.participants.find((row) => row.id === req.body?.participantId);
  if (!item || !person) return res.status(404).json({ error: "Not found" });
  const amount = Math.min(person.outstandingCents, Math.max(0, Number(req.body?.amountCents) || 0));
  person.paidCents += amount;
  person.outstandingCents -= amount;
  person.status = person.outstandingCents ? "partial" : "paid";
  item.paidCents += amount;
  item.outstandingCents -= amount;
  item.status = item.outstandingCents ? "partial" : "settled";
  res.json({ payment: { id: randomUUID(), remainingCents: person.outstandingCents } });
});
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
app.get("/api/task-library", (_req,res)=>res.json({
  tasks:liveReviewBlocks().filter(row=>row.type==='block'&&((row.properties||{}).local_id||['task','backlog'].includes((row.properties||{}).kind))),
  projects:[],facets:[],views:[],readiness:{}
}));
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
app.get("/reimburse/:token", (_req, res) => res.sendFile(path.join(root, "reimburse.html")));
app.use(express.static(root));

app.listen(port, "127.0.0.1", () => {
  console.log(`UI review server: http://127.0.0.1:${port}`);
});
