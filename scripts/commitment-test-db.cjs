// Synthetic fixture only. Never reads DATABASE_URL or the application's pool.
const process = require("node:process");
const { URL } = require("node:url");
const { Pool } = require("pg");
const crypto = require("node:crypto");
async function createFixtureDb() {
  const raw = process.env.DCC_TEST_DATABASE_URL;
  if (!raw && process.env.DCC_ACCOUNTABILITY_TEST_PG !== "1") throw new Error("Enable the isolated commitment test cluster explicitly");
  if (raw && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(raw).hostname)) throw new Error("DCC_TEST_DATABASE_URL must be a localhost synthetic test database");
  const schema = "dcc_commitment_test_" + crypto.randomBytes(8).toString("hex");
  const connection = raw ? { connectionString: raw } : { host: "/tmp", port: 54189, user: "drakeshadwell", database: "postgres" };
  const admin = new Pool(connection);
  if (!raw) {
    const directory = (await admin.query("SELECT current_setting('data_directory') AS directory")).rows[0].directory;
    if (directory !== "/tmp/dcc-accountability-pg") {
      await admin.end(); throw new Error("Refusing to use a cluster outside the dedicated synthetic test directory");
    }
  }
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
  await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,owner_id INTEGER REFERENCES users(id));
    CREATE TABLE friendships(requester_id INTEGER,addressee_id INTEGER,status TEXT);
    INSERT INTO users VALUES(1,'alex'),(2,'blair'),(3,'casey'),(4,'devon'),(5,'ellis');
    INSERT INTO workspaces VALUES('ws-1',1),('ws-2',2),('ws-3',3),('ws-4',4),('ws-5',5);`);
  await pool.query(require("../commitment-store").SCHEMA_SQL);
  return { pool, async cleanup() { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
module.exports = { createFixtureDb };
