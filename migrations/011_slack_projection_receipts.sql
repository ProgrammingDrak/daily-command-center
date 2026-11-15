-- @gated: Install only for the Slack reconciliation receipt rollout.
CREATE TABLE IF NOT EXISTS slack_projection_receipts (
  workspace_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  block_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('settled', 'retry', 'unreachable', 'cooldown')),
  next_attempt_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, actor_key, block_id),
  CHECK ((block_id = '') = (outcome = 'cooldown'))
);

ALTER TABLE slack_projection_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slack_projection_receipts FROM PUBLIC;
DO $slack_receipts_privacy$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON slack_projection_receipts FROM %I', api_role);
  END LOOP;
END $slack_receipts_privacy$;
