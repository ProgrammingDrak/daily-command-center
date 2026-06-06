/**
 * social-store.js — Multi-user social layer for Daily Command Center.
 *
 * Owns the sponsor-first social model: the sponsor allowlist, the sponsorship
 * review lifecycle (allowlisted = immediate, everyone else = pending), the
 * unified reward queue + append-only event ledger, and opt-in feed posts.
 *
 * Design contract: SOCIAL-FEATURES-PLAN.md. Schema: pg-schema.js.
 *
 * Modular by intent — plain functions in, typed rows out, no HTTP/UI
 * assumptions. server.js routes are thin adapters over this module. Mirrors
 * the conventions in slot-store.js (pool transactions, FOR UPDATE row locks,
 * ON CONFLICT idempotency).
 *
 * Integrity guarantees (see SOCIAL-FEATURES-PLAN.md > Integrity Guarantees):
 *  - reward_events is the append-only source of truth; counters are caches.
 *  - won_at is immutable; redeem never rewrites it.
 *  - Every state change that needs exactly-once carries a source_id idempotency
 *    key, deduped by the partial unique index on reward_events.
 *  - Win / redeem / approve are single transactions; activate-vs-remove races
 *    resolve by status guard (loser no-ops).
 */

const pool = require("./pg-pool");

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────────────
// Reward event ledger (append-only, idempotent)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Append a reward event. Pass a non-empty `sourceId` to make it exactly-once
 * (the partial unique index dedupes). Returns the inserted row, or null when a
 * keyed event was a duplicate (no-op). Runs on the given client (inside a tx)
 * or the pool.
 */
async function recordEvent(q, {
  rewardQueueId = null,
  rewardDefinitionId = null,
  ownerUserId,
  actorUserId = null,
  eventType,
  sourceType = "manual",
  sourceId = "",
  metadata = {},
} = {}) {
  const { rows } = await q.query(
    `INSERT INTO reward_events
       (reward_queue_id, reward_definition_id, owner_user_id, actor_user_id,
        event_type, source_type, source_id, event_at, event_date, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW(), $8, $9)
     ON CONFLICT (owner_user_id, event_type, source_type, source_id)
       WHERE source_id <> ''
     DO NOTHING
     RETURNING *`,
    [rewardQueueId, rewardDefinitionId, ownerUserId, actorUserId,
     eventType, sourceType, sourceId, isoDate(), JSON.stringify(metadata)]
  );
  return rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────────
// Workspace / relationship helpers
// ──────────────────────────────────────────────────────────────────────────

async function resolveWorkspaceId(userId) {
  const { rows } = await pool.query(
    "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND role='owner' LIMIT 1",
    [userId]
  );
  return rows[0] ? rows[0].workspace_id : `ws-${userId}`;
}

async function isBlocked(ownerUserId, otherUserId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships
      WHERE status='blocked'
        AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))
      LIMIT 1`,
    [ownerUserId, otherUserId]
  );
  return rows.length > 0;
}

async function areFriends(a, b) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships
      WHERE status='accepted'
        AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))
      LIMIT 1`,
    [a, b]
  );
  return rows.length > 0;
}

/** Send a friend request. If the addressee had already requested the requester,
 *  this auto-accepts (mutual intent). Idempotent on the directed pair. */
