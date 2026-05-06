const crypto = require("crypto");
const pool = require("./pg-pool");

const DEFAULT_SPIN_COST = 1;
const DAILY_BANK_CAP_CENTS = 5000;
const WEEKLY_BANK_CAP_CENTS = 15000;

const SPONSOR_TYPES = new Set(["self", "accountability_partner", "romantic_partner", "either_partner"]);
const REWARD_KINDS = new Set(["miss", "free", "small_paid", "bank_gated", "bank_builder", "sponsor", "choice", "reroll"]);

const DEFAULT_REWARDS = [
  ...[
    ["Straw frame - keep building", 240],
    ["Stick frame - no prize yet", 220],
    ["Brick frame - almost there", 200],
    ["Hard hat - keep stacking", 190],
    ["Blueprint - no prize this spin", 180],
    ["Foundation poured - keep building", 180],
    ["Empty lot - try again", 170],
    ["Roofline started - keep going", 160],
    ["Bonus tease - no reveal", 150],
    ["Almost framed - no prize", 150],
    ["Dry spin - bank stays put", 140],
    ["Crew break - no prize", 130],
    ["Permit delay - spin again later", 120],
    ["Paint sample - no prize", 110],
    ["Tool check - keep earning", 110],
  ].map(([title, weight]) => reward({ title, kind: "miss", weight, notes: "No-prize outcome that keeps rewards from landing every spin." })),
  ...[
    "Take a guilt-free 30-minute nap",
    "Take a long shower or bath",
    "Go on a walk with no productivity goal",
    "Do a no chores for one hour block",
    "Watch one comfort episode",
    "Play a game for 30 minutes",
    "Read for pleasure for 30 minutes",
    "Sit outside with coffee/tea",
    "Order your day by vibes for one hour",
    "Make a favorite homemade snack",
    "Take a scenic drive",
    "Visit a library or bookstore and browse",
    "Do a cozy reset: blanket, candle, music",
    "Sleep in by 30 minutes",
    "Take a lunch away from screens",
    "Use fancy mug/plate/glass mode",
    "Do a low-effort creative session",
    "Have a no optimization evening",
    "Pick tomorrow's first task to be easy",
    "Move one non-urgent task to another day",
    "Declare a tiny win and stop working after essentials",
    "Do a hobby sprint: music, writing, drawing, coding-for-fun",
    "Have a solo cafe/library work block",
    "Rewatch a favorite movie",
    "Make a nostalgic meal",
    "Take a phone-free hour",
    "Window-shop a wishlist without buying",
    "Do a permission to be mediocre task pass",
    "Take a recovery walk after work",
    "Have a deluxe bedtime routine",
  ].map(title => reward({ title, kind: "free", weight: 16 })),
  ...[
    ["Buy a fancy coffee", 700],
    ["Buy a bakery treat", 700],
    ["Buy a new notebook or pen", 1200],
    ["Buy a $5-$10 app/game/book", 1000],
    ["Get takeout within a small cap", 1800],
    ["Buy a plant", 1500],
    ["Buy a candle", 1800],
    ["Buy a small desk upgrade", 2000],
    ["Buy a bath/shower upgrade", 1500],
    ["Buy a used book", 1200],
    ["Buy a fun drink/snack", 800],
    ["Pay for one month of a small subscription", 1500],
    ["Buy a comfort item under a configured cap", 2500],
    ["Upgrade dinner ingredients", 2000],
    ["Rent a movie", 600],
    ["Go to a matinee", 1800],
    ["Get a car wash", 1500],
    ["Buy a small piece of art/poster/sticker", 1200],
    ["Buy a puzzle/model/LEGO-style small set", 2500],
    ["Buy one wishlist item under jackpot", 3000],
  ].map(([title, value]) => reward({ title, kind: "small_paid", weight: 7, value_cents: value, unlock_threshold_cents: value, requires_confirmation: true })),
  ...[
    ["Buy a wishlist item up to current bank value", 5000],
    ["Take a random PTO day", 15000],
    ["Take a half-day off", 8000],
    ["Book a massage", 9000],
    ["Buy a larger hobby/tool upgrade", 12000],
    ["Weekend day trip fund", 15000],
    ["Nice dinner fund", 10000],
    ["Hotel night / staycation fund", 20000],
    ["Concert/event ticket fund", 12000],
    ["Clothing/shoes upgrade", 10000],
    ["Home office upgrade", 15000],
    ["Gaming/hobby hardware fund", 20000],
    ["Premium class/course/workshop", 15000],
    ["Big ridiculous thing fund", 50000],
  ].map(([title, value]) => reward({ title, kind: "bank_gated", weight: 3, value_cents: value, unlock_threshold_cents: value, requires_confirmation: true, cooldown_days: 14 })),
  ...[
    "Partner sends a congratulatory voice note",
    "Partner chooses a fun free challenge reward",
    "Partner validates one completed hard thing",
    "Partner brings/sends coffee",
    "Partner sponsors a treat under a cap",
    "Partner covers a meal or dessert",
    "Partner joins a walk",
    "Partner plans a low-cost outing",
    "Partner gives a skip one obligation coupon they can reasonably cover",
    "Partner contributes a pledge to the bank",
    "Partner picks from your wishlist under sponsor cap",
    "Partner schedules a celebration check-in",
    "Partner gives you a brag audit",
    "Partner unlocks a shared activity",
  ].map(title => reward({ title, kind: "sponsor", sponsor_type: "accountability_partner", weight: 5, sponsor_active: false, requires_confirmation: true })),
  ...[
    "Cuddle/movie night",
    "Partner-planned date at home",
    "Partner makes or picks dinner",
    "Massage/back rub",
    "Love note / appreciation note",
    "Partner handles one agreed chore",
    "Partner chooses a shared playlist night",
    "Partner plans a walk/date",
    "Partner makes dessert or drinks",
    "Partner sponsors flowers or small gift",
    "Partner picks a romantic surprise under cap",
    "Partner contributes to trip/date bank",
    "Partner gives a full attention hour",
    "Partner plans a cozy no-phone evening",
    "Partner helps execute a larger reward when jackpot unlocks it",
  ].map(title => reward({ title, kind: "sponsor", sponsor_type: "romantic_partner", weight: 5, sponsor_active: false, requires_confirmation: true })),
  ...[
    ["Bank builder: add $0.10", 10, 180],
    ["Bank builder: add $0.25", 25, 154],
    ["Bank builder: add $0.50", 50, 141],
    ["Bank builder: add $0.75", 75, 116],
    ["Bank builder: add $1", 100, 103],
    ["Bank builder: add $2", 200, 72],
    ["Bank builder: add spare-change dime", 10, 129],
    ["Bank builder: add two quarters", 50, 116],
    ["Bank builder: add tiny session bounty", 100, 90],
    ["Put $5 into the bank", 500, 8],
    ["Put $10 into the bank", 1000, 6],
    ["Put $25 into the bank", 2500, 3],
    ["Put $50 into the bank", 5000, 1],
    ["Round up today's purchases into the bank", 500, 5],
    ["Move unused eating-out budget into the bank", 1500, 4],
    ["Add money saved from choosing a free reward", 1000, 4],
    ["Bank the sale delta from a cheaper wishlist item", 1000, 3],
    ["Add refund/rebate/cashback money", 1000, 3],
    ["Add no-spend-day bonus", 1000, 5],
    ["Add sponsor pledge", 1500, 3],
    ["Add streak bonus from completed days", 1000, 4],
    ["Add hard task bounty", 1000, 4],
    ["Add deep work bounty after focused time", 1000, 4],
    ["Add weekly leftover discretionary budget", 2500, 2],
    ["Add partner/accountability match, capped weekly", 2000, 2],
  ].map(([title, delta, weight]) => reward({ title, kind: "bank_builder", weight, bank_delta_cents: delta, requires_confirmation: true })),
  reward({ title: "Pick one of three eligible rewards", kind: "choice", weight: 2, requires_confirmation: true }),
  reward({ title: "Free reroll", kind: "reroll", weight: 2 }),
];

