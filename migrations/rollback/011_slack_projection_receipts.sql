-- Run only after every app instance is back on the previous revision.
BEGIN;
DROP TABLE IF EXISTS slack_projection_receipts;
DELETE FROM schema_migrations WHERE filename = '011_slack_projection_receipts.sql';
COMMIT;
