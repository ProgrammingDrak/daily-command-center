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
 * Returns the user row.
 */
function ensureDefaultUser(db) {
  const existing = findUserByUsername(db, "drake");
  if (existing) return existing;
  console.log("[auth] Creating default user 'drake'");
  return createUser(db, { username: "drake", password: "clever123" });
}

module.exports = { createUser, findUserByUsername, verifyPassword, ensureDefaultUser };