function reward(data) {
  return {
    sponsor_type: "self",
    weight: 1,
    active: true,
    sponsor_active: true,
    value_cents: 0,
    bank_delta_cents: 0,
    requires_confirmation: false,
    cooldown_days: 0,
    unlock_threshold_cents: 0,
    notes: "",
    ...data,
  };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slot_accounts (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
      user_id INTEGER REFERENCES users(id),
      point_balance INTEGER NOT NULL DEFAULT 0,
      bank_balance_cents INTEGER NOT NULL DEFAULT 0,
      settings JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS slot_rewards (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      sponsor_type TEXT NOT NULL DEFAULT 'self',
      weight INTEGER NOT NULL DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sponsor_active BOOLEAN NOT NULL DEFAULT TRUE,
      value_cents INTEGER NOT NULL DEFAULT 0,
      bank_delta_cents INTEGER NOT NULL DEFAULT 0,
      requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
      cooldown_days INTEGER NOT NULL DEFAULT 0,
      unlock_threshold_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      last_won_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(workspace_id, title)
    );

    CREATE TABLE IF NOT EXISTS slot_point_ledger (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id INTEGER REFERENCES users(id),
      delta INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_key TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_point_ledger_source
      ON slot_point_ledger(workspace_id, source_type, source_key);

    CREATE TABLE IF NOT EXISTS slot_spins (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id INTEGER REFERENCES users(id),
      cost_credits INTEGER NOT NULL DEFAULT 1,
      reward_id INTEGER REFERENCES slot_rewards(id),
      reward_snapshot JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'awarded',
      bank_delta_cents INTEGER NOT NULL DEFAULT 0,
      bank_reserved_cents INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_slot_rewards_workspace
      ON slot_rewards(workspace_id, active, kind);

    CREATE INDEX IF NOT EXISTS idx_slot_spins_workspace
      ON slot_spins(workspace_id, created_at DESC);
  `);
}

async function ensureAccount(workspaceId, userId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `INSERT INTO slot_accounts (workspace_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET user_id = COALESCE(slot_accounts.user_id, EXCLUDED.user_id)
     RETURNING *`,
    [workspaceId, userId || null]
  );
  await seedRewards(workspaceId);
  return rows[0];
}

async function seedRewards(workspaceId) {
  for (const r of DEFAULT_REWARDS) {
    await pool.query(
      `INSERT INTO slot_rewards
       (workspace_id, title, kind, sponsor_type, weight, active, sponsor_active, value_cents, bank_delta_cents, requires_confirmation, cooldown_days, unlock_threshold_cents, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (workspace_id, title) DO NOTHING`,
      [workspaceId, r.title, r.kind, r.sponsor_type, r.weight, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes]
    );
  }
}

function normalizeRewardInput(body) {
  const title = String(body.title || "").trim();
  if (!title) throw new Error("title required");
  const kind = String(body.kind || "free");
  const sponsorType = String(body.sponsor_type || "self");
  if (!REWARD_KINDS.has(kind)) throw new Error("invalid kind");
  if (!SPONSOR_TYPES.has(sponsorType)) throw new Error("invalid sponsor_type");
  return {
    title,
    kind,
    sponsor_type: sponsorType,
    weight: Math.max(0, parseInt(body.weight, 10) || 0),
    active: body.active !== false,
    sponsor_active: sponsorType === "self" ? true : body.sponsor_active === true,
    value_cents: Math.max(0, parseInt(body.value_cents, 10) || 0),
    bank_delta_cents: Math.max(0, parseInt(body.bank_delta_cents, 10) || 0),
    requires_confirmation: !!body.requires_confirmation,
    cooldown_days: Math.max(0, parseInt(body.cooldown_days, 10) || 0),
    unlock_threshold_cents: Math.max(0, parseInt(body.unlock_threshold_cents, 10) || 0),
    notes: String(body.notes || ""),
  };
}

function rowToReward(row, account, bankUsage) {
  const bankBalance = account ? account.bank_balance_cents : 0;
  const threshold = Math.max(row.value_cents || 0, row.unlock_threshold_cents || 0);
  const sponsorLocked = row.sponsor_type !== "self" && !row.sponsor_active;
  const paidLocked = ["small_paid", "bank_gated"].includes(row.kind) && threshold > bankBalance;
  const cooldownLocked = row.cooldown_days > 0 && row.last_won_at && Date.now() - new Date(row.last_won_at).getTime() < row.cooldown_days * 86400000;
  const bankCapLocked = row.kind === "bank_builder" && bankUsage && (
    bankUsage.today + row.bank_delta_cents > DAILY_BANK_CAP_CENTS ||
    bankUsage.week + row.bank_delta_cents > WEEKLY_BANK_CAP_CENTS
  );
  return {
    ...row,
    eligible: !!row.active && row.weight > 0 && !sponsorLocked && !paidLocked && !cooldownLocked && !bankCapLocked,
    locked_reason: !row.active ? "inactive" :
      row.weight <= 0 ? "zero_weight" :
      sponsorLocked ? "sponsor_opt_in_required" :
      paidLocked ? "bank_too_small" :
      cooldownLocked ? "cooldown" :
      bankCapLocked ? "bank_cap" :
      null,
  };
}

async function getBankUsage(workspaceId) {
  const { rows: [today] } = await pool.query(
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents
     FROM slot_spins
     WHERE workspace_id = $1 AND status IN ('pending','confirmed')
       AND reward_snapshot->>'kind' = 'bank_builder'
       AND created_at >= date_trunc('day', NOW())`,
    [workspaceId]
  );
  const { rows: [week] } = await pool.query(
    `SELECT COALESCE(SUM(bank_delta_cents), 0)::int AS cents
     FROM slot_spins
     WHERE workspace_id = $1 AND status IN ('pending','confirmed')
       AND reward_snapshot->>'kind' = 'bank_builder'
       AND created_at >= date_trunc('week', NOW())`,
    [workspaceId]
  );
  return { today: today.cents, week: week.cents, dailyCap: DAILY_BANK_CAP_CENTS, weeklyCap: WEEKLY_BANK_CAP_CENTS };
}

async function getPendingBankDeposit(workspaceId) {
  const { rows: [pending] } = await pool.query(
    `SELECT
       COALESCE(SUM(bank_delta_cents), 0)::int AS cents,
       COUNT(*)::int AS count,
       MIN(created_at) AS oldest_at
     FROM slot_spins
     WHERE workspace_id = $1
       AND status = 'pending'
       AND reward_snapshot->>'kind' = 'bank_builder'`,
    [workspaceId]
  );
  return { cents: pending.cents, count: pending.count, oldest_at: pending.oldest_at };
}

async function getState(workspaceId, userId) {
  const account = await ensureAccount(workspaceId, userId);
  const bankUsage = await getBankUsage(workspaceId);
  const pendingBankDeposit = await getPendingBankDeposit(workspaceId);
  const { rows: rewardRows } = await pool.query("SELECT * FROM slot_rewards WHERE workspace_id = $1 ORDER BY active DESC, kind, title", [workspaceId]);
  const rewards = rewardRows.map(r => rowToReward(r, account, bankUsage));
  const { rows: spins } = await pool.query(
    "SELECT * FROM slot_spins WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 25",
    [workspaceId]
  );
  return {
    account,
    rewards,
    spins,
    bankUsage,
    pendingBankDeposit,
    constants: { spinCost: DEFAULT_SPIN_COST },
  };
}

async function createReward(workspaceId, body) {
  const r = normalizeRewardInput(body);
  const { rows } = await pool.query(
    `INSERT INTO slot_rewards
     (workspace_id,title,kind,sponsor_type,weight,active,sponsor_active,value_cents,bank_delta_cents,requires_confirmation,cooldown_days,unlock_threshold_cents,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [workspaceId, r.title, r.kind, r.sponsor_type, r.weight, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes]
  );
  return rows[0];
}

async function updateReward(workspaceId, id, body) {
  const r = normalizeRewardInput(body);
  const { rows } = await pool.query(
    `UPDATE slot_rewards SET
       title=$3, kind=$4, sponsor_type=$5, weight=$6, active=$7, sponsor_active=$8,
       value_cents=$9, bank_delta_cents=$10, requires_confirmation=$11,
       cooldown_days=$12, unlock_threshold_cents=$13, notes=$14, updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2
     RETURNING *`,
    [workspaceId, id, r.title, r.kind, r.sponsor_type, r.weight, r.active, r.sponsor_active, r.value_cents, r.bank_delta_cents, r.requires_confirmation, r.cooldown_days, r.unlock_threshold_cents, r.notes]
  );
  if (!rows[0]) throw notFound("Reward not found");
  return rows[0];
}

async function deleteReward(workspaceId, id) {
  const { rowCount } = await pool.query("DELETE FROM slot_rewards WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
  if (!rowCount) throw notFound("Reward not found");
  return { ok: true };
}

async function earnTaskCredit(workspaceId, userId, body) {
  await ensureAccount(workspaceId, userId);
  const sourceKey = String(body.source_key || body.task_id || "").trim();
  if (!sourceKey) throw new Error("source_key required");
  const description = String(body.description || body.title || "Task completed");
  const { rows } = await pool.query(
    `INSERT INTO slot_point_ledger (workspace_id, user_id, delta, source_type, source_key, description)
     VALUES ($1,$2,1,'task_complete',$3,$4)
     ON CONFLICT (workspace_id, source_type, source_key) DO NOTHING
     RETURNING *`,
    [workspaceId, userId || null, sourceKey, description]
  );
  let awarded = false;
  if (rows[0]) {
    awarded = true;
    await pool.query("UPDATE slot_accounts SET point_balance = point_balance + 1, updated_at=NOW() WHERE workspace_id=$1", [workspaceId]);
  }
  const state = await getState(workspaceId, userId);
  return { awarded, account: state.account };
}

function chooseWeighted(rewards) {
  const total = rewards.reduce((sum, r) => sum + r.weight, 0);
  if (total <= 0) return null;
  let roll = crypto.randomInt(total) + 1;
  for (const r of rewards) {
    roll -= r.weight;
    if (roll <= 0) return r;
  }
  return rewards[rewards.length - 1];
}

async function spin(workspaceId, userId) {
  const state = await getState(workspaceId, userId);
  if (state.account.point_balance < DEFAULT_SPIN_COST) {
    const err = new Error("Not enough credits");
    err.statusCode = 400;
    throw err;
  }
  const eligible = state.rewards.filter(r => r.eligible);
  if (!eligible.length) {
    const err = new Error("No eligible rewards");
    err.statusCode = 400;
    throw err;
  }
  const selected = chooseWeighted(eligible);
  const status = selected.kind === "miss"
    ? "miss"
    : selected.requires_confirmation || selected.kind === "bank_builder" || ["small_paid", "bank_gated", "sponsor", "choice"].includes(selected.kind)
    ? "pending"
    : "awarded";
  const bankReserved = ["small_paid", "bank_gated"].includes(selected.kind) ? Math.max(selected.value_cents, selected.unlock_threshold_cents) : 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [account] } = await client.query(
      "SELECT point_balance FROM slot_accounts WHERE workspace_id=$1 FOR UPDATE",
      [workspaceId]
    );
    if (!account || account.point_balance < DEFAULT_SPIN_COST) throw new Error("Not enough credits");
    await client.query("UPDATE slot_accounts SET point_balance = point_balance - $2, updated_at=NOW() WHERE workspace_id=$1", [workspaceId, DEFAULT_SPIN_COST]);
    const { rows } = await client.query(
      `INSERT INTO slot_spins
       (workspace_id,user_id,cost_credits,reward_id,reward_snapshot,status,bank_delta_cents,bank_reserved_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [workspaceId, userId || null, DEFAULT_SPIN_COST, selected.id, selected, status, selected.bank_delta_cents || 0, bankReserved]
    );
    await client.query("UPDATE slot_rewards SET last_won_at=NOW() WHERE id=$1", [selected.id]);
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function confirmSpin(workspaceId, spinId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM slot_spins WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, spinId]);
    const spinRow = rows[0];
    if (!spinRow) throw notFound("Spin not found");
    if (spinRow.status !== "pending") {
      await client.query("COMMIT");
      return spinRow;
    }
    const snapshot = spinRow.reward_snapshot || {};
    let accountUpdate = "";
    const params = [workspaceId];
    if (snapshot.kind === "bank_builder" && spinRow.bank_delta_cents > 0) {
      accountUpdate = "bank_balance_cents = bank_balance_cents + $2,";
      params.push(spinRow.bank_delta_cents);
    } else if (["small_paid", "bank_gated"].includes(snapshot.kind) && spinRow.bank_reserved_cents > 0) {
      accountUpdate = "bank_balance_cents = GREATEST(0, bank_balance_cents - $2),";
      params.push(spinRow.bank_reserved_cents);
    }
    if (accountUpdate) {
      await client.query(`UPDATE slot_accounts SET ${accountUpdate} updated_at=NOW() WHERE workspace_id=$1`, params);
    }
    const { rows: [updated] } = await client.query(
      "UPDATE slot_spins SET status='confirmed', confirmed_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING *",
      [workspaceId, spinId]
    );
    await client.query("COMMIT");
    return updated;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function confirmPendingBankBuilders(workspaceId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, bank_delta_cents
       FROM slot_spins
       WHERE workspace_id=$1
         AND status='pending'
         AND reward_snapshot->>'kind' = 'bank_builder'
       FOR UPDATE`,
      [workspaceId]
    );
    const cents = rows.reduce((sum, row) => sum + (row.bank_delta_cents || 0), 0);
    if (cents > 0) {
      await client.query(
        "UPDATE slot_accounts SET bank_balance_cents = bank_balance_cents + $2, updated_at=NOW() WHERE workspace_id=$1",
        [workspaceId, cents]
      );
      await client.query(
        `UPDATE slot_spins
         SET status='confirmed', confirmed_at=NOW()
         WHERE workspace_id=$1
           AND status='pending'
           AND reward_snapshot->>'kind' = 'bank_builder'`,
        [workspaceId]
      );
    }
    const { rows: [account] } = await client.query("SELECT * FROM slot_accounts WHERE workspace_id=$1", [workspaceId]);
    await client.query("COMMIT");
    return { confirmed_cents: cents, confirmed_count: rows.length, account };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

module.exports = {
  ensureSchema,
  getState,
  createReward,
  updateReward,
  deleteReward,
  earnTaskCredit,
  spin,
  confirmSpin,
  confirmPendingBankBuilders,
};
