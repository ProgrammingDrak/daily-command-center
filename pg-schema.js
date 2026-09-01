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
  onboarding_state JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}';

-- OAuth / managed-widget identities (Clerk). OAuth users have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id   TEXT UNIQUE;  -- Clerk user id (user_xxx)
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT;          -- 'password' | 'google' | 'apple'
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url    TEXT;

-- lower(email) is a lookup key, not just a stored field: auth.js matches a login
-- against username OR lower(email), and lib/slack-actors.js resolves a Slack
-- reactor to an account the same way on every first reaction. Without this both
-- are sequential scans that grow with the account count.
-- (No backticks in this comment: the whole block is a JS template literal.)
CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (lower(email));

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
CREATE INDEX IF NOT EXISTS idx_blocks_time_entry_task
  ON blocks(workspace_id, (properties->>'blockId'), date)
  WHERE type = 'time_entry' AND deleted_at IS NULL;

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


CREATE INDEX IF NOT EXISTS idx_dcc_state_workspace
  ON dcc_state(workspace_id, date);

-- Compact, paginated history. Routine day reads never need this archive.
CREATE TABLE IF NOT EXISTS triage_history (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  triage_id     TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ NOT NULL,
  resolution    TEXT NOT NULL DEFAULT 'done',
  title         TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',
  item_json     JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, triage_id, resolved_at)
);

CREATE INDEX IF NOT EXISTS idx_triage_history_workspace_resolved
  ON triage_history(workspace_id, resolved_at DESC, id DESC);

INSERT INTO triage_history(workspace_id, triage_id, resolved_at, resolution, title, source, item_json)
SELECT s.workspace_id,
       item->>'id',
       CASE
         WHEN COALESCE(item->>'resolved_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
           THEN (item->>'resolved_at')::timestamptz
         ELSE s.updated_at
       END,
       COALESCE(NULLIF(item->>'resolved_reason', ''), NULLIF(item->>'reason', ''), 'done'),
       COALESCE(item->>'title', ''),
       COALESCE(NULLIF(item->>'source', ''), NULLIF(item->>'type', ''), ''),
       item
  FROM dcc_state s
 CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(s.state_json#>'{triage,resolved_items}') = 'array'
     THEN s.state_json#>'{triage,resolved_items}' ELSE '[]'::jsonb END
 ) item
 WHERE COALESCE(item->>'id', '') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM triage_history existing WHERE existing.workspace_id = s.workspace_id
   )
ON CONFLICT(workspace_id, triage_id, resolved_at) DO NOTHING;

