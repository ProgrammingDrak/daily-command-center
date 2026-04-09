/**
 * migrate-to-unified-blocks.js — Consolidate all block types into unified 'block' type
 *
 * All user data becomes type='block'. Properties JSONB carries identity.
 * Tags are added to distinguish old types that need routing hints.
 *
 * Run ONCE after deploying the unified block architecture.
 * Idempotent — safe to re-run (|| merge only adds, never removes).
 *
 * Usage: node migrate-to-unified-blocks.js
 */

require("dotenv/config");
const pool = require("./pg-pool");

async function migrate() {
  console.log("[migrate-unified] Starting unified block migration...");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: Add tags to types that need routing hints BEFORE changing type column
    // This preserves identity so property-based queries can find them

    // trivial_task → add tags:["trivial"]
    const trivRes = await client.query(
      `UPDATE blocks SET properties = CASE
        WHEN properties ? 'tags' THEN jsonb_set(properties, '{tags}', (COALESCE(properties->'tags', '[]'::jsonb) || '"trivial"'::jsonb))
        ELSE properties || '{"tags": ["trivial"]}'::jsonb
       END
       WHERE type = 'trivial_task' AND deleted_at IS NULL
       AND NOT (properties->'tags' @> '"trivial"'::jsonb)`
    );
    console.log(`  trivial_task: ${trivRes.rowCount} blocks tagged`);

    // action_item → add tags:["action-item"]
    const actRes = await client.query(
      `UPDATE blocks SET properties = CASE
        WHEN properties ? 'tags' THEN jsonb_set(properties, '{tags}', (COALESCE(properties->'tags', '[]'::jsonb) || '"action-item"'::jsonb))
        ELSE properties || '{"tags": ["action-item"]}'::jsonb
       END
       WHERE type = 'action_item' AND deleted_at IS NULL
       AND NOT (properties->'tags' @> '"action-item"'::jsonb)`
    );
    console.log(`  action_item: ${actRes.rowCount} blocks tagged`);

    // sticky_note → add tags:["pinned"]
    const stickyRes = await client.query(
      `UPDATE blocks SET properties = CASE
        WHEN properties ? 'tags' THEN jsonb_set(properties, '{tags}', (COALESCE(properties->'tags', '[]'::jsonb) || '"pinned"'::jsonb))
        ELSE properties || '{"tags": ["pinned"]}'::jsonb
       END
       WHERE type = 'sticky_note' AND deleted_at IS NULL
       AND NOT (properties->'tags' @> '"pinned"'::jsonb)`
    );
    console.log(`  sticky_note: ${stickyRes.rowCount} blocks tagged`);

    // Step 2: Consolidate all old types to 'block'
    const consolidateRes = await client.query(
      `UPDATE blocks SET type = 'block' WHERE type != 'day_root' AND type != 'block'`
    );
    console.log(`  Consolidated ${consolidateRes.rowCount} blocks to type='block'`);

    // Step 3: Verify
    const { rows: typeCount } = await client.query(
      `SELECT type, COUNT(*) as count FROM blocks WHERE deleted_at IS NULL GROUP BY type ORDER BY count DESC`
    );
    console.log("  Block type distribution after migration:");
    typeCount.forEach(r => console.log(`    ${r.type}: ${r.count}`));

    await client.query("COMMIT");
    console.log("[migrate-unified] Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[migrate-unified] Migration failed, rolled back:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  module.exports = { migrate };
}
