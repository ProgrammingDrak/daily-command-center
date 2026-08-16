/**
 * Reward Vault and Budget reward mechanics.
 *
 * slot_rewards remains the canonical definition table. A quick-add or overflow
 * award creates a tank instance linked by source_reward_id, which keeps claim
 * state and ordering independent from the reusable definition.
 */

const crypto = require("crypto");
const pool = require("./pg-pool");
const budgetStore = require("./budget-store");
const { badRequest, notFound, upsertSlotAccountRow } = require("./slot-account-common");

const MAX_CENTS = 100000000;
const POSITION_STEP = 1000;
const REUSE_MODES = new Set(["one_off", "reusable"]);

function int(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeVaultInput(body = {}, current = {}) {
  const title = String(body.title ?? current.title ?? "").trim().slice(0, 180);
  if (!title) throw badRequest("A vault item needs a title");
  const minCents = int(body.min_cents ?? body.minCents ?? current.vault_min_cents, 0, MAX_CENTS);
  const maxCents = int(body.max_cents ?? body.maxCents ?? body.value_cents ?? current.value_cents, 0, MAX_CENTS);
  if (minCents > maxCents) throw badRequest("Minimum price cannot exceed maximum price");
  const paymentSource = String(body.payment_source ?? body.paymentSource ?? current.payment_source ?? (maxCents ? "self" : "free"));
  const kind = String(body.kind ?? current.kind ?? (paymentSource === "sponsored" ? "sponsor" : maxCents ? "bank_gated" : "free"));
  const reuseMode = String(body.reuse_mode ?? body.reuseMode ?? current.vault_reuse_mode ?? "reusable");
  if (!REUSE_MODES.has(reuseMode)) throw badRequest("reuse_mode must be one_off or reusable");
  return {
    title,
    kind,
    payment_source: paymentSource,
    value_cents: maxCents,
    vault_min_cents: minCents,
    vault_reuse_mode: reuseMode,
    vault_quick_add: bool(body.quick_add ?? body.quickAdd, current.vault_quick_add ?? maxCents > 0),
    vault_random_draw: bool(body.random_draw ?? body.randomDraw, current.vault_random_draw ?? true),
    vault_milestone: bool(body.milestone ?? body.milestoneEligible, current.vault_milestone ?? maxCents === 0),
    sponsor_visible: !bool(body.private, current.sponsor_visible === false),
    chance_shares: int(body.chance_shares ?? body.chanceShares ?? current.chance_shares ?? 1, 0, 1000000),
    duration_minutes: int(body.duration_minutes ?? body.durationMinutes ?? current.duration_minutes, 0, 1440),
    cooldown_days: int(body.cooldown_days ?? body.cooldownDays ?? current.cooldown_days, 0, 365),
    notes: String(body.notes ?? current.notes ?? "").slice(0, 4000),
  };
}

function vaultItem(row) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    payment_source: row.payment_source,
    min_cents: row.vault_min_cents || 0,
    max_cents: row.value_cents || 0,
    reuse_mode: row.vault_reuse_mode || "reusable",
    quick_add: !!row.vault_quick_add,
    random_draw: !!row.vault_random_draw,
    milestone: !!row.vault_milestone,
    sponsor_visible: row.sponsor_visible !== false,
    private: row.sponsor_visible === false,
    chance_shares: row.chance_shares || row.weight || 0,
    duration_minutes: row.duration_minutes || 0,
    cooldown_days: row.cooldown_days || 0,
    notes: row.notes || "",
    sponsor_type: row.sponsor_type || "self",
    owner_user_id: row.owner_user_id || null,
    created_by_user_id: row.created_by_user_id || null,
  };
}

async function listDefinitions(workspaceId, { sponsorView = false } = {}, exec = pool) {
  const { rows } = await exec.query(
    `SELECT * FROM slot_rewards
      WHERE workspace_id=$1 AND vault_enabled=TRUE AND active=TRUE
        AND deleted_at IS NULL AND vault_archived_at IS NULL
        ${sponsorView ? "AND sponsor_visible=TRUE" : ""}
      ORDER BY CASE WHEN payment_source='sponsored' THEN 2 WHEN value_cents=0 THEN 1 ELSE 0 END,
               sort_order ASC, id ASC`,
    [workspaceId]
  );
  return rows;
}