-- One server-owned sequence covers every entity visible to browser sync.
CREATE TABLE IF NOT EXISTS sync_events (
  seq           BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  operation     TEXT NOT NULL,
  entity_date   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_events_workspace_seq
  ON sync_events(workspace_id, seq);

CREATE TABLE IF NOT EXISTS sync_prune_watermarks (
  workspace_id       TEXT PRIMARY KEY,
  pruned_through_seq BIGINT NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION dcc_capture_sync_event()
RETURNS trigger AS $$
DECLARE
  ws TEXT;
  entity_key TEXT;
  event_date DATE;
  event_operation TEXT;
  row_data JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
    ws := COALESCE(row_data->>'workspace_id', 'ws-1');
    event_date := NULLIF(row_data->>'date', '')::date;
    event_operation := 'delete';
  ELSE
    row_data := to_jsonb(NEW);
    ws := COALESCE(row_data->>'workspace_id', 'ws-1');
    event_date := NULLIF(row_data->>'date', '')::date;
    event_operation := CASE
      WHEN TG_TABLE_NAME = 'blocks' AND NULLIF(row_data->>'deleted_at', '') IS NOT NULL THEN 'delete'
      ELSE 'upsert' END;
  END IF;
  entity_key := CASE WHEN TG_TABLE_NAME = 'dcc_state'
    THEN row_data->>'date' ELSE row_data->>'id' END;

  IF TG_TABLE_NAME = 'blocks' AND row_data#>>'{properties,kind}' = 'triage_suppression' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  INSERT INTO sync_events(workspace_id, entity_type, entity_id, operation, entity_date)
  VALUES (ws, TG_TABLE_NAME, entity_key, event_operation, event_date);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blocks_sync_event ON blocks;
CREATE TRIGGER trg_blocks_sync_event
AFTER INSERT OR UPDATE OR DELETE ON blocks
FOR EACH ROW EXECUTE FUNCTION dcc_capture_sync_event();

DROP TRIGGER IF EXISTS trg_dcc_state_sync_event ON dcc_state;
CREATE TRIGGER trg_dcc_state_sync_event
AFTER INSERT OR UPDATE OR DELETE ON dcc_state
FOR EACH ROW EXECUTE FUNCTION dcc_capture_sync_event();

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

-- Both reads getState added filter on event_type. The index above leads with
-- created_at, so listVisits walked the whole workspace history hunting for a
-- handful of pet_visit rows -- worst on day one, when there are none and it
-- scans everything to return an empty list. task_feed grows by one row per
-- completed task forever, so this degrades quietly and permanently.
CREATE INDEX IF NOT EXISTS idx_pet_home_events_workspace_type_created
  ON pet_home_events(workspace_id, event_type, created_at DESC);

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
  chance_shares          INTEGER NOT NULL DEFAULT 1,
  payment_source         TEXT NOT NULL DEFAULT 'self',
  tier_id                TEXT NOT NULL DEFAULT 'tier_i',
  sort_order             DOUBLE PRECISION NOT NULL DEFAULT 0,
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
  ADD COLUMN IF NOT EXISTS chance_shares INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'self',
  ADD COLUMN IF NOT EXISTS tier_id TEXT NOT NULL DEFAULT 'tier_i';

ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS sort_order DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Seed a stable initial order for existing rewards so the within-bucket order is
-- deterministic before anyone drags a card (id ascending == creation order).
UPDATE slot_rewards
   SET sort_order = id * 1000
 WHERE sort_order = 0;

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

-- ── Punishments Wheel (flat weighted mirror of the rewards spinner) ──
-- A separate, intentionally-simple spinner: one flat list of punishments, each
-- with a "chances" weight. Odds = chance_shares / Σ active chance_shares. Money
-- punishments carry a negative bank_delta_cents that moves slot_accounts.bank_balance_cents.
-- The owed-spin counter lives in slot_accounts.settings.punishments_owed (JSONB, no column).
CREATE TABLE IF NOT EXISTS slot_punishments (
  id               SERIAL PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  title            TEXT NOT NULL,
  chance_shares    INTEGER NOT NULL DEFAULT 1,
  bank_delta_cents INTEGER NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes            TEXT NOT NULL DEFAULT '',
  times_landed     INTEGER NOT NULL DEFAULT 0,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, title)
);

CREATE TABLE IF NOT EXISTS slot_punishment_spins (
  id                  SERIAL PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  user_id             INTEGER REFERENCES users(id),
  punishment_id       INTEGER REFERENCES slot_punishments(id),
  punishment_snapshot JSONB NOT NULL,
  bank_delta_cents    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_slot_punishments_workspace
  ON slot_punishments(workspace_id, active);

CREATE INDEX IF NOT EXISTS idx_slot_punishment_spins_workspace
  ON slot_punishment_spins(workspace_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- Social Features (multi-user, sponsor-first). See SOCIAL-FEATURES-PLAN.md.
-- Additive only: new tables + generalizing columns on existing tables.
-- ══════════════════════════════════════════════════════════════════════════

-- ── User Profiles (display identity + feed settings) ──
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  display_name  TEXT,
  avatar        TEXT,
  feed_settings JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Friendships (social graph; mutual 'accepted' = friends) ──
CREATE TABLE IF NOT EXISTS friendships (
  id            SERIAL PRIMARY KEY,
  requester_id  INTEGER NOT NULL REFERENCES users(id),
  addressee_id  INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending, accepted, blocked
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(requester_id, addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_addressee
  ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_requester
  ON friendships(requester_id, status);

-- ── Sponsor Allowlist (source of truth for auto-approval) ──
CREATE TABLE IF NOT EXISTS sponsor_allowlist (
  id                 SERIAL PRIMARY KEY,
  owner_user_id      INTEGER NOT NULL REFERENCES users(id),
  allowed_user_id    INTEGER NOT NULL REFERENCES users(id),
  scope              TEXT NOT NULL DEFAULT 'both', -- task, slot, both
  note               TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_user_id, allowed_user_id)
);

CREATE INDEX IF NOT EXISTS idx_sponsor_allowlist_owner
  ON sponsor_allowlist(owner_user_id);

-- ── Reward Definitions (generalized from slot_rewards) ──
-- slot_rewards already carries chance_shares, payment_source, tier_id,
-- value_cents, last_won_at. Extend it into the unified reward catalog.
ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS owner_user_id      INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS times_won          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS times_redeemed     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_redeemed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS uses_remaining     INTEGER,
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_visibility  TEXT NOT NULL DEFAULT 'private';

-- ── Reward Queue Items (unified earned-reward instances) ──
-- Replaces the client-side AWARD_QUEUE_KEY localStorage queue.
CREATE TABLE IF NOT EXISTS reward_queue_items (
  id                     SERIAL PRIMARY KEY,
  owner_user_id          INTEGER NOT NULL REFERENCES users(id),
  workspace_id           TEXT REFERENCES workspaces(id),
  reward_definition_id   INTEGER REFERENCES slot_rewards(id),
  title_snapshot         TEXT NOT NULL,
  source_type            TEXT NOT NULL, -- slot_spin, task_completion, sponsor_task, manual_self_reward, self_care
  source_id              TEXT,
  status                 TEXT NOT NULL DEFAULT 'queued', -- queued, claimed, scheduled, redeemed, completed, dismissed, expired
  won_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  won_date               DATE,
  claimed_at             TIMESTAMPTZ,
  scheduled_for          TIMESTAMPTZ,  -- when the user parked the reward in their itinerary
  scheduled_block_id     TEXT,         -- the itinerary block this reward was scheduled into
  redeemed_at            TIMESTAMPTZ,
  redeemed_date          DATE,
  completed_at           TIMESTAMPTZ,
  sponsor_user_id        INTEGER REFERENCES users(id),
  value_snapshot         INTEGER NOT NULL DEFAULT 0,
  chance_shares_snapshot INTEGER,
  tier_snapshot          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_queue_owner_status
  ON reward_queue_items(owner_user_id, status, won_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_queue_owner_won_date
  ON reward_queue_items(owner_user_id, won_date);

-- "Reward Queue" decision screen: a won reward can be done now, banked, or
-- scheduled into the itinerary. Scheduling parks a timestamp + the itinerary
-- block id on the queue row (additive; safe on already-deployed tables).
ALTER TABLE reward_queue_items
  ADD COLUMN IF NOT EXISTS scheduled_for      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_block_id TEXT,
  -- The reward's real duration, snapshotted at win time, so a reward scheduled
  -- later from the queue gets a correctly-sized itinerary block (not a fixed
  -- placeholder). NULL on rows queued before this column existed.
  ADD COLUMN IF NOT EXISTS duration_minutes_snapshot INTEGER;

-- ── Reward Events (append-only audit ledger; source of truth) ──
-- Mirrors the slot_point_ledger / pet_home_events idempotency pattern.
CREATE TABLE IF NOT EXISTS reward_events (
  id                   SERIAL PRIMARY KEY,
  reward_queue_id      INTEGER REFERENCES reward_queue_items(id),
  reward_definition_id INTEGER REFERENCES slot_rewards(id),
  owner_user_id        INTEGER NOT NULL REFERENCES users(id),
  actor_user_id        INTEGER REFERENCES users(id),
  event_type           TEXT NOT NULL, -- won, queued, claimed, redeemed, completed, dismissed, expired, sponsor_removed
  source_type          TEXT NOT NULL DEFAULT 'manual',
  source_id            TEXT NOT NULL DEFAULT '',
  event_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_date           DATE,
  metadata             JSONB NOT NULL DEFAULT '{}'
);

-- Idempotency: an event carrying a source_id is deduped; keyless events are not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_events_idem
  ON reward_events(owner_user_id, event_type, source_type, source_id)
  WHERE source_id <> '';
CREATE INDEX IF NOT EXISTS idx_reward_events_queue
  ON reward_events(reward_queue_id, event_at);

-- ── Sponsorships (generalized from todo_sponsorships) ──
-- todo_sponsorships already has status (default 'pending'), value_cents,
-- sponsor_user_id, slot_reward_id. Generalize to task/slot targets, add the
-- allowlist review lifecycle, and relax the share_id requirement (slot
-- sponsorships are not tied to a todo share).
ALTER TABLE todo_sponsorships
  ADD COLUMN IF NOT EXISTS target_type          TEXT NOT NULL DEFAULT 'task', -- task, slot_machine
  ADD COLUMN IF NOT EXISTS target_id            TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id        INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reward_definition_id INTEGER REFERENCES slot_rewards(id),
  ADD COLUMN IF NOT EXISTS review_state         TEXT NOT NULL DEFAULT 'pending', -- auto_approved, pending, approved, rejected
  ADD COLUMN IF NOT EXISTS chance_shares        INTEGER,
  ADD COLUMN IF NOT EXISTS requested_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id  INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_at           TIMESTAMPTZ;

ALTER TABLE todo_sponsorships
  ALTER COLUMN share_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_todo_sponsorships_owner_review
  ON todo_sponsorships(owner_user_id, review_state, created_at DESC);

-- ── Access Grants (per-owner delegated roles: viewer/commenter/coach/manager) ──
-- ONLY ACTIVE GRANTS live here. Revoking DELETES the row rather than stamping a
-- revoked_at, deliberately: a nullable revoked_at means every read has to
-- remember the AND revoked_at IS NULL, and a reader that forgets it silently hands
-- a revoked coach live access. One fewer predicate to forget is worth more than
-- the convenience of soft deletes, and the audit trail lives in
-- access_grant_events instead.
CREATE TABLE IF NOT EXISTS access_grants (
  id              SERIAL PRIMARY KEY,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id),
  grantee_user_id INTEGER NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL DEFAULT 'viewer',
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_user_id, grantee_user_id),
  -- A grant to yourself is meaningless (an owner is already above manager) and
  -- would be a confusing way to appear in your own coach list.
  CONSTRAINT access_grants_not_self CHECK (owner_user_id <> grantee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_access_grants_grantee
  ON access_grants(grantee_user_id);

-- Append-only audit. Every grant, role change and revoke lands here, so "who
-- gave this person access to my day, and when" is answerable after the grant
-- row itself is gone.
CREATE TABLE IF NOT EXISTS access_grant_events (
  id              SERIAL PRIMARY KEY,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id),
  grantee_user_id INTEGER NOT NULL REFERENCES users(id),
  actor_user_id   INTEGER REFERENCES users(id),
  event_type      TEXT NOT NULL,  -- granted, role_changed, revoked
  role            TEXT,
  previous_role   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_grant_events_owner
  ON access_grant_events(owner_user_id, created_at DESC);

-- ── Feed Posts (derive from task completions; publish is opt-in) ──
CREATE TABLE IF NOT EXISTS feed_posts (
  id                SERIAL PRIMARY KEY,
  owner_user_id     INTEGER NOT NULL REFERENCES users(id),
  workspace_id      TEXT REFERENCES workspaces(id),
  task_id           TEXT,
  completion_id     TEXT,
  points_awarded    INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  actual_minutes    INTEGER,
  publish_state     TEXT NOT NULL DEFAULT 'hidden',         -- hidden, published, manually_hidden
  publish_source    TEXT NOT NULL DEFAULT 'default_hidden', -- user_published, default_hidden, private_task
  caption           TEXT NOT NULL DEFAULT '',
  media_attachments JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at      TIMESTAMPTZ,
  hidden_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_feed_posts_owner_state
  ON feed_posts(owner_user_id, publish_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_posts_published
  ON feed_posts(publish_state, published_at DESC) WHERE publish_state = 'published';

-- The post recorded points and minutes but NOT what was actually completed, so a
-- feed row could not say more than "finished something worth 30 points". Snapshot
-- the title at completion time rather than joining to blocks on read: the task can
-- be deleted, rescheduled, or renamed afterwards, and a feed entry is a record of
-- what happened, not a live view of the row. Same reasoning (and same column name)
-- as reward_queue_items.title_snapshot.
ALTER TABLE feed_posts
  ADD COLUMN IF NOT EXISTS title_snapshot TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS item_type      TEXT NOT NULL DEFAULT 'task';

-- Idempotency. The completion endpoint is replayed by design (mutationId dedupe,
-- offline WAL replay), and re-completing a task must not stack duplicate posts.
-- Partial, because completion_id is nullable and several posts may legitimately
-- carry no completion id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_posts_completion
  ON feed_posts(owner_user_id, completion_id)
  WHERE completion_id IS NOT NULL;

-- ── Budget Tank (tank blocks are slot_rewards rows; see budget-store.js) ──
-- tank_unlock_cents is the cumulative bottom-up waterline gate, recomputed
-- server-side on every tank mutation. It is deliberately SEPARATE from
-- unlock_threshold_cents: reserveCostCents() debits max(value, unlock_threshold),
-- so storing the cumulative sum there would make claiming a $50 block atop a
-- $500 stack debit $500. value_cents stays the price a claim debits.
ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS tank_position       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS tank_unlock_cents   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tank_category       TEXT,
  ADD COLUMN IF NOT EXISTS tank_color          TEXT,
  ADD COLUMN IF NOT EXISTS tank_recurring      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tank_claimed_period TEXT;

-- Reward Vault metadata. slot_rewards remains the canonical reward definition;
-- quick-add and overflow wins clone a definition into a tank row and retain the
-- source link so templates can be reused without sharing claim state.
ALTER TABLE slot_rewards
  ADD COLUMN IF NOT EXISTS vault_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vault_reuse_mode    TEXT NOT NULL DEFAULT 'reusable',
  ADD COLUMN IF NOT EXISTS vault_min_cents     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vault_quick_add     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vault_random_draw   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vault_milestone     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sponsor_visible     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS vault_archived_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_reward_id    INTEGER REFERENCES slot_rewards(id);

CREATE INDEX IF NOT EXISTS idx_slot_rewards_vault
  ON slot_rewards(workspace_id, vault_enabled, kind)
  WHERE deleted_at IS NULL AND vault_archived_at IS NULL;

-- Plan instances may repeat a reusable template title. Keep catalog titles
-- unique while allowing tank clones to carry the human-facing title verbatim.
ALTER TABLE slot_rewards DROP CONSTRAINT IF EXISTS slot_rewards_workspace_id_title_key;
DROP INDEX IF EXISTS idx_slot_rewards_catalog_title;

-- Existing casino definitions become vault cards once. Active tank purchases
-- stay untouched so migration cannot manufacture reusable templates from
-- ordinary transactions.
UPDATE slot_rewards
   SET vault_enabled = TRUE,
       vault_reuse_mode = CASE WHEN uses_remaining = 1 THEN 'one_off' ELSE 'reusable' END,
       vault_min_cents = value_cents,
       vault_quick_add = kind IN ('small_paid', 'bank_gated'),
       vault_random_draw = TRUE,
       vault_milestone = kind = 'free',
       sponsor_visible = public_visibility <> 'private'
 WHERE tank_position IS NULL
   AND deleted_at IS NULL
   AND vault_archived_at IS NULL
   AND vault_enabled = FALSE
   AND kind NOT IN ('miss', 'bank_builder');

CREATE TABLE IF NOT EXISTS budget_reward_milestones (
  id                   SERIAL PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id        INTEGER REFERENCES users(id),
  threshold_bank_units INTEGER NOT NULL,
  reward_definition_id INTEGER REFERENCES slot_rewards(id),
  repeat_each_period   BOOLEAN NOT NULL DEFAULT FALSE,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  claimed_period       TEXT,
  resolved_reward_id   INTEGER REFERENCES slot_rewards(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_reward_milestones_workspace
  ON budget_reward_milestones(workspace_id, active, threshold_bank_units);

CREATE TABLE IF NOT EXISTS budget_carryovers (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       INTEGER REFERENCES users(id),
  from_period   TEXT NOT NULL,
  to_period     TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, from_period)
);

CREATE INDEX IF NOT EXISTS idx_budget_carryovers_to_period
  ON budget_carryovers(workspace_id, to_period);

CREATE TABLE IF NOT EXISTS budget_overflow_spins (
  id                   SERIAL PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  user_id              INTEGER REFERENCES users(id),
  source_key           TEXT NOT NULL,
  reward_definition_id INTEGER REFERENCES slot_rewards(id),
  tank_block_id        INTEGER REFERENCES slot_rewards(id),
  amount_cents         INTEGER NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, source_key)
);

CREATE TABLE IF NOT EXISTS sponsor_share_links (
  id            SERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  token         TEXT NOT NULL UNIQUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_user_id)
);

CREATE TABLE IF NOT EXISTS sponsorship_unlock_routes (
  id                  SERIAL PRIMARY KEY,
  sponsorship_id      INTEGER NOT NULL REFERENCES todo_sponsorships(id) ON DELETE CASCADE,
  route_type          TEXT NOT NULL,
  target_id           TEXT,
  threshold_bank_units INTEGER,
  status              TEXT NOT NULL DEFAULT 'armed',
  won_at              TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE todo_sponsorships
  ADD COLUMN IF NOT EXISTS winning_route_id INTEGER REFERENCES sponsorship_unlock_routes(id),
  ADD COLUMN IF NOT EXISTS earned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sponsorship_unlock_routes_armed
  ON sponsorship_unlock_routes(route_type, status, target_id);

CREATE INDEX IF NOT EXISTS idx_slot_rewards_tank
  ON slot_rewards(workspace_id, tank_position)
  WHERE tank_position IS NOT NULL AND deleted_at IS NULL;

-- Money Changer conversions (points -> bank). A dedicated ledger, NOT slot_spins
-- rows, so Bank Builder pacing/shield/head-start sums (getBankUsage) are never
-- contaminated; the tank waterline sums this table alongside positive spin deltas.
CREATE TABLE IF NOT EXISTS budget_conversions (
  id                   SERIAL PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  user_id              INTEGER REFERENCES users(id),
  points               INTEGER NOT NULL,
  cents                INTEGER NOT NULL,
  rate_cents_per_point INTEGER NOT NULL DEFAULT 1,
  source_key           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_budget_conversions_workspace
  ON budget_conversions(workspace_id, created_at DESC);

-- Investments ledger (period-end sweeps; append-only). UNIQUE(workspace, period)
-- makes the sweep idempotent: re-running a rollover cannot double-invest.
CREATE TABLE IF NOT EXISTS budget_investments (
  id            SERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       INTEGER REFERENCES users(id),
  period_key    TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  task_block_id TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, period_key)
);
`;

// ── Post-schema statements (canonical task model, transition-era) ──
//
// These run AFTER SCHEMA_SQL, each as its own query wrapped in try/catch-and-log,
// so a single failing index or constraint can never block boot. SCHEMA_SQL is one
// monolithic query: a failure anywhere in it aborts the whole thing, which is fine
// for CREATE TABLE IF NOT EXISTS but not for statements that can legitimately fail
// against dirty existing data.
//
// The two helper functions are the SINGLE definition of two predicates that the
// migration, the audit endpoint, and later phases all need. Duplicating either one
// in JS-built SQL is how the two drift apart, so they live here in the schema.
const POST_SCHEMA_STATEMENTS = [
  // Is this row a "task" for canonical-model purposes? The JS twin is db.isTaskRow.
  // Exclusions: containers (day_root), time-tracking segments (time_entry),
  // standing lists (delegated_item), responsibility scaffolding (responsibility*
  // except the dated responsibility_task instance),
  // group templates (task_group), move tombstones (reschedule_tombstone), Slack
  // reaction-order tombstones (slack_reaction_tombstone), and meeting automation
  // artifacts (meeting_prep/transcript/summary and proposed_action_item).
  // Shells and meetings ARE task rows.
  ["fn dcc_is_task_row", `
    CREATE OR REPLACE FUNCTION dcc_is_task_row(p_type text, p_props jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
      SELECT p_type IS DISTINCT FROM 'day_root'
         AND p_type IS DISTINCT FROM 'time_entry'
         AND COALESCE(p_props->>'kind', '') NOT IN
             ('delegated_item', 'task_group', 'reschedule_tombstone', 'triage_suppression', 'slack_reaction_tombstone', 'slack_done_intent',
              'meeting_prep', 'meeting_transcript', 'meeting_summary', 'proposed_action_item')
         AND (COALESCE(p_props->>'kind', '') NOT LIKE 'responsibility%'
              OR COALESCE(p_props->>'kind', '') = 'responsibility_task')
    $fn$;
  `],

  // Resolve a client-space reference (a legacy properties.local_id, or already a
  // row id) to exactly ONE blocks.id, or NULL when it is unresolvable OR ambiguous.
  //
  // Ambiguity is real, not theoretical: legacy local_ids are Date.now()-based and
  // DO collide across days. Returning NULL on a tie is the whole point — a NULL
  // parent_id degrades a row to a root, which is exactly today's flat behavior,
  // never worse. A wrong guess would silently re-parent someone's task.
  //
  // Preference tiers, best first:
  //   1. p_ref is itself a row id      (newer data already lives in row-id space)
  //   2. local_id match on the same date
  //   3. local_id match on an undated row
  // and within a tier, a live row beats a soft-deleted one.
  ["fn dcc_resolve_local_id", `
    CREATE OR REPLACE FUNCTION dcc_resolve_local_id(p_ws text, p_date date, p_ref text)
    RETURNS text LANGUAGE sql STABLE AS $fn$
      WITH m AS (
        SELECT x.id,
               (CASE WHEN x.id = p_ref THEN 1
                     WHEN x.date IS NOT DISTINCT FROM p_date THEN 2
                     ELSE 3 END) * 10
               + (CASE WHEN x.deleted_at IS NULL THEN 0 ELSE 1 END) AS tier
          FROM blocks x
         WHERE x.workspace_id IS NOT DISTINCT FROM p_ws
           AND x.type <> 'day_root'
           AND ( x.id = p_ref
              OR ( x.properties->>'local_id' = p_ref
                   AND (x.date IS NOT DISTINCT FROM p_date OR x.date IS NULL) ) )
      )
      SELECT CASE WHEN count(*) = 1 THEN min(m.id) END
        FROM m
       WHERE m.tier = (SELECT min(tier) FROM m)
    $fn$;
  `],

  // How many rows did dcc_resolve_local_id consider at its winning tier? Lets the
  // migration and the audit tell the two failure modes apart, which matter very
  // differently: 0 candidates means the task is simply gone (harmless), while 2+
  // means a live Date.now() collision that a read flip could mis-link.
  ["fn dcc_count_local_id_candidates", `
    CREATE OR REPLACE FUNCTION dcc_count_local_id_candidates(p_ws text, p_date date, p_ref text)
    RETURNS integer LANGUAGE sql STABLE AS $fn$
      WITH m AS (
        SELECT (CASE WHEN x.id = p_ref THEN 1
                     WHEN x.date IS NOT DISTINCT FROM p_date THEN 2
                     ELSE 3 END) * 10
               + (CASE WHEN x.deleted_at IS NULL THEN 0 ELSE 1 END) AS tier
          FROM blocks x
         WHERE x.workspace_id IS NOT DISTINCT FROM p_ws
           AND x.type <> 'day_root'
           AND ( x.id = p_ref
              OR ( x.properties->>'local_id' = p_ref
                   AND (x.date IS NOT DISTINCT FROM p_date OR x.date IS NULL) ) )
      )
      SELECT COALESCE((SELECT count(*)::int FROM m WHERE m.tier = (SELECT min(tier) FROM m)), 0)
    $fn$;
  `],

  // Parse a text date, yielding NULL instead of raising on anything Postgres cannot
  // accept. A shape regex is NOT enough: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' happily admits
  // '0000-99-99' and '2026-02-31', and casting either one raises "date/time field
  // value out of range". That matters because slot_point_ledger.source_key is
  // caller-supplied and unvalidated (POST /api/slot/earn-task has no validate()
  // middleware, and earnTaskCredit only trims it), so one stored malformed prefix
  // would permanently 500 the audit endpoint AND make migration 001 unappliable,
  // since the runner wraps the whole file in one transaction.
  ["fn dcc_try_date", `
    CREATE OR REPLACE FUNCTION dcc_try_date(p_text text)
    RETURNS date LANGUAGE plpgsql IMMUTABLE AS $fn$
    BEGIN
      RETURN p_text::date;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END $fn$;
  `],

  // Transition-only index; Phase A4 drops it. Every legacy client lookup is by
  // properties.local_id.
  //
  // NOT partial on `deleted_at IS NULL`, which is how it was first written and was
  // wrong: dcc_resolve_local_id deliberately CONSIDERS soft-deleted rows (its tier
  // expression ranks them below live ones), so its predicate never implies
  // `deleted_at IS NULL` and Postgres refused the index entirely. Measured on a prod
  // restore: seq scan, 860 buffers / 7.7ms per call versus 2 buffers / 1.1ms with the
  // full index — and it is called once per row across the migration's CTEs, the audit
  // endpoint, and the live createBlock path.
  //
  // The DROP is required: CREATE INDEX IF NOT EXISTS will NOT replace a same-named
  // partial index left behind by an earlier boot of this code.
  ["idx_blocks_local_id", `
    DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE indexname = 'idx_blocks_local_id' AND indexdef LIKE '%WHERE%'
      ) THEN
        DROP INDEX idx_blocks_local_id;
      END IF;
    END $do$;
    CREATE INDEX IF NOT EXISTS idx_blocks_local_id
      ON blocks ((properties->>'local_id'));
  `],

  // ORPHANED as of C2, kept only so dropping it is a deliberate act rather than a
  // side effect. It was built for db.getOpenTasksBefore, which C2 deleted: that
  // predicate assumed `status='open'` meant not-done, and it does not -- itinerary
  // completion writes the day_root `_done` overlay, so 264 finished rows read open on
  // a prod restore. Its replacement (db.getCarryoverPool) matches three row types and
  // carries no status term at all, so this partial index cannot serve it and nothing
  // else references it. Retiring it belongs with the rest of the scaffolding in A4.
  ["idx_blocks_open", `
    CREATE INDEX IF NOT EXISTS idx_blocks_open
      ON blocks (workspace_id, date DESC)
      WHERE deleted_at IS NULL AND type = 'block'
        AND COALESCE(properties->>'status', 'open') = 'open';
  `],

  // ── A3: idempotency ──────────────────────────────────────────────────────
  //
  // THE ENFORCEMENT INDEX. Two writers holding the same key can no longer both
  // plant a row: the second insert is refused by Postgres rather than by a
  // check-then-act guard that a concurrent request can slip between. Route-level
  // dedupe (routes/blocks.js, routes/dcc.js) still runs first so the common case
  // returns a friendly "already there" instead of an error; this is the backstop
  // underneath it, and routes map its 23505 back onto the same answer.
  //
  // `deleted_at IS NULL` IS LOAD-BEARING, and the narrowing is not cosmetic.
  // Measured on a prod restore (3,106 rows / 877 tombstoned): 32 duplicate key
  // groups exist across all states, so the tombstone-spanning version A3 was
  // originally specified with CANNOT be created — Postgres refuses it outright.
  // Live-only, the count is 0 and it creates. The duplicates are all live-row +
  // tombstones, i.e. exactly the delete-and-retry history the no-resurrect
  // contract already handles at the route layer.
  //
  // The consequence to keep in mind: this constrains LIVE rows only. A tombstoned
  // row does not reserve its key, so the structural guarantee stops at
  // "no two live rows share a key" and the "don't resurrect a deleted one" half
  // stays lib/materialize-guard.js's job. Both halves are needed; neither
  // subsumes the other.
  //
  // Scoped by workspace_id first, matching db.findByIdempotencyKey's own
  // `workspace_id IS NOT DISTINCT FROM $2` — a key is identity WITHIN a tenant.
  //
  // NULLS NOT DISTINCT is load-bearing and was NOT in the first version of this index.
  // A multicolumn unique index treats NULLs as DISTINCT by default, so `(NULL,'k')`
  // and `(NULL,'k')` both insert cleanly — verified, not assumed: two such rows go in
  // without complaint, and the same index with this clause rejects the second.
  // `blocks.workspace_id` is nullable and db.createBlock passes `workspace_id || null`,
  // so that group is reachable. Without the clause the write side would disagree with
  // BOTH readers — findByIdempotencyKey's `IS NOT DISTINCT FROM` and
  // routes/admin-model.js's `GROUP BY workspace_id`, which fold NULLs together — and
  // the audit gate could read "enforced" over a live duplicate.
  // Requires PG 15+; prod is 17.6 and CI is postgres:16.
  //
  // The DROP is required, for the same reason idx_blocks_local_id above carries one:
  // `CREATE UNIQUE INDEX IF NOT EXISTS` will NOT rebuild an index that already exists
  // under this name. An earlier build of this phase created it WITHOUT the clause, so
  // any database that booted that build keeps the NULLS-DISTINCT definition — and the
  // hole — permanently, silently, because applyPostSchema swallows a no-op. Detecting
  // that in the audit endpoint is not enough; the repair has to live here.
  // Keyed on the SEMANTICS (pg_index.indnullsnotdistinct), not on matching the DDL text.
  ["idx_blocks_idem_unique", `
    DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'idx_blocks_idem_unique'
           AND NOT i.indnullsnotdistinct
      ) THEN
        DROP INDEX idx_blocks_idem_unique;
      END IF;
    END $do$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_idem_unique
      ON blocks (workspace_id, (properties->>'idempotency_key'))
      NULLS NOT DISTINCT
      WHERE properties->>'idempotency_key' IS NOT NULL
        AND deleted_at IS NULL;
  `],

  // THE LOOKUP INDEX, and it is genuinely a second index rather than a duplicate
  // of the one above. db.findByIdempotencyKey is TOMBSTONE-INCLUSIVE by design
  // (its ORDER BY ranks live rows first rather than filtering dead ones out), so
  // its predicate never implies `deleted_at IS NULL` and the unique index above
  // is unusable for it. Verified rather than assumed, on the prod restore:
  //
  //   baseline                        seq scan, 571 buffers, 6.1ms
  //   + idx_blocks_idem_unique only   seq scan, 548 buffers  (index NOT used)
  //   + this index                    index scan,  3 buffers, 0.03ms
  //
  // That path is hot: routes/slack-events.js findTaskWithRetry runs it up to 3×
  // per Slack reaction, and A2 added a third request-path caller of the same
  // shape. Deferred out of E1 because it needs this file.
  //
  // Partial on the indexed expression's own IS NOT NULL — which `= $1` implies, so
  // the planner still uses it (confirmed: bitmap index scan, and 32kB versus 56kB
  // because only 199 of 3,106 rows carry a key). Do NOT confuse this predicate
  // with the `deleted_at IS NULL` one that broke idx_blocks_local_id: that one was
  // unusable because the QUERY never implied it. This one the query does imply.
  ["idx_blocks_idem_key", `
    CREATE INDEX IF NOT EXISTS idx_blocks_idem_key
      ON blocks ((properties->>'idempotency_key'))
      WHERE properties->>'idempotency_key' IS NOT NULL;
  `],

  // Serves db.getBlocksByKind, which this change just moved onto the hot read path:
  // buildDayResponse applies the triage-suppression overlay on EVERY /api/state/day and
  // /api/state/tomorrow, and on the anonymous public-share poll (15s per open viewer).
  // Its predicate is `type='block' AND properties->>'kind'=$1 AND workspace_id=$2 AND
  // deleted_at IS NULL ORDER BY created_at`, and nothing indexed `properties->>'kind'`
  // before this: the two candidates the planner had (idx_blocks_type_date,
  // idx_blocks_workspace_date) both lead on a date column the query never predicates on,
  // and `type='block'` is most of the table, so every day read seq-scanned and
  // JSON-parsed the live block rows to find a handful of suppressions. Same shape, and
  // the same argument, as idx_blocks_idem_key above.
  //
  // The `deleted_at IS NULL` partial predicate is safe here because the QUERY implies it
  // (unlike the case that broke idx_blocks_local_id). created_at is the trailing column
  // so the index also satisfies the ORDER BY. The other two getBlocksByKind callers
  // (task_menu, task_group in routes/blocks.js) ride along for free.
  ["idx_blocks_kind", `
    CREATE INDEX IF NOT EXISTS idx_blocks_kind
      ON blocks (workspace_id, (properties->>'kind'), created_at)
      WHERE deleted_at IS NULL;
  `],
  ["idx_blocks_task_dependency_blocker", `
    CREATE INDEX IF NOT EXISTS idx_blocks_task_dependency_blocker
      ON blocks (workspace_id, (properties->>'blockerBlockId'))
      WHERE deleted_at IS NULL
        AND type = 'block'
        AND properties->>'kind' = 'delegated_item'
        AND properties->>'blockerType' = 'task';
  `],
  ["idx_blocks_task_dependency_dependent_active", `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_task_dependency_dependent_active
      ON blocks (workspace_id, (properties->>'linkedBlockId'))
      WHERE deleted_at IS NULL
        AND type = 'block'
        AND properties->>'kind' = 'delegated_item'
        AND properties->>'blockerType' = 'task'
        AND COALESCE(properties->>'status', 'open') IN ('open', 'ready');
  `],

  // Serves db.getBlocksByDateIncludingDeleted, the tombstone-inclusive day load
  // that every dedupe path and responsibility-store.loadDaySlottingContext runs.
  //
  // Handed over by Track D at close as "a partial index on `deleted_at IS NOT
  // NULL`". That shape does NOT work, and measuring it is the only reason we know:
  // the query carries no deleted_at predicate AT ALL (it wants the whole day, live
  // and dead), so a partial index on either polarity of deleted_at is unusable.
  //
  //   baseline                         seq scan, 449 buffers
  //   + (date) WHERE deleted_at IS NOT NULL   seq scan, 449 buffers (index NOT used)
  //   + this index                     index scan,  56 buffers
  //
  // So this is the de-partialed twin of idx_blocks_workspace_date, the same
  // correction idx_blocks_local_id already carries. The partial original is kept:
  // it is smaller and still preferred for the many live-only day reads.
  ["idx_blocks_workspace_date_all", `
    CREATE INDEX IF NOT EXISTS idx_blocks_workspace_date_all
      ON blocks (workspace_id, date);
  `],

  // NOT VALID so it cannot fail on existing bad rows. The migration's cycle scrub
  // runs VALIDATE CONSTRAINT once self-parents are gone.
  ["blocks_no_self_parent", `
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'blocks_no_self_parent'
      ) THEN
        ALTER TABLE blocks ADD CONSTRAINT blocks_no_self_parent
          CHECK (parent_id IS DISTINCT FROM id) NOT VALID;
      END IF;
    END $do$;
  `],

  // Applied-migration ledger for scripts/migrate.js. Lives here rather than in the
  // migration runner so a fresh boot on an empty database already has it.
  ["schema_migrations", `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      notes       JSONB NOT NULL DEFAULT '{}'
    );
  `],
];

async function applyPostSchema() {
  for (const [label, sql] of POST_SCHEMA_STATEMENTS) {
    try {
      await pool.query(sql);
    } catch (err) {
      // Deliberately non-fatal: boot must survive a statement that can't apply to
      // this database's current data. The audit endpoint reports what is missing.
      console.error(`[pg-schema] post-schema "${label}" failed (non-fatal): ${err.message}`);
    }
  }
}

async function createSchema() {
  console.log("[pg-schema] Creating tables...");
  await pool.query(SCHEMA_SQL);
  await applyPostSchema();
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
  module.exports = { createSchema, applyPostSchema };
}
