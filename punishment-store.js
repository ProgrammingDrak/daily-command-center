/**
 * punishment-store.js — Punishments Wheel (flat weighted mirror of slot-store)
 *
 * Intentionally simpler than slot-store: one flat list of punishments, each with
 * a "chances" weight. Odds = chance_shares / Σ active chance_shares. A manual
 * "owed spins" counter (stored in slot_accounts.settings.punishments_owed) is
 * bumped when you slip; spinning pays it down. Money punishments carry a negative
 * bank_delta_cents that moves the shared slot_accounts.bank_balance_cents pot.
 *
 * Reuses the rewards engine's weighted picker (chooseWeighted) and the same
 * GREATEST(0, bank_balance_cents + delta) clamp idiom used in slot-store.
 */

const pool = require("./pg-pool");
const { chooseWeighted } = require("./slot-store");
const auth = require("./auth");

// Mirrors slot-store's monthly clamp (settings.monthly_goal_cents and its source
// of truth economy_profile.monthly_discretionary_cents are both clamped here).
const DEFAULT_MONTHLY_GOAL_CENTS = 10000;
const MONTHLY_MIN = 100;
const MONTHLY_MAX = 1000000;
function clampMonthly(n) {
  return Math.max(MONTHLY_MIN, Math.min(MONTHLY_MAX, Math.round(Number(n) || 0)));
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

// Minimal account bootstrap — mirrors slot-store.ensureAccount's upsert without
// the rewards-specific migrations/seeding. We only need the row so we can read
// bank_balance_cents and stash the owed counter inside settings.
async function ensureAccount(workspaceId, userId) {
  const { rows } = await pool.query(
    `INSERT INTO slot_accounts (workspace_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET user_id = COALESCE(slot_accounts.user_id, EXCLUDED.user_id)
     RETURNING *`,
    [workspaceId, userId || null]
  );
  return rows[0];
}

function readOwed(settings) {
  const raw = settings && settings.punishments_owed;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Update only the punishments_owed key so we never clobber the rich rewards
// settings blob living in the same JSONB column.
async function writeOwed(client, workspaceId, value) {
  const v = Math.max(0, Math.floor(value));
  await (client || pool).query(
    `UPDATE slot_accounts
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{punishments_owed}', to_jsonb($2::int), true),
            updated_at = NOW()
      WHERE workspace_id = $1`,
    [workspaceId, v]
  );
  return v;
}

function normalizePunishmentInput(body = {}) {
  const title = String(body.title || "").trim();
  if (!title) throw badRequest("title required");
  const chanceShares = Math.max(
    0,
    parseInt(body.chance_shares ?? body.chanceShares ?? body.weight, 10) || 0
  );
  // Accept an explicit cents delta (round-trip from the card), otherwise derive
  // it from a positive dollar amount entered in the form (money you pay → negative).
  let bankDeltaCents;
  if (body.bank_delta_cents != null || body.bankDeltaCents != null) {
    const n = parseInt(body.bank_delta_cents ?? body.bankDeltaCents, 10);
    bankDeltaCents = Number.isFinite(n) ? n : 0;
  } else {
    const amount = Number(body.amount_dollars ?? body.amountDollars ?? 0);
    bankDeltaCents = Number.isFinite(amount) && amount > 0 ? -Math.round(amount * 100) : 0;
  }
  return {
    title,
    chance_shares: chanceShares,
    bank_delta_cents: bankDeltaCents,
    active: body.active !== false,
    notes: String(body.notes || ""),
  };
}

// Apply a money delta to one account in BOTH dimensions the rewards economy
// cares about: the unlocked reserve (bank_balance_cents) and the monthly reward
// allocation. The allocation lives in two places that must move together —
// settings.monthly_goal_cents (the value the UI/engine reads) and its source of
// truth settings.economy_profile.monthly_discretionary_cents (which any future
// settings save recomputes monthly_goal_cents from). We read the row FOR UPDATE,
// spread the existing settings, and write back so no other keys are clobbered.
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

// ── Partner link ──
// The punishment partner is the account that receives money punishments. It is
// stored on each side's slot_accounts.settings.punishment_partner so the link is
// symmetric (the partner's own punishments wheel pays back into this account).
function readPartner(settings) {
  const p = settings && settings.punishment_partner;
  return p && p.workspace_id ? p : null;
}

async function writePartner(workspaceId, partner) {
  await pool.query(
    `UPDATE slot_accounts
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{punishment_partner}', $2::jsonb, true),
            updated_at = NOW()
      WHERE workspace_id = $1`,
    [workspaceId, JSON.stringify(partner)]
  );
}

async function accountSummary(workspaceId) {
  const { rows: [a] } = await pool.query(
    "SELECT bank_balance_cents, settings FROM slot_accounts WHERE workspace_id = $1",
    [workspaceId]
  );
  if (!a) return null;
  const s = a.settings || {};
  return {
    bankBalanceCents: a.bank_balance_cents || 0,
    monthlyGoalCents: Number.isFinite(+s.monthly_goal_cents) ? +s.monthly_goal_cents : DEFAULT_MONTHLY_GOAL_CENTS,
  };
}

// Link an existing user as the punishment partner (symmetric, both sides).
async function linkPartner(workspaceId, userId, partnerUserId, partnerWorkspaceId, partnerUsername) {
  // Resolve this side's username for the reverse link.
  const { rows: [me] } = await pool.query("SELECT username FROM users WHERE id = $1", [userId]);
  await ensureAccount(partnerWorkspaceId, partnerUserId); // make sure partner has a slot account
  await writePartner(workspaceId, { workspace_id: partnerWorkspaceId, user_id: partnerUserId, username: partnerUsername });
  await writePartner(partnerWorkspaceId, { workspace_id: workspaceId, user_id: userId || null, username: (me && me.username) || null });
  return { workspace_id: partnerWorkspaceId, user_id: partnerUserId, username: partnerUsername };
}

async function resolveOwnerWorkspace(partnerUserId) {
  const { rows } = await pool.query(
    "SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1",
    [partnerUserId]
  );
  return rows[0] ? rows[0].workspace_id : `ws-${partnerUserId}`;
}

// Create a brand-new partner account (user + workspace) and link it.
async function createPartner(workspaceId, userId, { username, password }) {
  const uname = String(username || "").trim().toLowerCase();
  const { user, workspaceId: partnerWs } = await auth.registerUser({ username: uname, password });
  return linkPartner(workspaceId, userId, user.id, partnerWs, user.username || uname);
}

// Link a partner that already has an account, by username.
async function linkExistingPartner(workspaceId, userId, username) {
  const uname = String(username || "").trim().toLowerCase();
  if (!uname) throw badRequest("username required");
  const { rows: [u] } = await pool.query("SELECT id, username FROM users WHERE LOWER(username) = $1", [uname]);
  if (!u) throw notFound("No user with that username");
  if (userId && u.id === userId) throw badRequest("You can't set yourself as your partner");
  const partnerWs = await resolveOwnerWorkspace(u.id);
  return linkPartner(workspaceId, userId, u.id, partnerWs, u.username);
}

async function unlinkPartner(workspaceId) {
  const partner = readPartner((await ensureAccount(workspaceId)).settings);
  await pool.query(
    `UPDATE slot_accounts
        SET settings = settings - 'punishment_partner', updated_at = NOW()
      WHERE workspace_id = $1`,
    [workspaceId]
  );
  // Best-effort: clear the reverse link too.
  if (partner && partner.workspace_id) {
    await pool.query(
      `UPDATE slot_accounts SET settings = settings - 'punishment_partner', updated_at = NOW() WHERE workspace_id = $1`,
      [partner.workspace_id]
    );
  }
  return { ok: true };
}

async function getPunishmentState(workspaceId, userId) {
  const account = await ensureAccount(workspaceId, userId);
  const owed = readOwed(account.settings);
  const { rows: punishments } = await pool.query(
    `SELECT * FROM slot_punishments
      WHERE workspace_id = $1 AND deleted_at IS NULL
      ORDER BY active DESC, sort_order ASC, id ASC`,
    [workspaceId]
  );
  const totalShares = punishments
    .filter((p) => p.active)
    .reduce((sum, p) => sum + (Number(p.chance_shares) || 0), 0);
  const withOdds = punishments.map((p) => ({
    ...p,
    odds: p.active && totalShares > 0 ? (Number(p.chance_shares) || 0) / totalShares : 0,
  }));
  const { rows: spins } = await pool.query(
    `SELECT * FROM slot_punishment_spins
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 25`,
    [workspaceId]
  );
  const partnerLink = readPartner(account.settings);
  let partner = null;
  if (partnerLink) {
    const summary = await accountSummary(partnerLink.workspace_id);
    partner = { ...partnerLink, ...(summary || {}) };
  }
  const ownerSettings = account.settings || {};
  return {
    punishments: withOdds,
    totalShares,
    owed,
    bankBalanceCents: account.bank_balance_cents || 0,
    monthlyGoalCents: Number.isFinite(+ownerSettings.monthly_goal_cents) ? +ownerSettings.monthly_goal_cents : DEFAULT_MONTHLY_GOAL_CENTS,
    partner,
    spins,
  };
}

async function addOwedSpin(workspaceId, userId, n = 1) {
  const account = await ensureAccount(workspaceId, userId);
  const add = Math.max(1, parseInt(n, 10) || 1);
  const owed = await writeOwed(null, workspaceId, readOwed(account.settings) + add);
  return { owed };
}

async function createPunishment(workspaceId, userId, body) {
  await ensureAccount(workspaceId, userId);
  const input = normalizePunishmentInput(body);
  const { rows: [max] } = await pool.query(
    "SELECT COALESCE(MAX(sort_order), 0) AS m FROM slot_punishments WHERE workspace_id = $1",
    [workspaceId]
  );
  const sortOrder = (Number(max.m) || 0) + 1000;
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO slot_punishments
         (workspace_id, title, chance_shares, bank_delta_cents, active, sort_order, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [workspaceId, input.title, input.chance_shares, input.bank_delta_cents, input.active, sortOrder, input.notes]
    );
    return row;
  } catch (e) {
    if (e.code === "23505") throw badRequest("A punishment with that name already exists");
    throw e;
  }
}

async function updatePunishment(workspaceId, id, body) {
  const input = normalizePunishmentInput(body);
  const { rows: [row] } = await pool.query(
    `UPDATE slot_punishments
        SET title = $3, chance_shares = $4, bank_delta_cents = $5, active = $6, notes = $7, updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING *`,
    [workspaceId, id, input.title, input.chance_shares, input.bank_delta_cents, input.active, input.notes]
  );
  if (!row) throw notFound("punishment not found");
  return row;
}

async function deletePunishment(workspaceId, id) {
  await pool.query(
    `UPDATE slot_punishments
        SET active = FALSE, chance_shares = 0, deleted_at = NOW(), updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id]
  );
  return { ok: true };
}

async function reorderPunishments(workspaceId, items) {
  const list = Array.isArray(items) ? items : [];
  let order = 1000;
  for (const it of list) {
    const id = parseInt(it && (it.id ?? it), 10);
    if (!Number.isFinite(id)) continue;
    await pool.query(
      "UPDATE slot_punishments SET sort_order = $3, updated_at = NOW() WHERE workspace_id = $1 AND id = $2",
      [workspaceId, id, order]
    );
    order += 1000;
  }
  return { ok: true };
}

// Pay down one owed spin: pick a weighted punishment, log it pending, and apply
// any money delta to the shared bank immediately. All inside one transaction so
// the owed counter, the spin row, and the bank move atomically.
async function spinPunishment(workspaceId, userId) {
  await ensureAccount(workspaceId, userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [acct] } = await client.query(
      "SELECT * FROM slot_accounts WHERE workspace_id = $1 FOR UPDATE",
      [workspaceId]
    );
    const owed = readOwed(acct && acct.settings);
    if (owed <= 0) throw badRequest("No spins owed — you're square");

    const { rows: punishments } = await client.query(
      `SELECT * FROM slot_punishments
        WHERE workspace_id = $1 AND active = TRUE AND deleted_at IS NULL AND chance_shares > 0`,
      [workspaceId]
    );
    const selected = chooseWeighted(punishments, "chance_shares");
    if (!selected) throw badRequest("No active punishments to spin");

    const partnerLink = readPartner(acct && acct.settings);
    const bankDelta = Number(selected.bank_delta_cents) || 0; // negative = you pay
    const amount = -bankDelta;                                 // positive cents moved to partner
    const snapshot = {
      title: selected.title,
      bank_delta_cents: bankDelta,
      notes: selected.notes || "",
      paid_to: amount > 0 && partnerLink ? (partnerLink.username || null) : null,
    };
    const { rows: [spinRow] } = await client.query(
      `INSERT INTO slot_punishment_spins
         (workspace_id, user_id, punishment_id, punishment_snapshot, bank_delta_cents, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [workspaceId, userId || null, selected.id, JSON.stringify(snapshot), bankDelta]
    );
    await client.query(
      "UPDATE slot_punishments SET times_landed = times_landed + 1, updated_at = NOW() WHERE id = $1",
      [selected.id]
    );

    const newOwed = Math.max(0, owed - 1);
    await writeOwed(client, workspaceId, newOwed);

    let bankBalanceCents = (acct && acct.bank_balance_cents) || 0;
    let partnerResult = null;
    if (bankDelta !== 0) {
      // Debit the spinner: unlocked reserve AND monthly allocation both drop.
      const mine = await applyMoneyDelta(client, workspaceId, bankDelta);
      if (mine) bankBalanceCents = mine.bankBalanceCents;
      // Credit the partner the same amount into BOTH their reserve and monthly
      // allocation (zero-sum). No partner linked → the money simply leaves.
      if (partnerLink && partnerLink.workspace_id && amount > 0) {
        partnerResult = await applyMoneyDelta(client, partnerLink.workspace_id, amount);
      }
    }

    await client.query("COMMIT");
    return {
      spin: spinRow,
      punishment: selected,
      owed: newOwed,
      bankBalanceCents,
      amountCents: amount,
      partner: partnerLink ? { ...partnerLink, ...(partnerResult || {}) } : null,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function resolvePunishment(workspaceId, spinId) {
  const { rows: [row] } = await pool.query(
    `UPDATE slot_punishment_spins
        SET status = 'done', done_at = NOW()
      WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
      RETURNING *`,
    [workspaceId, spinId]
  );
  if (!row) throw notFound("pending punishment not found");
  return row;
}

module.exports = {
  getPunishmentState,
  addOwedSpin,
  createPunishment,
  updatePunishment,
  deletePunishment,
  reorderPunishments,
  spinPunishment,
  resolvePunishment,
  createPartner,
  linkExistingPartner,
  unlinkPartner,
};
