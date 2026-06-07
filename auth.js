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

// ── Federated identity (managed widget / OAuth) ──
// Turn an arbitrary base string (e.g. an email local-part) into a username that
// satisfies the registration rule: ^[a-z0-9_-]{3,30}$
function slugifyUsername(base) {
  let s = String(base || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length < 3) s = `${s}user`;
  return s.slice(0, 30) || "user";
}

// Find a username that collides with neither users.username nor workspaces.slug
// (registerUser uses the username as the workspace slug, which is UNIQUE).
async function uniqueUsername(base, client) {
  const root = slugifyUsername(base);
  let candidate = root;
  let n = 1;
  while (true) {
    const { rows } = await client.query(
      "SELECT 1 FROM users WHERE username = $1 UNION SELECT 1 FROM workspaces WHERE slug = $1 LIMIT 1",
      [candidate]
    );
    if (!rows.length) return candidate;
    n += 1;
    const suffix = String(n);
    candidate = `${root.slice(0, 30 - suffix.length)}${suffix}`;
  }
}

// Map a managed-widget identity (Clerk) to a local user, creating the user +
// workspace + owner membership on first sight. Mirrors registerUser's transaction
// so all downstream code keeps keying off the integer users.id.
async function findOrCreateExternalUser({ externalId, email, displayName, avatarUrl, provider }) {
  if (!externalId) throw new Error("externalId required");

  const existing = await pool.query("SELECT * FROM users WHERE external_id = $1", [externalId]);
  if (existing.rows[0]) {
    const user = existing.rows[0];
    const { rows } = await pool.query(
      "SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1",
      [user.id]
    );
    return { user: { id: user.id, username: user.username }, workspaceId: rows[0]?.workspace_id || `ws-${user.id}`, created: false };
  }

  // Link by email: if an existing account has this email and no external identity
  // yet, attach this provider to it rather than creating a duplicate. This is how
  // an existing username/password user adopts Google sign-in without losing data.
  if (email) {
    const byEmail = await pool.query("SELECT * FROM users WHERE lower(email) = lower($1) AND external_id IS NULL", [email]);
    if (byEmail.rows[0]) {
      const u = byEmail.rows[0];
      await pool.query(
        `UPDATE users SET external_id = $1, auth_provider = $2,
           display_name = COALESCE(display_name, $3), avatar_url = COALESCE(avatar_url, $4), updated_at = $5
         WHERE id = $6`,
        [externalId, provider || "external", displayName || null, avatarUrl || null, new Date().toISOString(), u.id]
      );
      const { rows } = await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner' LIMIT 1", [u.id]);
      console.log(`[auth] Linked ${provider || "external"} identity to existing user '${u.username}' (${email})`);
      return { user: { id: u.id, username: u.username }, workspaceId: rows[0]?.workspace_id || `ws-${u.id}`, created: false, linked: true };
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const base = email ? email.split("@")[0] : (displayName || "user");
    const username = await uniqueUsername(base, client);
    const now = new Date().toISOString();
    const { rows: urows } = await client.query(
      `INSERT INTO users (username, email, external_id, auth_provider, display_name, avatar_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [username, email || null, externalId, provider || "external", displayName || null, avatarUrl || null, now]
    );
    const user = { id: urows[0].id, username };
    const workspaceId = `ws-${user.id}`;
    await client.query(`INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at) VALUES ($1, $2, $3, $4, 'free', $5, $6)`, [workspaceId, `${username}'s workspace`, username, user.id, now, now]);
    await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at, created_at) VALUES ($1, $2, 'owner', $3, $4)`, [workspaceId, user.id, now, now]);
    await client.query("COMMIT");
    console.log(`[auth] Linked ${provider || "external"} user '${username}' (${email || "no email"}) -> workspace ${workspaceId}`);
    return { user, workspaceId, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createUser, findUserByUsername, verifyPassword, ensureDefaultUser, registerUser, findOrCreateExternalUser };