async function currentBankUnits(workspaceId, periodType = "month", exec = pool) {
  const trunc = periodType === "week" ? "date_trunc('week', NOW())" : "date_trunc('month', NOW())";
  const { rows: [conversion] } = await exec.query(
    `SELECT COALESCE(SUM(points),0)::int AS units
       FROM budget_conversions WHERE workspace_id=$1 AND created_at >= ${trunc}`,
    [workspaceId]
  );
  const { rows: [casino] } = await exec.query(
    `SELECT COALESCE(SUM(
       CASE WHEN COALESCE(reward_snapshot->'bank_screen_payout'->>'units','') ~ '^[0-9]+$'
            THEN (reward_snapshot->'bank_screen_payout'->>'units')::int ELSE 0 END
     ),0)::int AS units
       FROM slot_spins
      WHERE workspace_id=$1 AND status='confirmed' AND bank_delta_cents > 0
        AND created_at >= ${trunc}`,
    [workspaceId]
  );
  return {
    total: (conversion && conversion.units || 0) + (casino && casino.units || 0),
    money_changer: conversion && conversion.units || 0,
    casino: casino && casino.units || 0,
  };
}

async function listMilestones(workspaceId, userId, settings, periodKey, exec = pool) {
  const progress = await currentBankUnits(workspaceId, settings.period_type, exec);
  const { rows } = await exec.query(
    `SELECT m.*, r.title AS reward_title
       FROM budget_reward_milestones m
       LEFT JOIN slot_rewards r ON r.id=m.reward_definition_id
      WHERE m.workspace_id=$1 AND (m.active=TRUE OR m.repeat_each_period=TRUE)
      ORDER BY m.threshold_bank_units ASC, m.id ASC`,
    [workspaceId]
  );
  return {
    progress,
    items: rows.map(row => {
      const claimedThisPeriod = row.claimed_period === periodKey;
      return {
        id: row.id,
        threshold_bank_units: row.threshold_bank_units,
        reward_definition_id: row.reward_definition_id,
        reward_title: row.reward_title || null,
        mystery: !row.reward_definition_id,
        repeat_each_period: !!row.repeat_each_period,
        active: !!row.active,
        reached: progress.total >= row.threshold_bank_units,
        claimable: progress.total >= row.threshold_bank_units && !claimedThisPeriod && (row.active || row.repeat_each_period),
        claimed: claimedThisPeriod,
      };
    }),
  };
}

async function listVault(workspaceId, userId, { sponsorView = false } = {}) {
  const account = await upsertSlotAccountRow(pool, workspaceId, userId);
  const settings = budgetStore.normalizeBudgetTankSettings(account.settings && account.settings.budget_tank);
  const usage = await budgetStore.getTankUsage(workspaceId, settings);
  const rows = await listDefinitions(workspaceId, { sponsorView });
  const milestones = sponsorView ? null : await listMilestones(workspaceId, userId, settings, usage.periodKey);
  return { items: rows.map(vaultItem), milestones, period_key: usage.periodKey };
}

