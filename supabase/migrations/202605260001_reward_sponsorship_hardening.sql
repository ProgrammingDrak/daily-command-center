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
  sponsor_splits JSONB NOT NULL DEFAULT '[]',
  weight INTEGER NOT NULL DEFAULT 1,
  chance_shares INTEGER NOT NULL DEFAULT 1,
  payment_source TEXT NOT NULL DEFAULT 'self',
  tier_id TEXT NOT NULL DEFAULT 'tier_i',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sponsor_active BOOLEAN NOT NULL DEFAULT TRUE,
  value_cents INTEGER NOT NULL DEFAULT 0,
  bank_delta_cents INTEGER NOT NULL DEFAULT 0,
  requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  cooldown_days INTEGER NOT NULL DEFAULT 0,
  unlock_threshold_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  last_won_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
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
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS todo_shares (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token TEXT NOT NULL UNIQUE,
  access_level TEXT NOT NULL DEFAULT 'guest_view',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS todo_sponsorships (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  share_id INTEGER NOT NULL REFERENCES todo_shares(id),
  task_id TEXT NOT NULL,
  task_date DATE,
  task_block_id TEXT,
  task_title TEXT NOT NULL,
  sponsor_name TEXT NOT NULL,
  sponsor_email TEXT,
  sponsor_user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'bounty',
  reward_title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  value_cents INTEGER NOT NULL DEFAULT 0,
  slot_reward_id INTEGER REFERENCES slot_rewards(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS sponsor_splits JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS chance_shares INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS tier_id TEXT NOT NULL DEFAULT 'tier_i',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

UPDATE slot_rewards
   SET chance_shares = GREATEST(0, weight)
 WHERE chance_shares = 1
   AND weight <> 1;

UPDATE slot_rewards
   SET payment_source = CASE
     WHEN kind = 'sponsor' THEN 'sponsored'
     WHEN kind IN ('free','choice','reroll') THEN 'free'
     ELSE payment_source
   END
 WHERE payment_source = 'self'
   AND kind IN ('sponsor','free','choice','reroll');

ALTER TABLE slot_point_ledger
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

ALTER TABLE todo_sponsorships
  ADD COLUMN IF NOT EXISTS task_date DATE,
  ADD COLUMN IF NOT EXISTS slot_reward_id INTEGER REFERENCES slot_rewards(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_point_ledger_source
  ON slot_point_ledger(workspace_id, source_type, source_key);

CREATE INDEX IF NOT EXISTS idx_slot_rewards_workspace
  ON slot_rewards(workspace_id, active, kind);

CREATE INDEX IF NOT EXISTS idx_slot_spins_workspace
  ON slot_spins(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_todo_sponsorships_workspace_status
  ON todo_sponsorships(workspace_id, status, created_at DESC);
