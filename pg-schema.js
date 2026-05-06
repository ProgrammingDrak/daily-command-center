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

-- ── PA State ──
CREATE TABLE IF NOT EXISTS pa_state (
  date         DATE NOT NULL,
  state_json   JSONB NOT NULL,
  user_id      INTEGER REFERENCES users(id),
  workspace_id TEXT NOT NULL DEFAULT 'ws-1',
  updated_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (date, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_pa_state_workspace
  ON pa_state(workspace_id, date);

-- ── GCal Tokens ──
CREATE TABLE IF NOT EXISTS gcal_tokens (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  credentials JSONB NOT NULL,
  tokens      JSONB,
  calendars   JSONB,
  updated_at  TIMESTAMPTZ NOT NULL
);

-- ── GCal Events ──
CREATE TABLE IF NOT EXISTS gcal_events (
  gcal_event_id    TEXT NOT NULL,
  block_id         TEXT,
  calendar_id      TEXT NOT NULL,
  etag             TEXT,
  summary          TEXT,
  description      TEXT,
  location         TEXT,
  start_time       TEXT,
  end_time         TEXT,
  start_date       DATE,
  end_date         DATE,
  all_day          BOOLEAN DEFAULT FALSE,
  status           TEXT DEFAULT 'confirmed',
  html_link        TEXT,
  hangout_link     TEXT,
  attendees_json   JSONB DEFAULT '[]',
  conference_json  JSONB,
  organizer_json   JSONB,
  creator_json     JSONB,
  recurrence_json  JSONB,
  recurring_event_id TEXT,
  visibility       TEXT,
  transparency     TEXT,
  ical_uid         TEXT,
  color_id         TEXT,
  reminders_json   JSONB,
  raw_json         JSONB,
  synced_at        TIMESTAMPTZ NOT NULL,
  local_modified   BOOLEAN DEFAULT FALSE,
  user_id          INTEGER REFERENCES users(id),
  PRIMARY KEY (gcal_event_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_gcal_events_block
  ON gcal_events(block_id) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gcal_events_start
  ON gcal_events(start_time);

-- ── GCal Sync State ──
CREATE TABLE IF NOT EXISTS gcal_sync_state (
  calendar_id TEXT PRIMARY KEY,
  sync_token  TEXT,
  last_sync_at TIMESTAMPTZ,
  full_sync   BOOLEAN DEFAULT TRUE,
  user_id     INTEGER REFERENCES users(id)
);

-- ── GCal Calendars ──
CREATE TABLE IF NOT EXISTS gcal_calendars (
  id               TEXT PRIMARY KEY,
  summary          TEXT,
  description      TEXT,
  background_color TEXT,
  foreground_color TEXT,
  is_primary       BOOLEAN DEFAULT FALSE,
  access_role      TEXT,
  selected         BOOLEAN DEFAULT TRUE,
  updated_at       TIMESTAMPTZ,
  user_id          INTEGER REFERENCES users(id)
);

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
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
