/**
 * slot-account-common.js — primitives shared by the rewards engine (slot-store)
 * and the punishments wheel (punishment-store).
 *
 * Both features live on the SAME slot_accounts row (shared bank_balance_cents +
 * settings blob), so the account bootstrap, the money-movement invariant, the
 * monthly-goal clamp, and the http-error shape must be ONE implementation, not a
 * copy in each store. Every function takes its db/client handle as a parameter
 * so this module has no pool dependency (and stays trivially testable).
 */

"use strict";

const DEFAULT_MONTHLY_GOAL_CENTS = 10000;
const MONTHLY_MIN = 100;
const MONTHLY_MAX = 1000000;

/** Clamp + round a monthly cents amount into the allowed band. */
function clampMonthly(n) {
  return Math.max(MONTHLY_MIN, Math.min(MONTHLY_MAX, Math.round(Number(n) || 0)));
}

/** Error carrying an HTTP status so route handlers can map it (vs a blind 500). */
function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}
const badRequest = (message) => httpError(message, 400);
const notFound = (message) => httpError(message, 404);

/**
 * Idempotently ensure the slot_accounts row for a workspace exists and returns
 * it. This is the exact upsert both stores ran; `db` may be a pool or an open
 * client (so it can participate in a caller's transaction). Note: this does NOT
 * run schema/seed migrations — slot-store layers those on top in its own
 * ensureAccount; punishments only need the row.
 */
async function upsertSlotAccountRow(db, workspaceId, userId) {
  const { rows } = await db.query(
    `INSERT INTO slot_accounts (workspace_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET user_id = COALESCE(slot_accounts.user_id, EXCLUDED.user_id)
     RETURNING *`,
    [workspaceId, userId || null]
  );
  return rows[0];
}

/**
 * Apply a money delta to one account in BOTH dimensions the rewards economy
 * cares about: the unlocked reserve (bank_balance_cents) and the monthly reward
 * allocation. The allocation lives in two places that must move together —
 * settings.monthly_goal_cents (what the UI/engine reads) and its source of truth
 * settings.economy_profile.monthly_discretionary_cents (which any future settings
 * save recomputes monthly_goal_cents from). Reads FOR UPDATE, spreads existing
 * settings, and writes back so no other keys are clobbered. Must run inside the
 * caller's transaction (`client`). Returns null if the account row is missing.
 */
async function applyMoneyDelta(client, workspaceId, deltaCents) {
  const { rows: [acct] } = await client.query(
    "SELECT bank_balance_cents, settings FROM slot_accounts WHERE workspace_id = $1 FOR UPDATE",
    [workspaceId]
  );
  if (!acct) return null;
  const settings = acct.settings && typeof acct.settings === "object" ? acct.settings : {};
  const profile = settings.economy_profile && typeof settings.economy_profile === "object" ? settings.economy_profile : {};
  const curGoal = Number.isFinite(+settings.monthly_goal_cents) ? +settings.monthly_goal_cents : DEFAULT_MONTHLY_GOAL_CENTS;
  const curDiscretionary = Number.isFinite(+profile.monthly_discretionary_cents) ? +profile.monthly_discretionary_cents : curGoal;
  const nextSettings = {
    ...settings,
    monthly_goal_cents: clampMonthly(curGoal + deltaCents),
    economy_profile: { ...profile, monthly_discretionary_cents: clampMonthly(curDiscretionary + deltaCents) },
  };
  const { rows: [upd] } = await client.query(
    `UPDATE slot_accounts
        SET bank_balance_cents = GREATEST(0, bank_balance_cents + $2), settings = $3, updated_at = NOW()
      WHERE workspace_id = $1
      RETURNING bank_balance_cents, settings`,
    [workspaceId, deltaCents, nextSettings]
  );
  return {
    bankBalanceCents: upd.bank_balance_cents,
    monthlyGoalCents: upd.settings.monthly_goal_cents,
  };
}

module.exports = {
  DEFAULT_MONTHLY_GOAL_CENTS,
  MONTHLY_MIN,
  MONTHLY_MAX,
  clampMonthly,
  httpError,
  badRequest,
  notFound,
  upsertSlotAccountRow,
  applyMoneyDelta,
};
