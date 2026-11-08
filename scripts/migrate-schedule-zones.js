const fs = require("node:fs");
const { migrate } = require("./audit-schedule-zones");
const { validZone } = require("../public/js/schedule-zones");

async function migrateWorkspace(client, { workspace, zone, mode, approved = [] }) {
  if (!workspace || !validZone(zone) || !["audit", "apply", "rollback"].includes(mode) ||
      !Array.isArray(approved) || approved.some(id => typeof id !== "string")) {
    throw new Error("Invalid migration parameters");
  }
  await client.query(mode === "audit" ? "BEGIN READ ONLY" : "BEGIN");
  try {
    const args = [workspace];
    if (mode === "apply") args.push(approved);
    const { rows } = await client.query(
      "SELECT id, type, date::text AS date, properties FROM blocks " +
      "WHERE workspace_id = $1 AND type = 'block' AND deleted_at IS NULL" +
      (mode === "apply" ? " AND id = ANY($2::text[])" : "") +
      (mode === "rollback" ? " AND properties #>> '{scheduleInstant,source}' = 'reviewed-legacy-v1'" : "") +
      " ORDER BY id" + (mode === "audit" ? "" : " FOR UPDATE"),
      args,
    );
    const result = migrate(rows, { mode, zone, approved });
    for (const [index, block] of result.blocks.entries()) {
      if (block === rows[index]) continue;
      const instant = block.properties.scheduleInstant;
      if (instant) {
        await client.query(
          "UPDATE blocks SET properties = jsonb_set(properties, '{scheduleInstant}', $3::jsonb) WHERE workspace_id = $1 AND id = $2",
          [workspace, block.id, JSON.stringify(instant)],
        );
      } else {
        await client.query(
          "UPDATE blocks SET properties = properties - 'scheduleInstant' WHERE workspace_id = $1 AND id = $2",
          [workspace, block.id],
        );
      }
    }
    await client.query("COMMIT");
    return result.report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const [workspace, zone, mode = "audit", reviewFile] = process.argv.slice(2);
  const connectionString = process.env.DCC_LOCAL_MIGRATION_URL;
  const url = new URL(connectionString || "about:blank");
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.search || !url.pathname.slice(1)) {
    throw new Error("Set DCC_LOCAL_MIGRATION_URL to an explicit local PostgreSQL database URL without query parameters");
  }
  if (mode === "apply" && !reviewFile) throw new Error("Apply requires a JSON array of approved block IDs");
  const approved = reviewFile ? JSON.parse(fs.readFileSync(reviewFile, "utf8")) : [];
  const { Client } = require("pg");
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    console.log(JSON.stringify(await migrateWorkspace(client, { workspace, zone, mode, approved }), null, 2));
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { migrateWorkspace };
