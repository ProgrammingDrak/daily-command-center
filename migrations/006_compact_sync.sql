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

INSERT INTO triage_history(workspace_id, triage_id, resolved_at, resolution, title, source, item_json)
SELECT s.workspace_id,
       item->>'id',
       CASE
         WHEN COALESCE(item->>'resolved_at', '') ~ '^\d{4}-\d{2}-\d{2}T'
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
