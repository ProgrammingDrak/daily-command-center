// Deliberately independent of dotenv, DATABASE_URL and the app pool.
const process = require("node:process");
const { URL } = require("node:url");
const { Pool } = require("pg");
const crypto = require("node:crypto");
async function createFixtureDb() {
  const raw = process.env.DCC_ATTACHMENT_TEST_DATABASE_URL || process.env.DCC_TEST_DATABASE_URL;
  if (!raw || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(raw).hostname)) throw new Error("Provide a dedicated localhost DCC_ATTACHMENT_TEST_DATABASE_URL");
  const schema = "attachment_test_" + crypto.randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString: raw });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: raw, options: `-c search_path=${schema}` });
  await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, owner_id INTEGER REFERENCES users(id));
    CREATE TABLE blocks(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),user_id INTEGER REFERENCES users(id),type TEXT,properties JSONB DEFAULT '{}',date DATE,deleted_at TIMESTAMPTZ);
    INSERT INTO users VALUES(1),(2),(3);
    INSERT INTO workspaces VALUES('ws-1',1),('ws-2',2);
    INSERT INTO blocks(id,workspace_id,user_id,type) VALUES('task','ws-1',1,'added_task'),('other','ws-2',2,'added_task'),('root','ws-1',1,'day_root'),('second','ws-1',1,'added_task'),('quick-note','ws-1',1,'block'),('legacy-note','ws-1',1,'sticky_note');
    UPDATE blocks SET properties='{"tags":["pinned"],"html":"","text":""}' WHERE id='quick-note';`);
  await pool.query(require("../task-attachment-store").SCHEMA_SQL);
  return { pool, async cleanup() { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
module.exports = { createFixtureDb };
