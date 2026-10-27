// Additive legacy rotation storage, now owned by the conversation coordinator.
const { createTaskTiming } = require("./lib/task-timing");
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_rotations (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 0,
 state JSONB NOT NULL DEFAULT '{"background":{},"operations":[]}',
 PRIMARY KEY(workspace_id,user_id)
);
ALTER TABLE work_rotations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON work_rotations FROM PUBLIC;
DO $rotation_privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
  EXECUTE format('REVOKE ALL ON work_rotations FROM %I',r);
 END LOOP;
END $rotation_privacy$;
`;
function timingIn(ctx, q) {
  const db = { ...ctx.blockDB };
  for (const name of [
    "updateBlock",
    "getBlockIncludingDeleted",
    "getBlock",
    "deleteBlock",
    "createBlock",
    "undeleteBlock"
  ]) {
    db[name] = (...args) => ctx.blockDB[name](...args, q);
  }
  db.getTaskTimeEntries = (id, ws, opts) => ctx.blockDB.getTaskTimeEntries(id, ws, opts, q);
  db.ensureDayRoot = (date, user, ws) => ctx.blockDB.ensureDayRoot(date, user, ws, q);
  return createTaskTiming({
    pool: ctx.pool,
    blockDB: db,
    timeZone: ctx.APP_TIME_ZONE || "America/New_York",
    transactionClient: q
  });
}
module.exports = { SCHEMA_SQL, timingIn };
