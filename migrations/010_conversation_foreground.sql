-- @gated: Explicit foreground migration approval, clean duplicate audit, and coordinator rollout required.
-- Deployment is deliberately separate from the additive tables at boot.
-- Run the duplicate-foreground audit first; resolve each conflict with its owner.
-- Never select an arbitrary winning task or silently convert elapsed time to effort.
-- SELECT user_id, array_agg(id ORDER BY id) FROM blocks
-- WHERE deleted_at IS NULL AND user_id IS NOT NULL
-- AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)
-- GROUP BY user_id HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_foreground_per_user
 ON blocks(user_id)
 WHERE deleted_at IS NULL AND user_id IS NOT NULL
 AND properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties);