async function createVaultItem(workspaceId, userId, body = {}) {
  const v = normalizeVaultInput(body);
  const { rows: [mx] } = await pool.query(
    "SELECT COALESCE(MAX(sort_order),0)+1000 AS next FROM slot_rewards WHERE workspace_id=$1",
    [workspaceId]
  );
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO slot_rewards
       (workspace_id,title,kind,sponsor_type,sponsor_splits,weight,chance_shares,payment_source,tier_id,
        active,sponsor_active,value_cents,bank_delta_cents,duration_minutes,requires_confirmation,
        cooldown_days,unlock_threshold_cents,notes,uses_remaining,sort_order,owner_user_id,created_by_user_id,
        vault_enabled,vault_reuse_mode,vault_min_cents,vault_quick_add,vault_random_draw,vault_milestone,
        sponsor_visible,public_visibility)
       VALUES ($1,$2,$3,$4,'[]',$5,$5,$6,'tier_i',TRUE,TRUE,$7,0,$8,FALSE,$9,0,$10,$11,$12,$13,$13,
               TRUE,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [workspaceId, v.title, v.kind, v.payment_source === "sponsored" ? "accountability_partner" : "self",
       v.chance_shares, v.payment_source, v.value_cents, v.duration_minutes, v.cooldown_days, v.notes,
       v.vault_reuse_mode === "one_off" ? 1 : null, Number(mx && mx.next) || 1000, userId || null,
       v.vault_reuse_mode, v.vault_min_cents, v.vault_quick_add, v.vault_random_draw, v.vault_milestone,
       v.sponsor_visible, v.sponsor_visible ? "public" : "private"]
    );
    return vaultItem(row);
  } catch (err) {
    if (err && err.code === "23505") throw badRequest("A vault item with that title already exists");
    throw err;
  }
}

