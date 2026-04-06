/**
 * auth.js — User authentication for the Daily Command Center
 *
 * Handles user creation, password hashing, and session management.
 * Uses bcryptjs for password hashing (pure JS, no native compilation).
 */

const bcrypt = require("bcryptjs");

const BCRYPT_ROUNDS = 12;

function createUser(db, { username, password }) {
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO users (username, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(username, hash, now, now);
  return { id: result.lastInsertRowid, username };
}

function findUserByUsername(db, username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) || null;
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/**
 * Ensures the default user (drake) exists.
 * Called on server startup. Safe to call multiple times — no-ops if user exists.
 * Returns the user row, or null in production (where no default user is seeded).
 */
function ensureDefaultUser(db) {
  if (process.env.NODE_ENV === "production") return null;
  const existing = findUserByUsername(db, "drake");
  if (existing) return existing;
  console.log("[auth] Creating default user 'drake'");
  return createUser(db, { username: "drake", password: "clever123" });
}

/**
 * Registers a new user and creates their default workspace atomically.
 * Returns { user, workspaceId } on success, throws on validation failure or duplicate.
 */
function registerUser(db, { username, password }) {
  if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
    throw new Error("Username must be 3–30 lowercase characters: letters, numbers, hyphens, underscores");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (findUserByUsername(db, username)) {
    throw new Error("Username already taken");
  }

  return db.transaction(() => {
    const user = createUser(db, { username, password });
    const workspaceId = `ws-${user.id}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO workspaces (id, name, slug, owner_id, plan, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'free', ?, ?)
    `).run(workspaceId, `${username}'s workspace`, username, user.id, now, now);

    db.prepare(`
      INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at, created_at)
      VALUES (?, ?, 'owner', ?, ?)
    `).run(workspaceId, user.id, now, now);

    console.log(`[auth] Registered user '${username}' → workspace ${workspaceId}`);
    return { user, workspaceId };
  })();
}

module.exports = { createUser, findUserByUsername, verifyPassword, ensureDefaultUser, registerUser };
