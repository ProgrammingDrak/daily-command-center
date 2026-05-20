/**
 * pg-schema.js — Create all Postgres tables for Daily Command Center
 *
 * Run once to initialize the schema. Idempotent (IF NOT EXISTS).
 * Table order respects foreign key dependencies.
 *
 * Usage: node pg-schema.js
 */

require("dotenv/config");
const pool = require("./pg-pool");

const SCHEMA_SQL = `
-- ── Users ──
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

-- ── Workspaces ──
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- ── Blocks (core entity) ──
CREATE TABLE IF NOT EXISTS blocks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  parent_id    TEXT REFERENCES blocks(id),
  date         DATE,
  properties   JSONB NOT NULL DEFAULT '{}',
  sort_order   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  deleted_at   TIMESTAMPTZ,
  user_id      INTEGER REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_type_date
  ON blocks(type, date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_parent
  ON blocks(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_date
  ON blocks(date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_workspace_date
  ON blocks(workspace_id, date) WHERE deleted_at IS NULL;

-- ── Workspace Members ──
CREATE TABLE IF NOT EXISTS workspace_members (
  id           SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL DEFAULT 'viewer',
  invited_by   INTEGER REFERENCES users(id),
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE(workspace_id, user_id)
);

-- ── Page Shares ──
CREATE TABLE IF NOT EXISTS page_shares (
  id           SERIAL PRIMARY KEY,
  block_id     TEXT NOT NULL REFERENCES blocks(id),
  token        TEXT NOT NULL UNIQUE,
  access_level TEXT NOT NULL DEFAULT 'view',
  created_by   INTEGER REFERENCES users(id),
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL
);

-- ── Operations (audit log) ──
CREATE TABLE IF NOT EXISTS operations (
  id          SERIAL PRIMARY KEY,
  block_id    TEXT NOT NULL,
  op_type     TEXT NOT NULL,
  before_data JSONB,
  after_data  JSONB,
  timestamp   TIMESTAMPTZ NOT NULL,
  batch_id    TEXT
);

-- ── Feedback Messages ──
CREATE TABLE IF NOT EXISTS feedback_messages (
  id           SERIAL PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  user_id      INTEGER REFERENCES users(id),
  message      TEXT NOT NULL,
  page_path    TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_feedback_messages_workspace_created
  ON feedback_messages(workspace_id, created_at DESC);

-- ── Login Events ──
CREATE TABLE IF NOT EXISTS login_events (
  id           SERIAL PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  user_id      INTEGER REFERENCES users(id),
  username     TEXT,
  event_type   TEXT NOT NULL DEFAULT 'login',
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_events_workspace_created
  ON login_events(workspace_id, created_at DESC);

-- ── DCC State ──
DO $$
BEGIN
  IF to_regclass('public.dcc_state') IS NULL AND to_regclass('public.pa_state') IS NOT NULL THEN
    ALTER TABLE pa_state RENAME TO dcc_state;
  END IF;
  IF to_regclass('public.idx_pa_state_workspace') IS NOT NULL AND to_regclass('public.idx_dcc_state_workspace') IS NULL THEN
    ALTER INDEX idx_pa_state_workspace RENAME TO idx_dcc_state_workspace;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dcc_state (
  date         DATE NOT NULL,
  state_json   JSONB NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  workspace_id TEXT NOT NULL DEFAULT 'ws-1',
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (date, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_dcc_state_workspace
  ON dcc_state(workspace_id, date);

-- ── Pet Home ──
CREATE TABLE IF NOT EXISTS pet_homes (
  workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id),
  user_id            INTEGER REFERENCES users(id),
  pet                JSONB NOT NULL DEFAULT '{}',
  home               JSONB NOT NULL DEFAULT '{}',
  food_level         INTEGER NOT NULL DEFAULT 50,
  mood_level         INTEGER NOT NULL DEFAULT 55,
  decor_currency     INTEGER NOT NULL DEFAULT 0,
  share_slug         TEXT UNIQUE,
  public_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pet_home_events (
  id             SERIAL PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  user_id        INTEGER REFERENCES users(id),
  event_type     TEXT NOT NULL,
  source_type    TEXT NOT NULL DEFAULT 'manual',
  source_key     TEXT NOT NULL,
  actor_name     TEXT,
  message        TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pet_home_events_source
  ON pet_home_events(workspace_id, source_type, source_key);

CREATE INDEX IF NOT EXISTS idx_pet_home_events_workspace_created
  ON pet_home_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pet_task_suggestions (
  id                SERIAL PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  visitor_name      TEXT NOT NULL,
  title             TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending',
  approved_block_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pet_task_suggestions_workspace_status
  ON pet_task_suggestions(workspace_id, status, created_at DESC);

-- ── Live Todo Shares ──
CREATE TABLE IF NOT EXISTS todo_shares (
  id             SERIAL PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  token          TEXT NOT NULL UNIQUE,
  access_level   TEXT NOT NULL DEFAULT 'guest_view',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  settings       JSONB NOT NULL DEFAULT '{}',
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_todo_shares_workspace_active
  ON todo_shares(workspace_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS todo_sponsorships (
  id               SERIAL PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  share_id         INTEGER NOT NULL REFERENCES todo_shares(id),
  task_id          TEXT NOT NULL,
  task_date        DATE,
  task_block_id    TEXT,
  task_title       TEXT NOT NULL,
  sponsor_name     TEXT NOT NULL,
  sponsor_email    TEXT,
  sponsor_user_id  INTEGER REFERENCES users(id),
  kind             TEXT NOT NULL DEFAULT 'bounty',
  reward_title     TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  value_cents      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todo_sponsorships_workspace_status
  ON todo_sponsorships(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS todo_task_reactions (
  id              SERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  share_id        INTEGER NOT NULL REFERENCES todo_shares(id),
  task_id         TEXT NOT NULL,
  task_date       DATE,
  task_block_id   TEXT,
  task_title      TEXT NOT NULL DEFAULT '',
  identity_ids    JSONB NOT NULL DEFAULT '[]',
  emoji           TEXT NOT NULL,
  actor_key       TEXT NOT NULL,
  actor_user_id   INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE todo_task_reactions
  ADD COLUMN IF NOT EXISTS task_date DATE;

ALTER TABLE todo_task_reactions
  ADD COLUMN IF NOT EXISTS identity_ids JSONB NOT NULL DEFAULT '[]';

DROP INDEX IF EXISTS idx_todo_task_reactions_unique_actor;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_task_reactions_unique_actor_date
  ON todo_task_reactions(share_id, task_id, COALESCE(task_date, DATE '0001-01-01'), emoji, actor_key);

CREATE INDEX IF NOT EXISTS idx_todo_task_reactions_share_task
  ON todo_task_reactions(share_id, task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_todo_task_reactions_share_date
  ON todo_task_reactions(share_id, task_date, created_at DESC);

-- ── Slot Rewards ──
CREATE TABLE IF NOT EXISTS slot_accounts (
  workspace_id        TEXT PRIMARY KEY REFERENCES workspaces(id),
  user_id             INTEGER REFERENCES users(id),
  point_balance       INTEGER NOT NULL DEFAULT 0,
  bank_balance_cents  INTEGER NOT NULL DEFAULT 0,
  settings            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slot_rewards (
  id                    SERIAL PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id),
  title                  TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  sponsor_type           TEXT NOT NULL DEFAULT 'self',
  sponsor_splits         JSONB NOT NULL DEFAULT '[]',
  weight                 INTEGER NOT NULL DEFAULT 1,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  sponsor_active         BOOLEAN NOT NULL DEFAULT TRUE,
  value_cents            INTEGER NOT NULL DEFAULT 0,
  bank_delta_cents       INTEGER NOT NULL DEFAULT 0,
  requires_confirmation  BOOLEAN NOT NULL DEFAULT FALSE,
  cooldown_days          INTEGER NOT NULL DEFAULT 0,
  unlock_threshold_cents INTEGER NOT NULL DEFAULT 0,
  notes                  TEXT NOT NULL DEFAULT '',
  last_won_at            TIMESTAMPTZ,
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, title)
);

CREATE TABLE IF NOT EXISTS slot_point_ledger (
  id           SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      INTEGER REFERENCES users(id),
  delta        INTEGER NOT NULL,
  source_type  TEXT NOT NULL,
  source_key   TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE slot_point_ledger
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS sponsor_splits JSONB NOT NULL DEFAULT '[]';

ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_point_ledger_source
  ON slot_point_ledger(workspace_id, source_type, source_key);

CREATE TABLE IF NOT EXISTS slot_spins (
  id                  SERIAL PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             INTEGER REFERENCES users(id),
  cost_credits        INTEGER NOT NULL DEFAULT 1,
  reward_id           INTEGER REFERENCES slot_rewards(id),
  reward_snapshot     JSONB NOT NULL,
  status              TEXT NOT NULL DEFAULT 'awarded',
  bank_delta_cents    INTEGER NOT NULL DEFAULT 0,
  bank_reserved_cents INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_slot_rewards_workspace
  ON slot_rewards(workspace_id, active, kind);

CREATE INDEX IF NOT EXISTS idx_slot_spins_workspace
  ON slot_spins(workspace_id, created_at DESC);
`;

async function createSchema() {
  console.log("[pg-schema] Creating tables...");
  await pool.query(SCHEMA_SQL);
  console.log("[pg-schema] All tables and indexes created.");
}

// Run directly or import
if (require.main === module) {
  createSchema()
    .then(() => {
      console.log("[pg-schema] Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[pg-schema] Error:", err.message);
      process.exit(1);
    });
} else {
  module.exports = { createSchema };
}
