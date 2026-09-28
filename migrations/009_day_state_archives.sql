-- @gated: Wave 1 approval is required for private day-state preservation.
--
-- Additive archive storage only. No application reader references this table.
-- The archive stays separate from dcc_state and normal synchronization triggers.

CREATE TABLE IF NOT EXISTS day_state_archives (
  id              BIGSERIAL PRIMARY KEY,
  source_machine  TEXT NOT NULL,
  source_path     TEXT NOT NULL,
  source_date     DATE NOT NULL,
  source_sha256   TEXT NOT NULL,
  source_bytes    BIGINT NOT NULL,
  source_content  BYTEA NOT NULL,
  payload         JSONB NOT NULL,
  archive_reason  TEXT NOT NULL DEFAULT 'workspace_release_sweep',
  provenance      JSONB NOT NULL DEFAULT '{}',
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT day_state_archives_sha256_format
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT day_state_archives_source_bytes_nonnegative
    CHECK (source_bytes >= 0),
  CONSTRAINT day_state_archives_source_unique
    UNIQUE (source_machine, source_path, source_sha256)
);

-- Preserve the exact source bytes alongside queryable JSONB.
-- This ALTER makes the migration safe when re-run after the table was created empty.
ALTER TABLE day_state_archives
  ADD COLUMN IF NOT EXISTS source_content BYTEA;

ALTER TABLE day_state_archives
  ALTER COLUMN source_content SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_day_state_archives_source_date
  ON day_state_archives (source_machine, source_date DESC, id DESC);

ALTER TABLE day_state_archives ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE day_state_archives FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE day_state_archives_id_seq FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE day_state_archives IS
  'Private, write-once preservation for exact DCC day-state files. Not used by live reads.';

DO $archive_notice$
BEGIN
  RAISE NOTICE 'day_state_archives.table_ready=1';
END $archive_notice$;
