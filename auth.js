/**
 * auth.js — User authentication for the Daily Command Center
 *
 * Handles user creation, password hashing, and session management.
 * Uses bcryptjs for password hashing (pure JS, no native compilation).
 */

const bcrypt = require("bcryptjs");
const pool = require("./pg-pool");

const BCRYPT_ROUNDS = 12;

async function createUser({ username, password }, client) {
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  const q = client || pool;
  const { rows } = await q.query(
    `INSERT INTO users (username, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, hash, now, now]
  );
  return { id: rows[0].id, username };
}

async function findUserByUsername(username) {
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return rows[0] || null;
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

async function ensureDefaultUser() {
  const username = process.env.SEED_USERNAME || (process.env.NODE_ENV !== "production" ? "drake" : null);
  const password = process.env.SEED_PASSWORD || (process.env.NODE_ENV !== "production" ? "clever123" : null);
  if (!username || !password) return null;
  const existing = await findUserByUsername(username);
  if (existing) return existing;
  console.log(`[auth] Creating default user '${username}'`);
  return createUser({ username, password });
}

async function registerUser({ username, password }) {
  if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) throw new Error("Username must be 3-30 lowercase characters: letters, numbers, hyphens, underscores");
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters");
  const existing = await findUserByUsername(username);
  if (existing) throw new Error("Username already taken");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await createUser({ username, password }, client);
    const workspaceId = `ws-${user.id}`;
    const now = new Date().toISOString();
    await client.query(`INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, 'free', $5, $6)`, [workspaceId, `${username}'s workspace`, username, user.id, now, now]);
    await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at, created_at) VALUES ($1, $2, 'owner', $3, $4)`, [workspaceId, user.id, now, now]);
    await client.query("COMMIT");
    console.log(`[auth] Registered user '${username}' -> workspace ${workspaceId}`);
    return { user, workspaceId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createUser, findUserByUsername, verifyPassword, ensureDefaultUser, registerUser };
