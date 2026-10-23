// Conditional shared-list rewards use the existing won-event ledger and queue.
// Resolve current completion on reads, so interrupted hooks cannot lose awards.
const conditions = require('./public/js/reward-conditions');
function createConditionalRewardStore({ pool, enqueueReward, resolveTasks, prepareTasks = async () => null }) {
  async function reconcile(workspaceId, ownerUserId) {
    let after = 0;
    while (true) {
    const { rows } = await pool.query(`SELECT s.* FROM todo_sponsorships s
      JOIN workspaces w ON w.id=s.workspace_id AND w.owner_id=$2
      WHERE s.workspace_id=$1 AND s.id>$3 AND s.status='approved' AND s.offer_settings ? 'condition'
      ORDER BY s.id LIMIT 100`, [workspaceId, ownerUserId, after]);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const candidate of rows) {
      const { id } = candidate;
      const prepared = await prepareTasks(candidate);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [offer] } = await client.query(`SELECT s.* FROM todo_sponsorships s
          JOIN workspaces w ON w.id=s.workspace_id AND w.owner_id=$3
          WHERE s.id=$1 AND s.workspace_id=$2 FOR UPDATE OF s`, [id, workspaceId, ownerUserId]);
        if (!offer || offer.status !== 'approved' || offer.offer_settings.earnedAt) { await client.query('COMMIT'); continue; }
        const saved = offer.offer_settings.condition;
        // Validate persisted data too. Invalid data never becomes a free reward.
        conditions.normalize(saved);
        const refs = new Map(conditions.leaves(saved).map(n => [n.taskId, n]));
        const root = conditions.normalize(saved, id => refs.get(id));
        const tasks = await resolveTasks(offer, client, prepared);
        if (conditions.evaluate(root, node => tasks.get(node.taskId) === true)) {
          const result = await enqueueReward({ ownerUserId, workspaceId,
            titleSnapshot: offer.reward_title, sourceType: 'shared_condition', sourceId: String(offer.id),
            sponsorUserId: offer.sponsor_user_id, valueSnapshot: offer.value_cents || 0 }, client);
          await client.query(`UPDATE todo_sponsorships SET status='earned', updated_at=NOW(),
            offer_settings=offer_settings || jsonb_build_object('earnedAt',NOW(),'queueId',$2::int)
            WHERE id=$1`, [offer.id, result.item.id]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    }
  }
  return { reconcile };
}
module.exports = { createConditionalRewardStore };
