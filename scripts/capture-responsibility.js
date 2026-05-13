#!/usr/bin/env node
/**
 * Capture a responsibility or Offers AMP alert directly into DCC Postgres.
 *
 * Usage:
 *   node scripts/capture-responsibility.js "do weekly metrics review"
 *   node scripts/capture-responsibility.js --file /tmp/slack-alert.txt
 */

require("dotenv/config");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../pg-pool");
const blockDB = require("../db");

const USER_ID = Number(process.env.DCC_LOCAL_USER_ID || 1);
const WORKSPACE_ID = process.env.DCC_LOCAL_WORKSPACE_ID || `ws-${USER_ID}`;

function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseInput() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) return fs.readFileSync(args[fileIdx + 1], "utf8");
  return args.filter(a => !a.startsWith("--")).join(" ").trim();
}

function parseOffersAmpAlert(text) {
  if (!/Offers AMP Error|zero expected matches|New deal entered the AMP with zero expected matches/i.test(text)) return null;
  const ampUrl = (text.match(/https?:\/\/amp\.listwithclever\.dev\/deals\/\d+/i) || [null])[0];
  const hubspotUrl = (text.match(/https?:\/\/app\.hubspot\.com\/contacts\/3298701\/record\/0-3\/\d+/i) || [null])[0];
  const address = (text.match(/Address:\s*([^\n]+)/i) || [null, ""])[1].trim();
  const config = (text.match(/Config lookup:\s*([^\n]+)/i) || [null, ""])[1].trim();
  return {
    alertKey: hubspotUrl || ampUrl || crypto.createHash("sha1").update(text).digest("hex").slice(0, 16),
    title: "Investigate Offers AMP zero expected matches" + (address ? ": " + address.split(",")[0] : ""),
    detail: [address && "Address: " + address, ampUrl && "AMP: " + ampUrl, hubspotUrl && "HubSpot: " + hubspotUrl, config && "Config lookup: " + config].filter(Boolean).join("\n"),
    ampUrl,
    hubspotUrl
  };
}

async function findResponsibility(slug) {
  const { rows } = await pool.query(
    `SELECT * FROM blocks
     WHERE type='block' AND properties->>'kind'='responsibility_item'
       AND properties->>'slug'=$1 AND workspace_id=$2 AND deleted_at IS NULL
     LIMIT 1`,
    [slug, WORKSPACE_ID]
  );
  return rows[0] ? blockDB.parseBlock(rows[0]) : null;
}

async function upsertResponsibility(props) {
  const slug = props.slug || slugify(props.title);
  const existing = await findResponsibility(slug);
  const now = new Date().toISOString();
  const properties = { kind: "responsibility_item", status: "active", cadenceDays: 7, estimatedMinutes: 30, capacityBucket: "work_admin", ...props, slug, updatedAt: now };
  if (existing) return blockDB.updateBlock(existing.id, { properties: { ...existing.properties, ...properties, createdAt: existing.properties.createdAt || now } });
  return blockDB.createBlock({ type: "block", properties: { ...properties, createdAt: now }, user_id: USER_ID, workspace_id: WORKSPACE_ID });
}

async function createTask(resp, alert) {
  const date = todayET();
  const dup = await pool.query(
    `SELECT id FROM blocks
     WHERE type='block' AND properties->>'kind'='responsibility_task'
       AND properties->>'alertKey'=$1 AND workspace_id=$2 AND deleted_at IS NULL
     LIMIT 1`,
    [alert.alertKey, WORKSPACE_ID]
  );
  if (dup.rows.length) return { duplicate: true, id: dup.rows[0].id };

  const localId = "resp-task-" + crypto.randomUUID().slice(0, 12);
  const block = await blockDB.createBlock({
    type: "block",
    date,
    sort_order: 9 * 60,
    user_id: USER_ID,
    workspace_id: WORKSPACE_ID,
    properties: {
      kind: "responsibility_task",
      local_id: localId,
      title: alert.title,
      duration: 30,
      start: "09:00",
      end: "09:30",
      priority: "High",
      meta: "Responsibility · bug_management · 30m",
      detail: alert.detail,
      source: "responsibility",
      tags: ["responsibility", "professional", "bug_management"],
      responsibilityId: resp.id,
      responsibilityTitle: resp.properties.title,
      alertType: "offers_amp_zero_expected_matches",
      alertKey: alert.alertKey,
      ampUrl: alert.ampUrl,
      hubspotUrl: alert.hubspotUrl,
      createdAt: new Date().toISOString()
    }
  });
  const rootId = await blockDB.ensureDayRoot(date, USER_ID, WORKSPACE_ID);
  const root = await blockDB.getBlock(rootId);
  const subtasks = [
    "Open AMP deal link",
    "Open HubSpot deal link",
    "Check Matching & Delays config for the listed combo",
    "Record root cause or resolution note",
    "Escalate/update product team if config or automation needs a fix"
  ];
  await blockDB.updateBlock(rootId, { properties: { ...root.properties, _subtasks: { ...(root.properties._subtasks || {}), [localId]: subtasks.map((text, i) => ({ id: "st-" + Date.now() + "-" + i, text, done: false, created: new Date().toISOString() })) } } });
  return { duplicate: false, id: block.id, localId };
}

async function ensureOffersAmpTrigger(resp) {
  const slug = "offers-amp-zero-expected-matches";
  const existing = await pool.query(
    `SELECT id FROM blocks
     WHERE type='block' AND properties->>'kind'='responsibility_trigger'
       AND properties->>'slug'=$1 AND workspace_id=$2 AND deleted_at IS NULL
     LIMIT 1`,
    [slug, WORKSPACE_ID]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const trigger = await blockDB.createBlock({
    type: "block",
    parent_id: resp.id,
    user_id: USER_ID,
    workspace_id: WORKSPACE_ID,
    properties: {
      kind: "responsibility_trigger",
      slug,
      title: "Offers AMP zero expected matches",
      channel: "#offers_product",
      responsibilityId: resp.id,
      alertType: "offers_amp_zero_expected_matches",
      createdAt: new Date().toISOString()
    }
  });
  return trigger.id;
}

(async function main() {
  const text = parseInput();
  if (!text) throw new Error("Provide text or --file");
  const alert = parseOffersAmpAlert(text);
  if (alert) {
    const resp = await upsertResponsibility({
      title: "Product Development: Bug Management",
      slug: "product-development-bug-management",
      domain: "professional",
      area: "bug_management",
      defaultSubtasks: [
        "Open AMP deal link",
        "Open HubSpot deal link",
        "Check Matching & Delays config for the listed combo",
        "Record root cause or resolution note",
        "Escalate/update product team if config or automation needs a fix"
      ]
    });
    await ensureOffersAmpTrigger(resp);
    const task = await createTask(resp, alert);
    console.log(JSON.stringify({ responsibilityId: resp.id, task }, null, 2));
  } else {
    const resp = await upsertResponsibility({ title: text.split(/\r?\n/)[0].slice(0, 120), rawCapture: text, domain: "other", area: "inbox", status: "inbox" });
    console.log(JSON.stringify({ responsibilityId: resp.id, captured: true }, null, 2));
  }
})().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
}).finally(() => pool.end());