async function requestFriend(requesterId, addresseeId) {
  if (requesterId === addresseeId) throw new Error("cannot friend yourself");
  const reverse = await pool.query(
    `SELECT * FROM friendships WHERE requester_id=$1 AND addressee_id=$2`,
    [addresseeId, requesterId]
  );
  if (reverse.rows[0] && reverse.rows[0].status === "pending") {
    const { rows } = await pool.query(
      `UPDATE friendships SET status='accepted', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [reverse.rows[0].id]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `INSERT INTO friendships (requester_id, addressee_id, status)
     VALUES ($1,$2,'pending')
     ON CONFLICT (requester_id, addressee_id) DO UPDATE SET updated_at=NOW()
     RETURNING *`,
    [requesterId, addresseeId]
  );
  return rows[0];
}

/** Addressee responds to a pending request: accept or decline. */
async function respondFriend(addresseeId, requesterId, accept) {
  const { rows } = await pool.query(
    `UPDATE friendships SET status=$3, updated_at=NOW()
      WHERE requester_id=$1 AND addressee_id=$2 AND status='pending'
      RETURNING *`,
    [requesterId, addresseeId, accept ? "accepted" : "declined"]
  );
  return { friendship: rows[0] || null, changed: rows.length > 0 };
}

/** Block another user (either direction). Marks an existing edge blocked or
 *  creates one. Blocking also disables auto-approval via isBlocked checks. */
async function blockUser(userId, otherId) {
  const { rows } = await pool.query(
    `INSERT INTO friendships (requester_id, addressee_id, status)
     VALUES ($1,$2,'blocked')
     ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status='blocked', updated_at=NOW()
     RETURNING *`,
    [userId, otherId]
  );
  return rows[0];
}

async function listFriends(userId) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END AS friend_id, updated_at
       FROM friendships
      WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1)
      ORDER BY updated_at DESC`,
    [userId]
  );
  return rows;
}

async function listFriendRequests(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM friendships WHERE addressee_id=$1 AND status='pending' ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Sponsor allowlist (source of truth for auto-approval)
// ──────────────────────────────────────────────────────────────────────────

function scopeMatches(entryScope, want) {
  return entryScope === "both" || entryScope === want;
}

/** Allowlist resolution rule. `scope` is 'task' or 'slot'. Guests (no
 *  allowed_user_id) can never match because they have no user id to look up. */
async function isAllowlisted(ownerUserId, sponsorUserId, scope) {
  if (!sponsorUserId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM sponsor_allowlist
      WHERE owner_user_id=$1 AND allowed_user_id=$2 AND (scope=$3 OR scope='both')
      LIMIT 1`,
    [ownerUserId, sponsorUserId, scope]
  );
  return rows.length > 0;
}

async function listAllowlist(ownerUserId) {
  const { rows } = await pool.query(
    `SELECT * FROM sponsor_allowlist WHERE owner_user_id=$1 ORDER BY created_at DESC`,
    [ownerUserId]
  );
  return rows;
}

async function addAllowlistEntry({ ownerUserId, allowedUserId, scope = "both", note = "", createdByUserId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO sponsor_allowlist (owner_user_id, allowed_user_id, scope, note, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_user_id, allowed_user_id)
     DO UPDATE SET scope=EXCLUDED.scope, note=EXCLUDED.note
     RETURNING *`,
    [ownerUserId, allowedUserId, scope, note, createdByUserId]
  );
  return rows[0];
}

async function removeAllowlistEntry(ownerUserId, allowedUserId) {
  await pool.query(
    `DELETE FROM sponsor_allowlist WHERE owner_user_id=$1 AND allowed_user_id=$2`,
    [ownerUserId, allowedUserId]
  );
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Reward queue (unified earned-reward instances)
// ──────────────────────────────────────────────────────────────────────────

const TERMINAL_QUEUE_STATES = new Set(["redeemed", "completed", "dismissed", "expired"]);

/**
 * Enqueue an earned reward. Idempotent on (ownerUserId, source_type, sourceId):
 * the same win replayed returns the existing item without double-crediting.
 * One transaction: the `won` event + the queue row land together.
 */
/**
 * Pure: is a confirmed slot spin a redeemable reward win that belongs in the
 * unified reward queue? Only catalog-reward wins qualify — they carry a
 * `reward_id`. Misses, bank builders, and the common point/pet/collectible/
 * booster outcomes (which have no `reward_id`) are economy mechanics, not queue
 * rewards. Unit-testable without a DB; the server confirm-spin hook calls this.
 */
function isQueueableSpinWin(spin) {
  if (!spin || spin.status !== "confirmed" || !spin.reward_id) return false;
  const snap = spin.reward_snapshot || {};
  if (snap.kind === "miss" || snap.kind === "bank_builder") return false;
  if (snap.source_type === "slot_screen_bank_builder") return false;
  return true;
}

async function enqueueReward({
  ownerUserId,
  workspaceId = null,
  rewardDefinitionId = null,
  titleSnapshot,
  sourceType,
  sourceId = "",
  sponsorUserId = null,
  valueSnapshot = 0,
  chanceSharesSnapshot = null,
  tierSnapshot = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotency guard: the `won` event is the arbiter.
    const wonEvent = await recordEvent(client, {
      ownerUserId,
      rewardDefinitionId,
      actorUserId: sponsorUserId,
      eventType: "won",
      sourceType,
      sourceId,
      metadata: { titleSnapshot, valueSnapshot },
    });

    if (!wonEvent && sourceId) {
      // Duplicate win — return the already-queued item, change nothing.
      const existing = await client.query(
        `SELECT q.* FROM reward_queue_items q
           JOIN reward_events e ON e.reward_queue_id = q.id
          WHERE e.owner_user_id=$1 AND e.event_type='won'
            AND e.source_type=$2 AND e.source_id=$3
          LIMIT 1`,
        [ownerUserId, sourceType, sourceId]
      );
      await client.query("COMMIT");
      return { item: existing.rows[0] || null, duplicate: true };
    }

    const { rows } = await client.query(
      `INSERT INTO reward_queue_items
         (owner_user_id, workspace_id, reward_definition_id, title_snapshot,
          source_type, source_id, status, won_at, won_date, sponsor_user_id,
          value_snapshot, chance_shares_snapshot, tier_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,'queued', NOW(), $7, $8, $9, $10, $11)
       RETURNING *`,
      [ownerUserId, workspaceId, rewardDefinitionId, titleSnapshot,
       sourceType, sourceId, isoDate(), sponsorUserId,
       valueSnapshot, chanceSharesSnapshot, tierSnapshot]
    );
    const item = rows[0];

    // Link the won event to the queue row and bump the won counter cache.
    await client.query(
      `UPDATE reward_events SET reward_queue_id=$1 WHERE id=$2`,
      [item.id, wonEvent.id]
    );
    if (rewardDefinitionId) {
      await client.query(
        `UPDATE slot_rewards SET times_won = times_won + 1, last_won_at = NOW() WHERE id=$1`,
        [rewardDefinitionId]
      );
    }

    await client.query("COMMIT");
    return { item, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listRewardQueue(ownerUserId, { status = null } = {}) {
  if (status) {
    const { rows } = await pool.query(
      `SELECT * FROM reward_queue_items WHERE owner_user_id=$1 AND status=$2 ORDER BY won_at DESC`,
      [ownerUserId, status]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM reward_queue_items WHERE owner_user_id=$1 ORDER BY won_at DESC`,
    [ownerUserId]
  );
  return rows;
}

async function _transition(queueId, ownerUserId, { from, to, stamp, eventType, counter, columns, eventMetadata }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM reward_queue_items WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
      [queueId, ownerUserId]
    );
    const item = rows[0];
    if (!item) { await client.query("ROLLBACK"); throw new Error("reward not found"); }
    if (from && !from.includes(item.status)) {
      // Status guard: losing writer no-ops instead of corrupting state.
      await client.query("COMMIT");
      return { item, changed: false };
    }
    const sets = [`status=$3`];
    const args = [queueId, ownerUserId, to];
    if (stamp) { sets.push(`${stamp}=NOW()`); }
    if (stamp === "redeemed_at") { sets.push(`redeemed_date='${isoDate()}'`); }
    // Extra parameterized column writes (e.g. scheduled_for, scheduled_block_id).
    if (columns) {
      for (const [col, value] of Object.entries(columns)) {
        args.push(value);
        sets.push(`${col}=$${args.length}`);
      }
    }
    const upd = await client.query(
      `UPDATE reward_queue_items SET ${sets.join(", ")} WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      args
    );
    const next = upd.rows[0];
    await recordEvent(client, {
      rewardQueueId: queueId,
      rewardDefinitionId: item.reward_definition_id,
      ownerUserId,
      actorUserId: ownerUserId,
      eventType,
      sourceType: "reward_queue",
      sourceId: `${eventType}:${queueId}`,
      metadata: eventMetadata || {},
    });
    if (counter && item.reward_definition_id) {
      await client.query(
        `UPDATE slot_rewards SET ${counter} WHERE id=$1`,
        [item.reward_definition_id]
      );
    }
    await client.query("COMMIT");
    return { item: next, changed: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const claimReward = (queueId, ownerUserId) =>
  _transition(queueId, ownerUserId, { from: ["queued"], to: "claimed", stamp: "claimed_at", eventType: "claimed" });

/** Schedule a won reward into the user's itinerary. Parks the chosen time +
 *  the itinerary block id on the queue row so the queue can show "scheduled for
 *  X"; the reward is still redeemed (burned) when the user actually does it.
 *  `scheduledFor` is an ISO timestamp string (or null); `blockId` links the
 *  itinerary block. Re-scheduling an already-scheduled reward just moves it. */
const scheduleReward = (queueId, ownerUserId, { scheduledFor = null, blockId = null } = {}) =>
  _transition(queueId, ownerUserId, {
    from: ["queued", "claimed", "scheduled"], to: "scheduled", stamp: null, eventType: "scheduled",
    columns: { scheduled_for: scheduledFor, scheduled_block_id: blockId },
    eventMetadata: { scheduledFor, blockId },
  });

/** Undo a schedule: a scheduled reward returns to the queue and the parked
 *  itinerary link is cleared. Status-guarded to `scheduled` (stale undo no-ops).
 *  The itinerary block itself is removed by the caller (front-end). */
const unscheduleReward = (queueId, ownerUserId) =>
  _transition(queueId, ownerUserId, {
    from: ["scheduled"], to: "queued", stamp: null, eventType: "unscheduled",
    columns: { scheduled_for: null, scheduled_block_id: null },
  });

/** Redeem ("burn") a reward. `actualSeconds`, when provided, is the stopwatch
 *  elapsed from the "Go do it now" flow, recorded on the audit event. Redeem
 *  stamps redeemed_date to today, so the reward lands on the day it was used. */
const redeemReward = (queueId, ownerUserId, { actualSeconds = null } = {}) =>
  _transition(queueId, ownerUserId, {
    from: ["queued", "claimed", "scheduled"], to: "redeemed", stamp: "redeemed_at", eventType: "redeemed",
    counter: "times_redeemed = times_redeemed + 1, last_redeemed_at = NOW()",
    eventMetadata: actualSeconds != null ? { actualSeconds } : {},
  });

/** Redeem the scheduled reward parked on a given itinerary block, if any. This
 *  is the real "burn": it fires when the user completes the reward's itinerary
 *  task. No-ops when no scheduled reward matches the block; redeemReward's status
 *  guard makes a repeat completion (or a race with "Go do it now") a safe no-op. */
async function redeemScheduledByBlock(ownerUserId, blockId) {
  if (!blockId) return { item: null, changed: false };
  const { rows } = await pool.query(
    `SELECT id FROM reward_queue_items
      WHERE owner_user_id=$1 AND scheduled_block_id=$2 AND status='scheduled'
      LIMIT 1`,
    [ownerUserId, String(blockId)]
  );
  if (!rows[0]) return { item: null, changed: false };
  return redeemReward(rows[0].id, ownerUserId);
}

/** Discard (the user-facing "Discard" button): clears a ghosted or unwanted
 *  reward. Sets `dismissed` + an audit event; never counts as redeemed; the
 *  won event stays in the ledger. */
const discardReward = (queueId, ownerUserId) =>
  _transition(queueId, ownerUserId, { from: ["queued", "claimed", "scheduled"], to: "dismissed", stamp: null, eventType: "dismissed" });

/** Undo a redeem ("un-burn"): a redeemed reward returns to the queue, clearing
 *  the redeemed stamps and decrementing the cached redeemed counter. Status-
 *  guarded to `redeemed`, so a stale/double undo no-ops. won_at is untouched. */
async function unredeemReward(queueId, ownerUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM reward_queue_items WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
      [queueId, ownerUserId]
    );
    const item = rows[0];
    if (!item) { await client.query("ROLLBACK"); throw new Error("reward not found"); }
    if (item.status !== "redeemed") { await client.query("COMMIT"); return { item, changed: false }; }
    const upd = await client.query(
      `UPDATE reward_queue_items
          SET status='queued', redeemed_at=NULL, redeemed_date=NULL
        WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      [queueId, ownerUserId]
    );
    await recordEvent(client, {
      rewardQueueId: queueId,
      rewardDefinitionId: item.reward_definition_id,
      ownerUserId,
      actorUserId: ownerUserId,
      eventType: "unredeemed",
      sourceType: "reward_queue",
      sourceId: "",
    });
    if (item.reward_definition_id) {
      await client.query(
        `UPDATE slot_rewards SET times_redeemed = GREATEST(0, times_redeemed - 1) WHERE id=$1`,
        [item.reward_definition_id]
      );
    }
    await client.query("COMMIT");
    return { item: upd.rows[0], changed: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Sponsorships (allowlist-gated; generalized todo_sponsorships)
// ──────────────────────────────────────────────────────────────────────────

/** Pure: maps allowlisted -> initial review_state. Unit-testable without a DB. */
function resolveReviewState(allowlisted) {
  return allowlisted ? "auto_approved" : "pending";
}

/**
 * Create a sponsorship offer. Allowlisted (and not blocked) sponsors activate
 * immediately; everyone else lands `pending` for the owner's Reward Review.
 */
async function requestSponsorship({
  ownerUserId,
  sponsorUserId = null,
  sponsorName = null,
  targetType, // 'task' | 'slot_machine'
  targetId,
  rewardDefinitionId = null,
  rewardTitle,
  valueCents = 0,
  chanceShares = null,
  note = "",
  workspaceId = null,
}) {
  const scope = targetType === "slot_machine" ? "slot" : "task";
  const blocked = sponsorUserId ? await isBlocked(ownerUserId, sponsorUserId) : false;
  const allowlisted = !blocked && (await isAllowlisted(ownerUserId, sponsorUserId, scope));
  const reviewState = resolveReviewState(allowlisted);
  const active = reviewState === "auto_approved";
  const ws = workspaceId || (await resolveWorkspaceId(ownerUserId));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO todo_sponsorships
         (workspace_id, owner_user_id, sponsor_user_id, sponsor_name, target_type, target_id,
          task_id, task_title, kind, reward_title, reward_definition_id, value_cents,
          chance_shares, note, status, review_state, requested_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW(), $17)
       RETURNING *`,
      [ws, ownerUserId, sponsorUserId, sponsorName, targetType, targetId,
       targetType === "task" ? String(targetId) : "", rewardTitle || "", "reward",
       rewardTitle || "", rewardDefinitionId, valueCents, chanceShares, note,
       active ? "active" : "pending", reviewState, active ? new Date().toISOString() : null]
    );
    let row = rows[0];
    if (active) row = await _activateSponsorship(client, row);
    await client.query("COMMIT");
    return { sponsorship: row, pending: !active };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Apply a sponsorship's effect. For slot sponsorships, add a sponsored reward
 *  into the owner's slot rotation (reusing slot-store's reward catalog). Task
 *  sponsorships are marked active here; the reward is queued when the task is
 *  completed (Phase 3 completion hook). Runs inside the caller's transaction. */
async function _activateSponsorship(client, row) {
  if (row.target_type === "slot_machine") {
    // Lazy require avoids any load-order coupling; slot-store does not import us.
    const slotStore = require("./slot-store");
    const reward = await slotStore.createReward(row.workspace_id, {
      title: row.reward_title,
      kind: "sponsor",
      payment_source: "sponsored",
      chance_shares: row.chance_shares || 1,
      value_cents: row.value_cents || 0,
      notes: row.note || "",
    });
    const upd = await client.query(
      `UPDATE todo_sponsorships SET reward_definition_id=$2, activated_at=NOW() WHERE id=$1 RETURNING *`,
      [row.id, reward.id]
    );
    return upd.rows[0];
  }
  return row;
}

async function listPendingSponsorships(ownerUserId) {
  const { rows } = await pool.query(
    `SELECT * FROM todo_sponsorships
      WHERE owner_user_id=$1 AND review_state='pending'
      ORDER BY created_at DESC`,
    [ownerUserId]
  );
  return rows;
}

async function approveSponsorship(sponsorshipId, reviewerUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM todo_sponsorships WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
      [sponsorshipId, reviewerUserId]
    );
    const row = rows[0];
    if (!row) { await client.query("ROLLBACK"); throw new Error("sponsorship not found"); }
    if (row.review_state !== "pending") { await client.query("COMMIT"); return { sponsorship: row, changed: false }; }
    const upd = await client.query(
      `UPDATE todo_sponsorships
          SET review_state='approved', status='active', reviewed_by_user_id=$2, reviewed_at=NOW()
        WHERE id=$1 RETURNING *`,
      [sponsorshipId, reviewerUserId]
    );
    const activated = await _activateSponsorship(client, upd.rows[0]);
    await client.query("COMMIT");
    return { sponsorship: activated, changed: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function rejectSponsorship(sponsorshipId, reviewerUserId) {
  const { rows } = await pool.query(
    `UPDATE todo_sponsorships
        SET review_state='rejected', status='rejected', reviewed_by_user_id=$2, reviewed_at=NOW()
      WHERE id=$1 AND owner_user_id=$2 AND review_state='pending'
      RETURNING *`,
    [sponsorshipId, reviewerUserId]
  );
  return { sponsorship: rows[0] || null, changed: rows.length > 0 };
}

/** Owner removes an already-active sponsorship. Revokes the effect (deactivates
 *  the sponsored slot reward) and writes a `sponsor_removed` audit event;
 *  history is preserved. Status guard: only `active` can be removed. */
async function removeSponsorship(sponsorshipId, ownerUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM todo_sponsorships WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
      [sponsorshipId, ownerUserId]
    );
    const row = rows[0];
    if (!row) { await client.query("ROLLBACK"); throw new Error("sponsorship not found"); }
    if (row.status !== "active") { await client.query("COMMIT"); return { sponsorship: row, changed: false }; }

    if (row.target_type === "slot_machine" && row.reward_definition_id) {
      await client.query(
        `UPDATE slot_rewards SET sponsor_active=FALSE, active=FALSE WHERE id=$1`,
        [row.reward_definition_id]
      );
    }
    const upd = await client.query(
      `UPDATE todo_sponsorships SET status='removed', removed_at=NOW() WHERE id=$1 RETURNING *`,
      [sponsorshipId]
    );
    await recordEvent(client, {
      rewardDefinitionId: row.reward_definition_id,
      ownerUserId,
      actorUserId: ownerUserId,
      eventType: "sponsor_removed",
      sourceType: "sponsorship",
      sourceId: `sponsor_removed:${sponsorshipId}`,
      metadata: { sponsorUserId: row.sponsor_user_id, targetType: row.target_type },
    });
    await client.query("COMMIT");
    return { sponsorship: upd.rows[0], changed: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Feed posts (opt-in; default hidden; private/work tasks can never publish)
// ──────────────────────────────────────────────────────────────────────────

async function createCompletionPost({
  ownerUserId,
  workspaceId = null,
  taskId,
  completionId = null,
  pointsAwarded = 0,
  estimatedMinutes = null,
  actualMinutes = null,
  isPrivate = false,
  isWorkSourced = false,
}) {
  const locked = isPrivate || isWorkSourced;
  const { rows } = await pool.query(
    `INSERT INTO feed_posts
       (owner_user_id, workspace_id, task_id, completion_id, points_awarded,
        estimated_minutes, actual_minutes, publish_state, publish_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'hidden',$8)
     RETURNING *`,
    [ownerUserId, workspaceId, taskId, completionId, pointsAwarded,
     estimatedMinutes, actualMinutes, locked ? "private_task" : "default_hidden"]
  );
  return rows[0];
}

/** Publish a completion post. The work-task wall: a post whose source is
 *  `private_task` (private OR work-sourced) can never be published. */
async function publishPost(postId, ownerUserId, { caption = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE feed_posts
        SET publish_state='published', publish_source='user_published',
            published_at=NOW(), caption=COALESCE($3, caption)
      WHERE id=$1 AND owner_user_id=$2 AND publish_source <> 'private_task'
      RETURNING *`,
    [postId, ownerUserId, caption]
  );
  return { post: rows[0] || null, published: rows.length > 0 };
}

async function hidePost(postId, ownerUserId) {
  const { rows } = await pool.query(
    `UPDATE feed_posts SET publish_state='manually_hidden', hidden_at=NOW()
      WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
    [postId, ownerUserId]
  );
  return { post: rows[0] || null, changed: rows.length > 0 };
}

/** A viewer's friends feed: published posts from accepted friends only. */
async function listFriendsFeed(viewerUserId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT p.* FROM feed_posts p
      WHERE p.publish_state='published'
        AND (
          p.owner_user_id=$1
          OR p.owner_user_id IN (
            SELECT CASE WHEN requester_id=$1 THEN addressee_id ELSE requester_id END
              FROM friendships
             WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$1)
          )
        )
      ORDER BY p.published_at DESC
      LIMIT $2`,
    [viewerUserId, limit]
  );
  return rows;
}

module.exports = {
  // allowlist
  isAllowlisted,
  listAllowlist,
  addAllowlistEntry,
  removeAllowlistEntry,
  // relationships
  isBlocked,
  areFriends,
  requestFriend,
  respondFriend,
  blockUser,
  listFriends,
  listFriendRequests,
  resolveWorkspaceId,
  // reward queue + ledger
  recordEvent,
  isQueueableSpinWin,
  enqueueReward,
  listRewardQueue,
  claimReward,
  scheduleReward,
  unscheduleReward,
  redeemScheduledByBlock,
  redeemReward,
  discardReward,
  // sponsorships
  requestSponsorship,
  listPendingSponsorships,
  approveSponsorship,
  rejectSponsorship,
  removeSponsorship,
  // feed
  createCompletionPost,
  publishPost,
  hidePost,
  listFriendsFeed,
  // pure helpers (unit-testable without a DB)
  _test: {
    resolveReviewState,
    scopeMatches,
    isoDate,
    isQueueableSpinWin,
    TERMINAL_QUEUE_STATES,
  },
};