async function updateVaultItem(workspaceId, id, body = {}) {
  const rewardId = int(id);
  const { rows: [current] } = await pool.query(
    "SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2 AND vault_enabled=TRUE AND deleted_at IS NULL",
    [workspaceId, rewardId]
  );
  if (!current) throw notFound("Vault item not found");
  const v = normalizeVaultInput(body, current);
  const { rows: [row] } = await pool.query(
    `UPDATE slot_rewards SET title=$3,kind=$4,payment_source=$5,value_cents=$6,vault_min_cents=$7,
       vault_reuse_mode=$8,vault_quick_add=$9,vault_random_draw=$10,vault_milestone=$11,
       sponsor_visible=$12,public_visibility=$13,chance_shares=$14,weight=$14,duration_minutes=$15,
       cooldown_days=$16,notes=$17,uses_remaining=$18,updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, rewardId, v.title, v.kind, v.payment_source, v.value_cents, v.vault_min_cents,
     v.vault_reuse_mode, v.vault_quick_add, v.vault_random_draw, v.vault_milestone,
     v.sponsor_visible, v.sponsor_visible ? "public" : "private", v.chance_shares,
     v.duration_minutes, v.cooldown_days, v.notes, v.vault_reuse_mode === "one_off" ? 1 : null]
  );
  return vaultItem(row);
}

async function archiveVaultItem(workspaceId, id) {
  const { rows } = await pool.query(
    `UPDATE slot_rewards SET vault_enabled=FALSE,vault_archived_at=NOW(),updated_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND vault_enabled=TRUE AND deleted_at IS NULL RETURNING id`,
    [workspaceId, int(id)]
  );
  if (!rows[0]) throw notFound("Vault item not found");
  return { ok: true };
}

function descriptionFromTitle(title) {
  const match = String(title || "").match(/^[^:]+:\s*(.+)$/);
  return match ? match[1] : String(title || "");
}

async function insertTankClone(client, workspaceId, userId, definition, { claimedPeriod = null } = {}) {
  const purchase = budgetStore.normalizeBlockInput({
    description: descriptionFromTitle(definition.title),
    amount_cents: definition.value_cents,
    duration_minutes: definition.duration_minutes,
  });
  const { rows: [mx] } = await client.query(
    "SELECT COALESCE(MAX(tank_position),0)+1000 AS next FROM slot_rewards WHERE workspace_id=$1 AND tank_position IS NOT NULL AND deleted_at IS NULL",
    [workspaceId]
  );
  const { rows: [row] } = await client.query(
    `INSERT INTO slot_rewards
     (workspace_id,title,kind,sponsor_type,sponsor_splits,weight,chance_shares,payment_source,tier_id,
      active,sponsor_active,value_cents,bank_delta_cents,duration_minutes,requires_confirmation,cooldown_days,
      unlock_threshold_cents,notes,uses_remaining,sort_order,owner_user_id,created_by_user_id,tank_position,
      tank_unlock_cents,tank_category,tank_color,tank_recurring,tank_claimed_period,source_reward_id,vault_enabled)
     VALUES ($1,$2,'bank_gated','self','[]',1,1,'self','tier_i',TRUE,TRUE,$3,0,$4,FALSE,0,0,$5,1,$6,$7,$7,
             $6,0,$8,$9,FALSE,$10,$11,FALSE)
     RETURNING *`,
    [workspaceId, purchase.title, definition.value_cents, definition.duration_minutes || 0,
     definition.notes || "", Number(mx && mx.next) || POSITION_STEP, userId || null,
     purchase.category, purchase.color, claimedPeriod, definition.id]
  );
  await budgetStore.recomputeTankThresholds(client, workspaceId);
  return row;
}

async function quickAdd(workspaceId, userId, id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [definition] } = await client.query(
      `SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2 AND vault_enabled=TRUE
        AND vault_quick_add=TRUE AND active=TRUE AND deleted_at IS NULL AND vault_archived_at IS NULL FOR UPDATE`,
      [workspaceId, int(id)]
    );
    if (!definition) throw notFound("Quick-add vault item not found");
    if ((definition.value_cents || 0) <= 0) throw badRequest("Free rewards use a self-care checkpoint");
    const block = await insertTankClone(client, workspaceId, userId, definition);
    if (definition.vault_reuse_mode === "one_off") {
      await client.query("UPDATE slot_rewards SET vault_enabled=FALSE,vault_archived_at=NOW(),updated_at=NOW() WHERE id=$1", [definition.id]);
    }
    await client.query("COMMIT");
    return { block, item: vaultItem(definition) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

function weightedChoice(rows, rng = Math.random) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.chance_shares || row.weight || 0), 0);
  if (!rows.length || total <= 0) return null;
  let needle = rng() * total;
  for (const row of rows) {
    needle -= Math.max(0, row.chance_shares || row.weight || 0);
    if (needle < 0) return row;
  }
  return rows[rows.length - 1];
}

async function overflowSpin(workspaceId, userId, { source_key, sweepPendingBankBuilders, rng = Math.random } = {}) {
  const sourceKey = String(source_key || "").trim();
  if (!sourceKey) throw badRequest("source_key is required");
  await upsertSlotAccountRow(pool, workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [existing] } = await client.query(
      `SELECT o.*,r.title FROM budget_overflow_spins o LEFT JOIN slot_rewards r ON r.id=o.reward_definition_id
        WHERE o.workspace_id=$1 AND o.source_key=$2`, [workspaceId, sourceKey]
    );
    if (existing) { await client.query("COMMIT"); return { duplicate: true, spin: existing }; }
    if (typeof sweepPendingBankBuilders === "function") await sweepPendingBankBuilders(client, workspaceId);
    const { rows: [account] } = await client.query("SELECT * FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE", [workspaceId]);
    const settings = budgetStore.normalizeBudgetTankSettings(account.settings && account.settings.budget_tank);
    const usage = await budgetStore.getTankUsage(workspaceId, settings, client);
    const { waterlineCents } = budgetStore.resolveTankWaterline(settings, usage);
    const { rows: [planned] } = await client.query(
      "SELECT COALESCE(SUM(value_cents),0)::int AS cents FROM slot_rewards WHERE workspace_id=$1 AND tank_position IS NOT NULL AND deleted_at IS NULL",
      [workspaceId]
    );
    const overflow = Math.max(0, Math.min(waterlineCents - (planned.cents || 0), account.bank_balance_cents || 0));
    if (overflow <= 0) throw badRequest("There is no spendable overflow yet");
    const { rows: choices } = await client.query(
      `SELECT * FROM slot_rewards WHERE workspace_id=$1 AND vault_enabled=TRUE AND vault_random_draw=TRUE
        AND active=TRUE AND deleted_at IS NULL AND vault_archived_at IS NULL
        AND payment_source='self' AND kind IN ('small_paid','bank_gated')
        AND value_cents > 0 AND value_cents <= $2 FOR UPDATE`,
      [workspaceId, overflow]
    );
    const definition = weightedChoice(choices, rng);
    if (!definition) throw badRequest("Add an affordable paid reward to the Vault before spinning");
    const block = await insertTankClone(client, workspaceId, userId, definition, { claimedPeriod: usage.periodKey });
    await client.query("UPDATE slot_accounts SET bank_balance_cents=bank_balance_cents-$2,updated_at=NOW() WHERE workspace_id=$1", [workspaceId, definition.value_cents]);
    if (definition.vault_reuse_mode === "one_off") {
      await client.query("UPDATE slot_rewards SET vault_enabled=FALSE,vault_archived_at=NOW(),updated_at=NOW() WHERE id=$1", [definition.id]);
    }
    const { rows: [spin] } = await client.query(
      `INSERT INTO budget_overflow_spins(workspace_id,user_id,source_key,reward_definition_id,tank_block_id,amount_cents)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [workspaceId, userId || null, sourceKey, definition.id, block.id, definition.value_cents]
    );
    await client.query("COMMIT");
    return { duplicate: false, spin, block, reward: definition, overflow_before_cents: overflow };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

async function createMilestone(workspaceId, userId, body = {}) {
  const threshold = int(body.threshold_bank_units ?? body.thresholdBankUnits, 1, 1000000);
  const rewardId = body.reward_definition_id ?? body.rewardDefinitionId;
  if (rewardId) await assertFreeReward(workspaceId, rewardId);
  const { rows: [row] } = await pool.query(
    `INSERT INTO budget_reward_milestones
     (workspace_id,owner_user_id,threshold_bank_units,reward_definition_id,repeat_each_period)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [workspaceId, userId || null, threshold, rewardId ? int(rewardId) : null,
     bool(body.repeat_each_period ?? body.repeatEachPeriod)]
  );
  return row;
}

async function updateMilestone(workspaceId, id, body = {}) {
  const threshold = int(body.threshold_bank_units ?? body.thresholdBankUnits, 1, 1000000);
  const rewardId = body.reward_definition_id ?? body.rewardDefinitionId;
  if (rewardId) await assertFreeReward(workspaceId, rewardId);
  const { rows: [row] } = await pool.query(
    `UPDATE budget_reward_milestones SET threshold_bank_units=$3,reward_definition_id=$4,
       repeat_each_period=$5,updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, int(id), threshold, rewardId ? int(rewardId) : null,
     bool(body.repeat_each_period ?? body.repeatEachPeriod)]
  );
  if (!row) throw notFound("Self-care checkpoint not found");
  return row;
}

