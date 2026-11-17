const path = require("node:path");
const crypto = require("node:crypto");
const { createDevicePairing, createPgDevicePairingStore } = require("drake-auth/device-pairing");

// Every pairing issues the same app-owned session as DCC's ordinary sign-in.
module.exports = function mountDevicePairing(app, { pool, sessionSecret, projectDir, recordLoginEvent }) {
  async function resolveAccount(userId, client = pool) {
    const { rows } = await client.query(`
      SELECT u.id, u.username, u.email, w.workspace_id FROM users u
      LEFT JOIN workspace_members w ON w.user_id=u.id AND w.role='owner'
      WHERE u.id=$1 ORDER BY w.workspace_id LIMIT 1`, [userId]);
    const user = rows[0];
    if (!user) return null;
    return { userId: user.id, username: user.username,
      workspaceId: user.workspace_id || `ws-${user.id}`, label: user.email || user.username };
  }
  const store = createPgDevicePairingStore(pool);
  const pairing = createDevicePairing({
    store,
    secret: crypto.createHmac("sha256", sessionSecret).update("dcc-device-pairing-v1").digest("hex"),
    getAccount: req => req.session.userId ? resolveAccount(req.session.userId) : null,
    resolveAccount,
    onSession: async (req, user, client) => {
      req.session.userId = user.userId;
      req.session.username = user.username;
      req.session.workspaceId = user.workspaceId;
      await recordLoginEvent(req, { ...user, eventType: "glasses_pairing" }, client);
    }
  });
  app.use(pairing.router);
  app.get("/connect-glasses", (_req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.sendFile(path.join(projectDir, "connect-glasses.html"));
  });
};
