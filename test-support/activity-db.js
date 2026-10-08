// Isolated PostgreSQL fixture, used only by tests and the opt-in review server.
// PGlite runs real PostgreSQL in memory; external tests require a localhost DB.
const crypto = require("node:crypto");
async function createActivityDb() {
  let pool, dispose;
  if (process.env.DCC_PGLITE_MODULE) {
    const { PGlite } = require(process.env.DCC_PGLITE_MODULE);
    const pg = new PGlite();
    let tail = Promise.resolve();
    async function acquire() { let release; const next = new Promise(r => { release = r; }); const prev = tail; tail = next; await prev; return release; }
    async function query(sql, args) {
      const r = args ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows || 0 };
    }
    pool = { query: async (sql, args) => { const release = await acquire(); try { return await query(sql, args); } finally { release(); } },
      connect: async () => { const release = await acquire(); return { query, release }; }, on() {} };
    dispose = () => pg.close();
  } else {
    const raw = process.env.DCC_TEST_DATABASE_URL;
    if (!raw || !["localhost", "127.0.0.1", "::1"].includes(new URL(raw).hostname)) throw new Error("A localhost DCC_TEST_DATABASE_URL or DCC_PGLITE_MODULE is required");
    const { Pool } = require("pg"), schema = "activity_test_" + crypto.randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: raw });
    await admin.query('CREATE SCHEMA "' + schema + '"');
    pool = new Pool({ connectionString: raw, options: "-c search_path=" + schema });
    dispose = async () => { await pool.end(); await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); await admin.end(); };
  }
  const poolPath = require.resolve("../pg-pool");
  const previousPool = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const blockDB = require("../db");
  await require("../pg-schema").createSchema();
  await pool.query(`INSERT INTO users(id,username,created_at,updated_at) VALUES
    (1,'activity-review',NOW(),NOW()),(2,'other-owner',NOW(),NOW()),(3,'viewer',NOW(),NOW());
    INSERT INTO workspaces(id,name,slug,owner_id,created_at,updated_at) VALUES
    ('ws-1','Activity review','activity-review',1,NOW(),NOW()),('ws-2','Other review','other-review',2,NOW(),NOW());
    INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES
    ('ws-1',1,'owner',NOW()),('ws-2',2,'owner',NOW()),('ws-1',3,'viewer',NOW());`);
  return { pool, blockDB, crypto, close: async () => { await dispose(); if (previousPool) require.cache[poolPath] = previousPool; else delete require.cache[poolPath]; } };
}
module.exports = { createActivityDb };