async function deleteMilestone(workspaceId, id) {
  const { rows } = await pool.query(
    "UPDATE budget_reward_milestones SET active=FALSE,updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING id",
    [workspaceId, int(id)]
  );
  if (!rows[0]) throw notFound("Self-care checkpoint not found");
  return { ok: true };
}

async function assertFreeReward(workspaceId, id, exec = pool) {
  const { rows: [reward] } = await exec.query(
    `SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2 AND vault_enabled=TRUE AND active=TRUE
      AND deleted_at IS NULL AND vault_archived_at IS NULL AND value_cents=0
      AND payment_source='free'`, [workspaceId, int(id)]
  );
  if (!reward) throw badRequest("Choose an active free reward from the Vault");
  return reward;
}

async function resolveMilestone(workspaceId, userId, id, { mode = "specific", reward_id, rng = Math.random } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query("SELECT * FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE", [workspaceId]);
    const settings = budgetStore.normalizeBudgetTankSettings(account && account.settings && account.settings.budget_tank);
    const usage = await budgetStore.getTankUsage(workspaceId, settings, client);
    const progress = await currentBankUnits(workspaceId, settings.period_type, client);
    const { rows: [milestone] } = await client.query(
      "SELECT * FROM budget_reward_milestones WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [workspaceId, int(id)]
    );
    if (!milestone) throw notFound("Self-care checkpoint not found");
    if (milestone.claimed_period === usage.periodKey) {
      // Retry reads include an archived one-off definition so an interrupted
      // response can still rebuild the same queue payload without a new award.
      const { rows: [reward] } = milestone.resolved_reward_id
        ? await client.query("SELECT * FROM slot_rewards WHERE workspace_id=$1 AND id=$2", [workspaceId, milestone.resolved_reward_id])
        : { rows: [] };
      await client.query("COMMIT");
      return { duplicate: true, milestone, reward, period_key: usage.periodKey };
    }
    if (!milestone.active && !milestone.repeat_each_period) throw badRequest("That checkpoint is no longer active");
    if (progress.total < milestone.threshold_bank_units) throw badRequest("That checkpoint has not been reached yet");
    let reward;
    if (milestone.reward_definition_id) reward = await assertFreeReward(workspaceId, milestone.reward_definition_id, client);
    else if (mode === "choose") reward = await assertFreeReward(workspaceId, reward_id, client);
    else {
      const { rows } = await client.query(
        `SELECT * FROM slot_rewards WHERE workspace_id=$1 AND vault_enabled=TRUE AND active=TRUE
          AND deleted_at IS NULL AND vault_archived_at IS NULL AND value_cents=0 AND payment_source='free' FOR UPDATE`,
        [workspaceId]
      );
      reward = weightedChoice(rows, rng);
      if (!reward) throw badRequest("Add a free reward to the Vault before spinning");
    }
    const { rows: [updated] } = await client.query(
      `UPDATE budget_reward_milestones SET claimed_period=$3,resolved_reward_id=$4,
       active=CASE WHEN repeat_each_period THEN TRUE ELSE FALSE END,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [workspaceId, milestone.id, usage.periodKey, reward.id]
    );
    if (reward.vault_reuse_mode === "one_off") {
      await client.query("UPDATE slot_rewards SET vault_enabled=FALSE,vault_archived_at=NOW(),updated_at=NOW() WHERE id=$1", [reward.id]);
    }
    await client.query("COMMIT");
    return { duplicate: false, milestone: updated, reward, period_key: usage.periodKey };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

async function getSponsorLink(workspaceId, userId) {
  const { rows: [row] } = await pool.query(
    "SELECT * FROM sponsor_share_links WHERE workspace_id=$1 AND owner_user_id=$2",
    [workspaceId, userId]
  );
  return row || null;
}

async function rotateSponsorLink(workspaceId, userId) {
  const token = crypto.randomBytes(24).toString("base64url");
  const { rows: [row] } = await pool.query(
    `INSERT INTO sponsor_share_links(owner_user_id,workspace_id,token,active)
     VALUES($1,$2,$3,TRUE)
     ON CONFLICT(owner_user_id) DO UPDATE SET token=EXCLUDED.token,active=TRUE,updated_at=NOW()
     RETURNING *`, [userId, workspaceId, token]
  );
  return row;
}

async function revokeSponsorLink(workspaceId, userId) {
  await pool.query("UPDATE sponsor_share_links SET active=FALSE,updated_at=NOW() WHERE workspace_id=$1 AND owner_user_id=$2", [workspaceId, userId]);
  return { ok: true };
}

async function resolveSponsorToken(token) {
  const { rows: [row] } = await pool.query("SELECT * FROM sponsor_share_links WHERE token=$1 AND active=TRUE", [String(token || "")]);
  if (!row) throw notFound("Sponsor link not found");
  return row;
}

module.exports = {
  normalizeVaultInput,
  vaultItem,
  weightedChoice,
  listVault,
  listDefinitions,
  currentBankUnits,
  createVaultItem,
  updateVaultItem,
  archiveVaultItem,
  quickAdd,
  overflowSpin,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  resolveMilestone,
  getSponsorLink,
  rotateSponsorLink,
  revokeSponsorLink,
  resolveSponsorToken,
};
