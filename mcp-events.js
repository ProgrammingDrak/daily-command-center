// Native MCP Events for manual Working Queue check-backs. The callback supplied
// by ChatGPT identifies the subscribed conversation; DCC never guesses a thread.
const { createSecretBox } = require("./lib/secret-box");
const Q = require("./lib/working-queue");
const M = require("./lib/conversation-model");
const Webhook = require("./lib/mcp-event-webhook");
const NAME = "dcc.check_back_due";
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dcc_event_subscriptions (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES conversation_grants(id),
 user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 task_id TEXT NOT NULL REFERENCES blocks(id), callback_url TEXT NOT NULL, secrets TEXT NOT NULL,
 activated_at TIMESTAMPTZ NOT NULL, verified_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 last_checked_at TIMESTAMPTZ, disabled BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS dcc_event_scan ON dcc_event_subscriptions(last_checked_at) WHERE disabled=FALSE;
CREATE TABLE IF NOT EXISTS dcc_event_deliveries (
 subscription_id TEXT NOT NULL REFERENCES dcc_event_subscriptions(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL, event JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 PRIMARY KEY(subscription_id,event_id)
);
ALTER TABLE dcc_event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dcc_event_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dcc_event_subscriptions,dcc_event_deliveries FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON dcc_event_subscriptions,dcc_event_deliveries FROM %I',r);
 END LOOP;
END $privacy$;
`;
const fields = {
  task_id: { type: "string", description: "Exact canonical DCC task ID. Subscribe in its originating chat." }
};
const catalog = [
  {
    name: NAME,
    description:
      "A manual check-back deadline is due for this DCC task. This is an attention signal, not task completion or execution evidence.",
    delivery: ["webhook"],
    inputSchema: { type: "object", properties: fields, required: ["task_id"], additionalProperties: false },
    payloadSchema: {
      type: "object",
      properties: {
        ...fields,
        generation: { type: "string" },
        due_at: { type: "string" },
        prompt: { type: "string", enum: ["Sitrep?"] }
      },
      required: ["task_id", "generation", "due_at", "prompt"],
      additionalProperties: false
    }
  }
];
function error(message, code = -32602, reason) {
  const e = new Error(message);
  e.rpcCode = code;
  if (reason) e.reason = reason;
  return e;
}
function cipher(keyText) {
  const key = Buffer.from(keyText || "", "base64");
  if (key.length !== 32 || key.toString("base64") !== keyText)
    throw new Error("DCC_EVENTS_ENCRYPTION_KEY must be a base64 32-byte key");
  const box = createSecretBox(keyText, "DCC events");
  return { seal: box.sealJson, open: box.openJson };
}
function subscriptionId(identity, params) {
  return (
    "dccsub_" +
    M.digest({
      grant: identity.grantId,
      user: identity.userId,
      workspace: identity.workspaceId,
      name: NAME,
      task: params.arguments.task_id,
      url: params.delivery.url
    })
  );
}
function eventIdFor(subscription, task, generation, due) {
  return "dccevt_" + M.digest({ subscription: subscription.id, task, generation, due });
}
function dueEvent(subscription, item, now) {
  const due = Date.parse(item?.dueAt);
  if (
    !item ||
    item.task.id !== subscription.task_id ||
    !item.generation ||
    !Number.isFinite(due) ||
    due > now ||
    due < Date.parse(subscription.activated_at) ||
    ["foreground", "completed"].includes(item.status) ||
    item.snoozed ||
    !item.needsYou
  )
    return null;
  const eventId = eventIdFor(subscription, item.task.id, item.generation, item.dueAt);
  return {
    eventId,
    name: NAME,
    timestamp: new Date(due).toISOString(),
    data: { task_id: item.task.id, generation: item.generation, due_at: item.dueAt, prompt: "Sitrep?" },
    cursor: null
  };
}
function createEvents({
  pool,
  blockDB,
  key,
  now = Date.now,
  transport = Webhook.createTransport(),
  snapshot = Q.snapshot
}) {
  const encryption = cipher(key);
  async function tx(identity, fn) {
    const q = await pool.connect();
    try {
      await q.query("BEGIN");
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + identity.userId]);
      const grant = (
        await q.query(
          `SELECT g.id FROM conversation_grants g JOIN workspace_members m
        ON m.user_id=g.user_id AND m.workspace_id=g.workspace_id AND m.role='owner'
        WHERE g.id=$1 AND g.user_id=$2 AND g.workspace_id=$3 AND g.revoked_at IS NULL
        AND g.scopes ? 'dcc.read' AND g.scopes ? 'dcc.events' FOR SHARE OF g`,
          [identity.grantId, identity.userId, identity.workspaceId]
        )
      ).rows[0];
      if (!grant) throw error("Event access is no longer authorized", -32001);
      const result = await fn(q);
      await q.query("COMMIT");
      return result;
    } catch (e) {
      await q.query("ROLLBACK");
      throw e;
    } finally {
      q.release();
    }
  }
  function validate(identity, p, unsubscribe = false) {
    if (!identity.scopes?.includes("dcc.read") || !identity.scopes?.includes("dcc.events"))
      throw error("dcc.read and dcc.events consent required", -32001);
    if (
      !p ||
      Object.keys(p).some((k) => !["name", "arguments", "delivery", "cursor", "ttlMs"].includes(k)) ||
      p.name !== NAME ||
      !p.arguments ||
      Object.keys(p.arguments).length !== 1 ||
      typeof p.arguments.task_id !== "string" ||
      !p.arguments.task_id ||
      p.arguments.task_id.length > 240 ||
      p.cursor != null
    )
      throw error("Invalid event or task filter");
    if (
      !p.delivery ||
      p.delivery.mode !== "webhook" ||
      Object.keys(p.delivery).some((k) => !["mode", "url", "secret"].includes(k))
    )
      throw error("Webhook delivery required");
    try {
      Webhook.callbackUrl(p.delivery.url);
      if (!unsubscribe) Webhook.signingKey(p.delivery.secret);
    } catch {
      throw error("Invalid callback or signing secret");
    }
    if (p.ttlMs !== undefined && p.ttlMs !== null && (!Number.isSafeInteger(p.ttlMs) || p.ttlMs <= 0))
      throw error("Invalid subscription lifetime");
  }
  async function subscribe(identity, p) {
    validate(identity, p);
    const id = subscriptionId(identity, p);
    return tx(identity, async (q) => {
      const prior = (await q.query("SELECT * FROM dcc_event_subscriptions WHERE id=$1 FOR UPDATE", [id])).rows[0];
      const queue = await snapshot(q, identity, blockDB, now());
      if (!queue.items.some((i) => i.task.id === p.arguments.task_id && i.status !== "completed"))
        throw error("Choose an open task in this account working queue");
      const timestamp = now(),
        expires = new Date(timestamp + Math.min(p.ttlMs ?? 86400000, 7 * 86400000)).toISOString();
      // Expiry, revocation and callback retirement release account capacity.
      // Keep the matching row until refresh so its short key-rotation window can
      // survive a retry, but count it as a new slot when reactivating it.
      await q.query(
        `DELETE FROM dcc_event_subscriptions s WHERE s.user_id=$1 AND s.id<>$2 AND
        (s.disabled OR s.expires_at<=$3 OR NOT EXISTS (
          SELECT 1 FROM conversation_grants g JOIN workspace_members m
          ON m.user_id=g.user_id AND m.workspace_id=g.workspace_id AND m.role='owner'
          WHERE g.id=s.grant_id AND g.revoked_at IS NULL
          AND g.scopes ? 'dcc.read' AND g.scopes ? 'dcc.events'))`,
        [identity.userId, id, new Date(timestamp).toISOString()]
      );
      if (
        (
          await q.query("SELECT count(*)::int AS n FROM dcc_event_subscriptions WHERE user_id=$1 AND id<>$2", [
            identity.userId,
            id
          ])
        ).rows[0].n >= 100
      )
        throw error("Account subscription limit reached");
      const previous = prior ? encryption.open(prior.secrets) : null;
      // Verify every new callback/secret and at least every hour on refresh.
      const verifyNeeded =
        !prior ||
        prior.disabled ||
        Date.parse(prior.expires_at) <= timestamp ||
        previous.secret !== p.delivery.secret ||
        timestamp - Date.parse(prior.verified_at) > 3600000;
      if (verifyNeeded) {
        try {
          await transport.verify({ id, url: p.delivery.url, secret: p.delivery.secret });
        } catch {
          throw error("Callback could not be verified", -32015, "challenge_failed");
        }
      }
      const keys = { secret: p.delivery.secret };
      if (previous && previous.secret !== keys.secret) {
        keys.previous = previous.secret;
        keys.rotateUntil = timestamp + 300000;
      } else if (previous?.rotateUntil > timestamp) {
        keys.previous = previous.previous;
        keys.rotateUntil = previous.rotateUntil;
      }
      const activation =
        prior && !prior.disabled && Date.parse(prior.expires_at) > timestamp
          ? prior.activated_at
          : new Date(timestamp).toISOString();
      await q.query(
        `INSERT INTO dcc_event_subscriptions(id,grant_id,user_id,workspace_id,task_id,callback_url,secrets,activated_at,verified_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET secrets=EXCLUDED.secrets,
        activated_at=EXCLUDED.activated_at,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,disabled=FALSE`,
        [
          id,
          identity.grantId,
          identity.userId,
          identity.workspaceId,
          p.arguments.task_id,
          p.delivery.url,
          encryption.seal(keys),
          activation,
          verifyNeeded ? new Date(timestamp).toISOString() : prior.verified_at,
          expires
        ]
      );
      return { id, refreshBefore: expires, cursor: null, truncated: false };
    });
  }
  async function unsubscribe(identity, p) {
    validate(identity, p, true);
    return tx(identity, async (q) => {
      await q.query("DELETE FROM dcc_event_subscriptions WHERE id=$1", [subscriptionId(identity, p)]);
      return {};
    });
  }
  async function check(row) {
    const identity = { userId: row.user_id, workspaceId: row.workspace_id, grantId: row.grant_id };
    try {
      return await tx(identity, async (q) => {
        const s = (
          await q.query(
            `SELECT * FROM dcc_event_subscriptions WHERE id=$1 AND disabled=FALSE
        AND expires_at>$2 FOR UPDATE SKIP LOCKED`,
            [row.id, new Date(now()).toISOString()]
          )
        ).rows[0];
        if (!s) return;
        await q.query("UPDATE dcc_event_subscriptions SET last_checked_at=$2 WHERE id=$1", [
          s.id,
          new Date(now()).toISOString()
        ]);
        // Most subscriptions are idle. Read just their reminder metadata before
        // loading the full canonical task/session/report projection. Legacy queue
        // formats still take the canonical adoption path; actual due deliveries
        // always use a fresh full projection under this same account lock.
        const rotation = (
          await q.query("SELECT state FROM work_rotations WHERE user_id=$1 AND workspace_id=$2", [
            identity.userId,
            identity.workspaceId
          ])
        ).rows[0]?.state;
        const reminder = rotation?.items?.[s.task_id];
        const deadline = Date.parse(reminder?.dueAt);
        if (rotation?.version === 2 && (!Number.isFinite(deadline) || deadline > now())) {
          await q.query(
            "UPDATE dcc_event_deliveries SET status='cancelled' WHERE subscription_id=$1 AND status='pending'",
            [s.id]
          );
          return;
        }
        if (rotation?.version === 2 && reminder?.generation) {
          const candidateId = eventIdFor(s, s.task_id, reminder.generation, reminder.dueAt);
          const priorDelivery = (
            await q.query(
              `SELECT status,next_attempt_at FROM dcc_event_deliveries
            WHERE subscription_id=$1 AND event_id=$2`,
              [s.id, candidateId]
            )
          ).rows[0];
          if (
            priorDelivery &&
            (priorDelivery.status !== "pending" || Date.parse(priorDelivery.next_attempt_at) > now())
          )
            return;
        }
        const queue = await snapshot(q, identity, blockDB, now());
        const event = dueEvent(
          s,
          queue.items.find((i) => i.task.id === s.task_id),
          now()
        );
        // Superseded/completed/deleted/removed generations cannot be retried.
        await q.query(
          "UPDATE dcc_event_deliveries SET status='cancelled' WHERE subscription_id=$1 AND status='pending' AND event_id<>$2",
          [s.id, event?.eventId || ""]
        );
        if (!event) return;
        await q.query(
          `INSERT INTO dcc_event_deliveries(subscription_id,event_id,event,next_attempt_at)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [s.id, event.eventId, event, new Date(now()).toISOString()]
        );
        const delivery = (
          await q.query(
            `SELECT * FROM dcc_event_deliveries WHERE subscription_id=$1 AND event_id=$2
        AND status='pending' AND next_attempt_at<=$3 FOR UPDATE`,
            [s.id, event.eventId, new Date(now()).toISOString()]
          )
        ).rows[0];
        if (!delivery) return;
        const keys = encryption.open(s.secrets);
        let response;
        try {
          response = await transport.deliver(
            { id: s.id, url: s.callback_url, secret: keys.secret },
            delivery.event,
            keys.rotateUntil > now() ? keys.previous : undefined
          );
        } catch {
          response = { status: 0 };
        }
        const attempts = delivery.attempts + 1,
          accepted = response.status >= 200 && response.status < 300;
        const retry =
          response.status === 0 || response.status === 408 || response.status === 429 || response.status >= 500;
        const status = accepted ? "delivered" : retry && attempts < 8 ? "pending" : "failed";
        await q.query(
          `UPDATE dcc_event_deliveries SET attempts=$3,status=$4,next_attempt_at=$5 WHERE subscription_id=$1 AND event_id=$2`,
          [
            s.id,
            event.eventId,
            attempts,
            status,
            new Date(now() + Math.min(3600000, 15000 * 2 ** (attempts - 1))).toISOString()
          ]
        );
        if (response.status === 410)
          await q.query("UPDATE dcc_event_subscriptions SET disabled=TRUE WHERE id=$1", [s.id]);
      });
    } catch (e) {
      if (e.rpcCode !== -32001) throw e;
    } // revoked grants stop silently
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const rows = (
        await pool.query(
          `SELECT s.* FROM dcc_event_subscriptions s JOIN conversation_grants g ON g.id=s.grant_id
        JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id AND m.role='owner'
        WHERE s.disabled=FALSE AND s.expires_at>$1 AND g.revoked_at IS NULL
        AND g.scopes ? 'dcc.read' AND g.scopes ? 'dcc.events'
        AND (s.last_checked_at IS NULL OR s.last_checked_at<$2) ORDER BY s.last_checked_at NULLS FIRST LIMIT 20`,
          [new Date(now()).toISOString(), new Date(now() - 15000).toISOString()]
        )
      ).rows;
      for (const row of rows) {
        try {
          await check(row);
        } catch {
          console.error("[dcc-events] Subscription check unavailable");
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    list: (identity) => ({
      events: identity.scopes.includes("dcc.events") && identity.scopes.includes("dcc.read") ? catalog : []
    }),
    subscribe,
    unsubscribe,
    tick
  };
}
module.exports = { SCHEMA_SQL, NAME, catalog, cipher, subscriptionId, dueEvent, createEvents };
