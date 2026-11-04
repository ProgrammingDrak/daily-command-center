// Queue membership and reminders, separate from task hierarchy/schedule/actuals.
// Writes run only inside the account activity coordinator transaction.
const M = require("./conversation-model");
const { isBlockDone, completionMsOf } = require("./task-timing");
const { classify, orderPriority, hasPriorActivity, isForegroundBreak } = require("./queue-classification");
const Policy = require("../public/js/queue-policy");
const Priority = require("../public/js/task-priority");
const MAX_ITEMS = 100;
async function load(q, owner) {
  const row = (
    await q.query("SELECT state FROM work_rotations WHERE workspace_id=$1 AND user_id=$2", [
      owner.workspaceId,
      owner.userId
    ])
  ).rows[0];
  const prior = row?.state || {};
  const items = Object.assign(Object.create(null), prior.version === 2 ? prior.items : {});
  const order = [...new Set(prior.version === 2 && Array.isArray(prior.order) ? prior.order : [])];
  if (prior.version !== 2) {
    for (const [id, item] of Object.entries(prior.background || {})) {
      items[id] = { ...item, status: "background", note: "", joinedAt: item.backgroundSince };
      order.push(id);
    }
    // One-time, additive adoption of the earlier integration's background list.
    const legacy = (
      await q.query("SELECT task_id,started_at FROM conversation_background WHERE user_id=$1 AND workspace_id=$2", [
        owner.userId,
        owner.workspaceId
      ])
    ).rows;
    for (const row of legacy)
      if (!Object.hasOwn(items, row.task_id)) {
        items[row.task_id] = {
          status: "background",
          note: "",
          joinedAt: new Date(row.started_at).toISOString(),
          backgroundSince: new Date(row.started_at).toISOString()
        };
        order.push(row.task_id);
      }
  }
  return { ...prior, version: 2, order, items };
}
async function reconcile(q, owner, data, blockDB, at) {
  const rows = (
    await q.query(
      `SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
    AND (id=ANY($3::text[]) OR (properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)))`,
      [owner.userId, owner.workspaceId, data.order]
    )
  ).rows
    .map(blockDB.parseBlock)
    .filter((task) => blockDB.isTaskRow(task) && classify(task) !== null);
  const live = new Map(rows.map((row) => [row.id, row]));
  data.order = data.order.filter((id) => live.has(id));
  for (const id of Object.keys(data.items))
    if (!live.has(id)) {
      if (hasPriorActivity({}, data.items[id])) data.history = { ...data.history, [id]: true };
      delete data.items[id];
    }
  for (const task of rows) {
    const item = ensure(data, task.id, at);
    if (isBlockDone(task)) {
      item.status = "completed";
      clearReminder(item);
    } else if (task.properties.startedAt) {
      item.status = "foreground";
      clearReminder(item);
    } else if ((item.status === "foreground" && !isForegroundBreak(task, item)) || item.status === "completed") {
      item.status = "paused";
      clearReminder(item);
    }
    // Old rotation entries are adopted only if their saved pause still matches.
    if (
      item.dueAt &&
      (item.pausedOperationId !== (task.properties.workStateOperationId || null) ||
        (item.completionRevision ?? null) !== (task.properties._completionRevision || null))
    )
      clearReminder(item);
  }
}
async function save(q, owner, data) {
  await q.query(
    `INSERT INTO work_rotations(workspace_id,user_id,state) VALUES($1,$2,$3)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET state=EXCLUDED.state`,
    [owner.workspaceId, owner.userId, data]
  );
}
function ensure(data, id, at) {
  if (!Object.hasOwn(data.items, id)) {
    if (Object.values(data.items).filter(item=>item.status!=='completed').length >= MAX_ITEMS)
      throw M.fail("Schedule an unfinished task for another day before adding more than 100 active queue items", 409);
    data.items[id] = { status: "queued", note: "", joinedAt: at };
    data.order.push(id);
  }
  return data.items[id];
}
function clearReminder(item) {
  for (const key of ["dueAt", "snoozedUntil", "generation", "notifiedAt", "pausedOperationId", "completionRevision"]) delete item[key];
}
function setStatus(data, task, status, b) {
  const item = ensure(data, task.id, b.at);
  if (["foreground", "background"].includes(status) || hasPriorActivity(task, item)) item.hasActivity = true;
  else if (status === "blocked") item.hasActivity = false;
  const keepBlocked=b.attentionMode==='needs-you'&&item.status==='blocked';
  for (const key of ["breakStartedAt", "breakOperationId", "breakCompletionRevision"]) delete item[key];
  item.status = keepBlocked?'blocked':status;
  item.changedAt = b.at;
  clearReminder(item);
  if (status === "background" || status === "blocked") {
    item.backgroundSince = b.at;
    item.pausedOperationId = task.properties.workStateOperationId || null;
    item.completionRevision = task.properties._completionRevision || null;
    if (b.remindMinutes != null) {
      item.dueAt = new Date(M.instant(b.at) + b.remindMinutes * 60000).toISOString();
      item.generation = b.sourceEventId;
      item.notifiedAt = null;
      if(b.attentionMode==='snooze')item.snoozedUntil=item.dueAt;
    }
  } else delete item.backgroundSince;
  if(b.attentionMode==='needs-you'){
    item.dueAt=new Date(Math.min(M.instant(b.at),Date.now())).toISOString();
    item.generation=b.sourceEventId;item.notifiedAt=null;
    item.pausedOperationId=task.properties.workStateOperationId||null;
    item.completionRevision=task.properties._completionRevision||null;
  }
  return item;
}
async function snapshot(q, owner, blockDB, now = Date.now()) {
  const data = await load(q, owner);
  const rows = (
    await q.query(
      `SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL
    AND (id=ANY($3::text[]) OR (properties->>'startedAt' IS NOT NULL AND dcc_is_task_row(type,properties)))`,
      [owner.userId, owner.workspaceId, data.order]
    )
  ).rows
    .map(blockDB.parseBlock)
    .filter(blockDB.isTaskRow);
  const keys = rows.flatMap((row) => [row.id, row.properties.local_id].filter(Boolean));
  const sessions = (
    await q.query(
      `SELECT DISTINCT properties->>'blockId' AS task_id FROM blocks
    WHERE user_id=$1 AND workspace_id=$2 AND type='time_entry' AND deleted_at IS NULL
    AND properties->>'blockId'=ANY($3::text[])`,
      [owner.userId, owner.workspaceId, keys]
    )
  ).rows;
  const sessionIds = new Set(sessions.map((row) => row.task_id));
  const roots = (
    await q.query(
      `SELECT date::text AS date,properties FROM blocks WHERE user_id=$1 AND workspace_id=$2
    AND type='day_root' AND deleted_at IS NULL AND date=ANY($3::date[])`,
      [owner.userId, owner.workspaceId, rows.map((row) => row.date).filter(Boolean)]
    )
  ).rows;
  const byDate = new Map(roots.map((row) => [String(row.date), row.properties]));
  const reports = (
    await q.query(
      "SELECT task_id,report FROM delegated_work WHERE user_id=$1 AND workspace_id=$2 AND task_id=ANY($3::text[])",
      [owner.userId, owner.workspaceId, rows.map((row) => row.id)]
    )
  ).rows;
  const byTask = new Map();
  for (const row of reports) {
    if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
    byTask.get(row.task_id).push(row.report);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ids = [...new Set([...data.order, ...rows.filter((row) => row.properties.startedAt).map((row) => row.id)])];
  const items = ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const task = byId.get(id),
        item = data.items[id] || { status: "queued", note: "" };
      const delegated = (byTask.get(task.id) || []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const status = classify(
        task,
        { ...item, hasActivity: item.hasActivity || data.history?.[id] },
        {
          dayRoot: byDate.get(String(task.date)),
          session: sessionIds.has(task.id) || sessionIds.has(task.properties.local_id),
          delegated: byTask.has(task.id),
          reports: delegated,
          now
        }
      );
      const valid =
        status !== "completed" &&
        status !== "foreground" &&
        status !== null &&
        item.pausedOperationId === (task.properties.workStateOperationId || null) &&
        (item.completionRevision ?? null) === (task.properties._completionRevision || null);
      const needsReview =
        status !== "completed" && status !== null && (Policy.reviewRequested(delegated) || item.status === "blocked");
      return Policy.presentation({
        ...item,
        task,
        delegated,
        needsReview,
        blocked: item.status === "blocked" || delegated.some((report) => report.phase === "blocked"),
        execution: Policy.execution(delegated, now),
        status,
        onBreak: status === "foreground" && isForegroundBreak(task, item),
        completedAt: status === "completed" ? completionMsOf(task, byDate.get(String(task.date))) : null,
        taskPriority: Priority.read(task.properties),
        dueAt: valid ? item.dueAt || null : null,
        snoozedUntil: valid ? item.snoozedUntil || null : null,
        needsYou: needsReview || !!(valid && item.dueAt && Date.parse(item.dueAt) <= now),
        actualMinutes: task.properties.actualMinutes ?? null
      }, now);
    })
    .filter((item) => item.status !== null);
  const priorityItems = orderPriority(items.filter((item) => item.status === "queued"));
  return {
    items,
    priorityOrder: priorityItems.map((item) => item.task.id),
    order: items.map((item) => item.task.id),
    serverNow: new Date(now).toISOString()
  };
}
function snoozeReminder(item, task, b) {
  item.pausedOperationId = task.properties.workStateOperationId || null;
  item.completionRevision = task.properties._completionRevision || null;
  item.dueAt = new Date(M.instant(b.at) + b.remindMinutes * 60000).toISOString();
  item.snoozedUntil = item.dueAt;
  item.generation = b.sourceEventId;
  item.notifiedAt = null;
}
async function metadata(q, owner, data, b, task, blockDB, now = Date.now()) {
  let claimed = false;
  if (b.action === "queue-reorder") {
    const rows=(await snapshot(q,owner,blockDB)).items;
    const completedIds=new Set(rows.filter(item=>item.status==='completed').map(item=>item.task.id));
    // Accept the former complete-order contract for existing clients as well as
    // active-only orders, which remain bounded while completed history grows.
    const legacyFullOrder=Array.isArray(b.order)&&b.order.some(id=>completedIds.has(id));
    const current=rows.filter(item=>legacyFullOrder||item.status!=='completed').map(item=>item.task.id);
    if (
      !Array.isArray(b.order) ||
      b.order.length !== current.length ||
      new Set(b.order).size !== current.length ||
      b.order.some((id) => !current.includes(id))
    )
      throw M.fail("Reorder must contain every current queue task exactly once", 409);
    data.order = b.order.concat(data.order.filter((id) => !current.includes(id)));
    return { claimed };
  }
  if (b.action === "queue-snooze-all") {
    // Validate the exact previewed set under the coordinator and task row locks.
    // All targets change together, or the surrounding transaction rolls back.
    const current = (await snapshot(q, owner, blockDB, now)).items.filter(item => item.needsYou && item.status !== "foreground");
    const byId = new Map(current.map(item => [item.task.id, item]));
    if (current.length !== b.targets.length || b.targets.some(target => !byId.has(target.taskId) || (byId.get(target.taskId).generation || null) !== (target.generation || null)))
      throw M.fail("Needs You changed. Nothing was snoozed; reopen Snooze all to review the current items", 409);
    for (const target of b.targets) {
      const visible = byId.get(target.taskId);
      snoozeReminder(data.items[target.taskId], visible.task, b);
    }
    return { claimed, snoozedCount: current.length };
  }
  const id = task.id;
  if (b.action === "queue-add") {
    const roots = task.date ? (await q.query(`SELECT properties FROM blocks WHERE user_id=$1 AND workspace_id=$2
      AND date=$3 AND type='day_root' AND deleted_at IS NULL FOR SHARE`, [owner.userId, owner.workspaceId, task.date])).rows : [];
    if (!require("./queue-eligibility").eligible(task, roots[0]?.properties, blockDB.isTaskRow))
      throw M.fail("Choose a titled, unfinished task occurrence", 409);
    const item = ensure(data, id, b.at);
    if (data.history?.[id]) item.hasActivity = true;
  } else {
    if (!Object.hasOwn(data.items, id)) throw M.fail("Task is not in the working queue", 409);
    const item = data.items[id];
    if (b.action === "queue-remove") {
      if (task.properties.startedAt) throw M.fail("Pause foreground work before removing it", 409);
      if (hasPriorActivity(task, item)) {
        data.history = { ...data.history, [id]: true };
      }
      delete data.items[id];
      data.order = data.order.filter((key) => key !== id);
    }
    if (b.action === "queue-return") {
      const visible = (await snapshot(q, owner, blockDB, now)).items.find((row) => row.task.id === id);
      if (!visible || task.properties.startedAt || isBlockDone(task))
        throw M.fail("Pause foreground work before returning an open task to Priority", 409);
      if (visible.execution.state === "running")
        throw M.fail(
          "The worker still reports running. Stop it and obtain a fresh report first; this action does not stop remote work.",
          409
        );
      if (visible.needsYou || visible.needsReview || visible.snoozed)
        throw M.fail("Resolve the review request or due check-back before returning to Priority", 409);
      // Retain membership, relative order, context, history and any future manual
      // check-back. This is not removal/recreation and never touches task timing.
      for (const key of ["breakStartedAt", "breakOperationId", "breakCompletionRevision"]) delete item[key];
      item.status = "queued";
      item.changedAt = b.at;
      item.returnedToPriorityAt = b.at;
    }
    if (b.action === "queue-priority") {
      if (classify(task, item) === null || isBlockDone(task)) throw M.fail("Choose an open task", 409);
      const updated = await blockDB.updateBlock(id, { taskPriority: b.taskPriority }, q);
      return { claimed, task: updated };
    }
    if (b.action === "queue-note") item.note = b.note;
    if (b.action === "queue-unblock") setStatus(data, task, "queued", b);
    if (["queue-snooze", "queue-claim", "queue-dismiss"].includes(b.action)) {
      const visible = (await snapshot(q, owner, blockDB, now)).items.find((row) => row.task.id === id);
      if (
        !visible ||
        isBlockDone(task) ||
        task.properties.startedAt ||
        (item.generation || null) !== (b.generation || null) ||
        (b.action !== "queue-snooze" && !visible.dueAt)
      )
        throw M.fail("This check-back is no longer current", 409);
      if (b.action === "queue-dismiss") clearReminder(item);
      if (b.action === "queue-snooze") {
        // Defer attention only: preserve the blocked/review reason and all task timing.
        snoozeReminder(item, task, b);
      }
      if (b.action === "queue-claim" && Date.parse(item.dueAt) <= now && !item.notifiedAt) {
        item.notifiedAt = new Date(now).toISOString();
        claimed = true;
      }
    }
  }
  return { claimed };
}
module.exports = { load, reconcile, save, ensure, setStatus, snapshot, metadata, MAX_ITEMS };
