-- Compact state delivery, paginated triage history, and server-cursor sync.

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
BEGIN
  IF TG_OP = 'DELETE' THEN
    ws := COALESCE(OLD.workspace_id, 'ws-1');
    event_date := OLD.date;
    event_operation := 'delete';
    entity_key := CASE WHEN TG_TABLE_NAME = 'dcc_state'
      THEN OLD.date::text ELSE OLD.id::text END;
  ELSE
    ws := COALESCE(NEW.workspace_id, 'ws-1');
    event_date := NEW.date;
    event_operation := CASE
      WHEN TG_TABLE_NAME = 'blocks' AND NEW.deleted_at IS NOT NULL THEN 'delete'
      ELSE 'upsert' END;
    entity_key := CASE WHEN TG_TABLE_NAME = 'dcc_state'
      THEN NEW.date::text ELSE NEW.id::text END;
  END IF;

  INSERT INTO sync_events(workspace_id, entity_type, entity_id, operation, entity_date)
  VALUES (ws, TG_TABLE_NAME, entity_key, event_operation, event_date);
  RETURN COALESCE(NEW, OLD);
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
