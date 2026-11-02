// Explicit user decisions, applied inside the account coordinator transaction.
// No NLP, time inference, background notification or generic task-property writer.
const M = require("./conversation-model");
const { isBlockDone } = require("./task-timing");
const choices = ["done", "still_working", "drop", "step_done", "undo"];
const editable = [
  "title",
  "completionOutcome",
  "originalGoal",
  "nextStepId",
  "previousStepId",
  "remainingWork",
  "goalId",
  "goalComplete",
  "iteration",
  "status",
  "completionReportedAt",
  "completionTimeKnown",
  "completionReview",
  "_deleteUndoToken"
];
const version = (row) =>
  M.digest({
    id: row.id,
    properties: row.properties,
    date: row.date,
    parent_id: row.parent_id,
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    updated_at: new Date(row.updated_at).toISOString()
  });
async function completionRoots(q, owner, rows) {
  const roots = await q.query(
    "SELECT date::text AS date, properties FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND type='day_root' AND deleted_at IS NULL AND date=ANY($3::date[])",
    [owner.userId, owner.workspaceId, [...new Set(rows.map((row) => row.date).filter(Boolean))]]
  );
  return new Map(roots.rows.map((row) => [row.date, row.properties]));
}
async function hierarchySignature(db, q, id, workspaceId) {
  const rows = await db.getSubtree([id], workspaceId, q);
  return M.digest(
    rows
      .filter((row) => row.id !== id)
      .map((row) => [row.id, version(row)])
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}
function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw M.fail("Use a calendar date YYYY-MM-DD");
  return value;
}
function validate(b) {
  const r = b.reconciliation;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).some(
      (k) =>
        ![
          "choice",
          "expectedTaskVersion",
          "outcome",
          "completedTitle",
          "nextStep",
          "reviewDate",
          "undoEventId",
          "completedAt"
        ].includes(k)
    )
  )
    throw M.fail("Invalid reconciliation");
  if (!choices.includes(r.choice))
    throw M.fail("Choose Done, Still working, Drop it, progress plus a next iteration, or Undo");
  M.text(r.expectedTaskVersion, "expectedTaskVersion");
  if (r.reviewDate !== undefined) date(r.reviewDate);
  if (r.completedAt !== undefined && M.instant(r.completedAt) > M.instant(b.at))
    throw M.fail("Completion cannot be after its report");
  if (["done", "step_done"].includes(r.choice)) M.text(r.outcome, "completed outcome", 2000);
  if (r.choice === "step_done") {
    M.text(r.completedTitle, "completed step title", 200);
    const n = r.nextStep;
    if (!n || Object.keys(n).some((k) => !["title", "summary", "taskId", "expectedTaskVersion"].includes(k)))
      throw M.fail("Choose a specific next action");
    M.text(n.summary, "remaining work summary", 2000);
    if (n.taskId) {
      M.text(n.taskId, "successor taskId");
      M.text(n.expectedTaskVersion, "successor version");
      if (n.title) throw M.fail("Choose an existing successor or a new title");
    } else M.text(n.title, "next action title", 200);
  } else if (r.nextStep !== undefined || r.completedTitle !== undefined)
    throw M.fail("Next step requires a completed iteration");
  if (r.choice === "undo") M.text(r.undoEventId, "operation to undo");
  else if (r.undoEventId !== undefined) throw M.fail("Only undo may reference an earlier operation");
}
async function readRow(q, db, id, owner) {
  const rows = (
    await q.query("SELECT * FROM blocks WHERE id=$1 AND user_id=$2 AND workspace_id=$3", [
      id,
      owner.userId,
      owner.workspaceId
    ])
  ).rows.map(db.parseBlock);
  if (rows.length !== 1 || !db.isTaskRow(rows[0])) throw M.fail("Select a canonical task occurrence ID", 404);
  return rows[0];
}
function assertVersion(row, expected) {
  if (version(row) !== expected) throw M.fail("Task changed. Read it again and review the choice.", 409);
}
async function apply(q, owner, queue, b, ctx) {
  const db = ctx.blockDB,
    r = b.reconciliation,
    mutationId = "reconcile:" + M.digest(b.sourceEventId).slice(0, 40);
  const original = await readRow(q, db, b.taskId, owner);
  assertVersion(original, r.expectedTaskVersion);
  const originalTree = await db.getSubtree([original.id], owner.workspaceId, q);
  const roots = await completionRoots(q, owner, [original, ...originalTree]);
  const done = (row) => isBlockDone(row, roots.get(row.date));
  const beforeRows = [structuredClone(original)],
    changed = new Set([original.id]),
    createdIds = [],
    transitions = [];
  const update = async (row, patch) =>
    db.updateBlock(row.id, { properties: { ...row.properties, ...patch }, [M.RECONCILIATION_WRITE]: true }, q);
  const reload = (id) => readRow(q, db, id, owner);
  const complete = async (row) => {
    const result = await db.setTaskCompletion({
      taskRef: row.id,
      completed: true,
      completedAt: r.completedAt || b.at,
      mutationId,
      expectedRevision: row.properties._completionRevision || null,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      transactionClient: q,
      includeDescendants: false
    });
    transitions.push(...(result.responsibilityTransitions || []));
    // A receipt time is not an exact completion time; no timer/effort fields are written.
    await update(await reload(row.id), {
      completionOutcome: r.outcome,
      completionReportedAt: b.at,
      completionTimeKnown: !!r.completedAt,
      ...(r.choice === "done" ? { goalComplete: true } : {})
    });
    return reload(row.id);
  };
  if (r.choice === "undo") {
    const event = (
      await q.query(
        "SELECT result FROM conversation_events WHERE user_id=$1 AND workspace_id=$2 AND source_event_id=$3",
        [owner.userId, owner.workspaceId, r.undoEventId]
      )
    ).rows[0]?.result;
    const prior = event?.reconciliation;
    if (!prior || prior.taskId !== original.id || prior.choice === "undo")
      throw M.fail("Choose a saved reconciliation operation to undo", 409);
    for (const expected of prior.afterRows) {
      const current = await reload(expected.id);
      assertVersion(current, version(expected));
      if (!current.deleted_at) {
        const expectedHierarchy = prior.hierarchyVersions?.[current.id];
        if (expectedHierarchy) {
          if ((await hierarchySignature(db, q, current.id, owner.workspaceId)) !== expectedHierarchy)
            throw M.fail("Task hierarchy changed. Review before undoing.", 409);
        } else if (
          (await db.getSubtree([current.id], owner.workspaceId, q)).some(
            (row) => row.id !== current.id && !(prior.createdIds || []).includes(row.id)
          )
        ) {
          throw M.fail("Task hierarchy changed. Review before undoing.", 409);
        }
      }
      if (current.properties.responsibilityId && done(current)) {
        const others = await q.query(
          "SELECT id FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND properties->>'responsibilityId'=$3 AND id<>$4 AND COALESCE(properties->>'done','false')<>'true' AND COALESCE(properties->>'status','open')<>'done'",
          [owner.userId, owner.workspaceId, current.properties.responsibilityId, current.id]
        );
        if (others.rows.length) throw M.fail("Another recurring occurrence exists; review before undoing", 409);
      }
      beforeRows.push(...(current.id === original.id ? [] : [structuredClone(current)]));
      changed.add(current.id);
    }
    for (const previous of prior.beforeRows) {
      let current = await reload(previous.id);
      if (current.deleted_at) current = await db.undeleteBlock(current.id, q, mutationFor(r.undoEventId));
      const previousDone = prior.beforeDone?.[previous.id] ?? isBlockDone(previous);
      if (done(current) !== previousDone) {
        const result = await db.setTaskCompletion({
          taskRef: current.id,
          completed: previousDone,
          mutationId,
          expectedRevision: current.properties._completionRevision || null,
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          transactionClient: q,
          includeDescendants: false
        });
        transitions.push(...(result.responsibilityTransitions || []));
        current = await reload(current.id);
      }
      const props = { ...current.properties };
      for (const key of editable) {
        if (Object.hasOwn(previous.properties, key)) props[key] = previous.properties[key];
        else delete props[key];
      }
      await db.updateBlock(current.id, { properties: props, [M.RECONCILIATION_WRITE]: true }, q);
    }
    for (const id of prior.createdIds) await db.deleteBlock(id, q, mutationId);
  } else {
    if (original.deleted_at) throw M.fail("This task was dropped; undo that operation first", 409);
    if (original.properties.kind === "responsibility_item")
      throw M.fail("Select one existing recurring occurrence, never the whole series", 409);
    if (["meeting", "oneone", "break", "ooo", "guided", "workout", "meal"].includes(original.properties.type))
      throw M.fail("Use this activity’s existing outcome flow", 409);
    const queueEntry = (await require("./working-queue").snapshot(q, owner, db, (ctx.now || Date.now)())).items.find(
      (item) => item.task.id === original.id
    );
    if (r.choice !== "still_working" && (original.properties.startedAt || queueEntry?.execution.state === "running"))
      throw M.fail(
        "Pause active work with its explicit time before reconciling; elapsed time is not completion evidence",
        409
      );
    const subtree = originalTree.filter(db.isTaskRow);
    // Parent completion cascades in the canonical writer. Refuse it here rather
    // than accidentally completing descendants, including children on another day.
    if (
      r.choice !== "still_working" &&
      subtree.some((row) => row.id !== original.id && (r.choice !== "done" || !done(row)))
    )
      throw M.fail("Select the concrete completed subtask; this task contains other scope", 409);
    if (done(original) && r.choice !== "still_working")
      throw M.fail("Already completed. Read the existing outcome or undo it.", 409);
    const dependencyRelations = (
      await q.query(
        "SELECT id FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL AND properties->>'kind'='delegated_item' AND properties->>'blockerType'='task' AND properties->>'blockerBlockId'=$2",
        [owner.workspaceId, original.id]
      )
    ).rows;
    if (
      r.choice === "drop" &&
      (dependencyRelations.length ||
        original.properties.dependencyWaitingItemId ||
        original.properties.dependencyWaitingItemIds?.length)
    )
      throw M.fail("Review this task's Waiting dependencies before dropping it", 409);
    if (r.choice === "still_working") {
      await update(original, {
        completionReview: {
          date: r.reviewDate || localDate(b.at, ctx.APP_TIME_ZONE),
          choice: r.choice,
          sourceEventId: b.sourceEventId
        }
      });
    } else if (r.choice === "drop") {
      // Canonical reversible tombstone, this leaf occurrence only. Never the definition.
      await db.deleteBlock(original.id, q, mutationId);
    } else if (r.choice === "done") {
      await complete(original);
    } else {
      const recurring = !!(
        original.properties.responsibilityId ||
        original.properties.repeatSeriesId ||
        original.properties.recurringId
      );
      // A prerequisite or blocked goal must not be released merely because an
      // iteration made progress. Keep the goal open just like a recurring cycle.
      const keepGoalOpen =
        recurring ||
        dependencyRelations.length > 0 ||
        !!original.properties.dependencyWaitingItemId ||
        !!original.properties.dependencyWaitingItemIds?.length;
      let phase = original;
      if (keepGoalOpen) {
        // A partial recurring cycle is still open: record a completed child phase.
        phase = await db.createBlock(
          {
            id: "phase-" + M.digest(owner.userId + ":" + b.sourceEventId).slice(0, 40),
            type: "block",
            date: original.date,
            parent_id: original.id,
            user_id: owner.userId,
            workspace_id: owner.workspaceId,
            properties: {
              type: "task",
              title: r.completedTitle,
              originalGoal: original.properties.title,
              goalId: original.properties.goalId || original.id,
              goalComplete: false,
              iteration: original.properties.iteration || 1,
              publicVisibility: original.properties.publicVisibility || "private",
              source: "conversation-reconciliation",
              subtaskOf: original.id
            }
          },
          q
        );
        createdIds.push(phase.id);
        changed.add(phase.id);
      } else {
        await update(original, {
          title: r.completedTitle,
          originalGoal: original.properties.originalGoal || original.properties.title,
          goalId: original.properties.goalId || original.id,
          goalComplete: false,
          iteration: original.properties.iteration || 1
        });
        phase = await reload(original.id);
      }
      let successor;
      if (r.nextStep.taskId) {
        successor = await reload(r.nextStep.taskId);
        for (const [date, props] of await completionRoots(q, owner, [successor])) roots.set(date, props);
        assertVersion(successor, r.nextStep.expectedTaskVersion);
        if (
          successor.id === original.id ||
          successor.deleted_at ||
          done(successor) ||
          (successor.properties.previousStepId && successor.properties.previousStepId !== phase.id)
        )
          throw M.fail("Choose an unfinished successor not linked to another phase", 409);
        if ((successor.parent_id || null) !== (keepGoalOpen ? original.id : original.parent_id || null))
          throw M.fail("Successor must preserve the same parent goal", 409);
        beforeRows.push(structuredClone(successor));
      } else {
        successor = await db.createBlock(
          {
            id: "next-" + M.digest(owner.userId + ":" + b.sourceEventId).slice(0, 40),
            type: "block",
            date:
              original.parent_id || original.properties.subtaskOf || original.properties.wrapId || keepGoalOpen
                ? original.date
                : null,
            parent_id: keepGoalOpen ? original.id : original.parent_id,
            user_id: owner.userId,
            workspace_id: owner.workspaceId,
            properties: {
              type: "task",
              title: r.nextStep.title,
              detail: r.nextStep.summary,
              publicVisibility: original.properties.publicVisibility || "private",
              source: "conversation-reconciliation",
              ...(keepGoalOpen
                ? { subtaskOf: original.id }
                : Object.fromEntries(
                    ["subtaskOf", "wrapId", "rel", "projectId", "project_id", "taskPriority"]
                      .filter((key) => Object.hasOwn(original.properties, key))
                      .map((key) => [key, original.properties[key]])
                  )),
              originalGoal: original.properties.originalGoal || original.properties.title,
              goalId: original.properties.goalId || original.id,
              goalComplete: false,
              iteration: (original.properties.iteration || 1) + 1
            }
          },
          q
        );
        createdIds.push(successor.id);
      }
      changed.add(successor.id);
      await update(successor, {
        previousStepId: phase.id,
        remainingWork: r.nextStep.summary,
        goalId: original.properties.goalId || original.id,
        goalComplete: false
      });
      await update(await reload(phase.id), { nextStepId: successor.id });
      await complete(await reload(phase.id));
    }
  }
  const afterRows = [];
  for (const id of changed) afterRows.push(await reload(id));
  const beforeDone = Object.fromEntries(beforeRows.map((row) => [row.id, done(row)]));
  for (const [date, props] of await completionRoots(q, owner, afterRows)) roots.set(date, props);
  for (const row of afterRows) {
    if (row.deleted_at) {
      delete queue.items[row.id];
      queue.order = queue.order.filter((id) => id !== row.id);
    } else if (done(row)) require("./working-queue").setStatus(queue, row, "completed", b);
    else if (queue.items[row.id]?.status === "completed") require("./working-queue").setStatus(queue, row, "paused", b);
  }
  const hierarchyVersions = {};
  for (const row of afterRows) hierarchyVersions[row.id] = await hierarchySignature(db, q, row.id, owner.workspaceId);
  return {
    task: afterRows.find((row) => row.id === original.id),
    touchedTaskIds: [...changed],
    responsibilityTransitions: transitions,
    reconciliation: {
      versions: Object.fromEntries(afterRows.map((row) => [row.id, version(row)])),
      taskId: original.id,
      choice: r.choice,
      beforeRows,
      beforeDone,
      afterRows,
      hierarchyVersions,
      createdIds,
      undoEventId: b.sourceEventId,
      broaderGoalComplete: r.choice === "step_done" ? false : undefined
    },
    saveStatus: "pending_write"
  };
}
function mutationFor(id) {
  return "reconcile:" + M.digest(id).slice(0, 40);
}
function localDate(at, zone = "America/New_York") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(at));
}
async function verify(result, owner, ctx) {
  try {
    const current = await Promise.all(
      result.reconciliation.afterRows.map((row) => readRow(ctx.pool, ctx.blockDB, row.id, owner))
    );
    const matches = current.every(
      (row) => version(row) === version(result.reconciliation.afterRows.find((expected) => expected.id === row.id))
    );
    return { ...result, saveStatus: matches ? "verified_saved" : "stale_conflict", verifiedTasks: current };
  } catch {
    return { ...result, saveStatus: "save_uncertain" };
  }
}
async function review(q, owner, ctx, input = {}) {
  const day = date(input.date || localDate(new Date((ctx.now || Date.now)()).toISOString(), ctx.APP_TIME_ZONE));
  const candidates = [];
  let offset = 0,
    exhausted = false;
  // Page through history until six eligible candidates or exhaustion. Completed
  // history cannot permanently hide older/unscheduled work behind a fixed cap.
  while (candidates.length < 6 && !exhausted) {
    const rows = (
      await q.query(
        `SELECT * FROM blocks WHERE user_id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND dcc_is_task_row(type,properties)
      AND (date IS NULL OR date <= $3::date)
      AND COALESCE(properties->>'status','') NOT IN ('done','archived','deleted','cancelled','canceled','skipped')
      AND properties->'done' IS DISTINCT FROM 'true'::jsonb AND properties->'completed' IS DISTINCT FROM 'true'::jsonb
      AND NULLIF(properties->>'completedAt','') IS NULL AND NULLIF(properties->>'doneAt','') IS NULL
      AND COALESCE(properties->>'type','') NOT IN ('meeting','oneone','break','ooo','guided','workout','meal')
      AND COALESCE(properties->>'kind','')<>'responsibility_item'
      AND properties->'completionReview'->>'date' IS DISTINCT FROM $3::text
      AND NULLIF(properties->>'startedAt','') IS NULL
      ORDER BY date DESC NULLS LAST,id LIMIT 100 OFFSET $4`,
        [owner.userId, owner.workspaceId, day, offset]
      )
    ).rows.map(ctx.blockDB.parseBlock);
    offset += rows.length;
    exhausted = rows.length < 100;
    if (!rows.length) break;
    // One canonical recursive query per page, retaining the originating root.
    const tree = await ctx.blockDB.getSubtree(
      rows.map((row) => row.id),
      owner.workspaceId,
      q,
      { byRoot: true }
    );
    const roots = await completionRoots(q, owner, [...rows, ...tree]);
    const done = (row) => isBlockDone(row, roots.get(row.date));
    const descendants = new Map(rows.map((row) => [row.id, []]));
    for (const row of tree)
      if (row.path?.[0] !== row.id && ctx.blockDB.isTaskRow(row)) descendants.get(row.path[0])?.push(row);
    for (const row of rows) {
      const children = descendants.get(row.id) || [];
      if (done(row) || children.some((child) => !done(child))) continue;
      candidates.push({
        taskId: row.id,
        title: row.properties.title,
        date: row.date,
        expectedTaskVersion: version(row),
        definitionId: row.properties.responsibilityId || null,
        reason: "Unfinished task; confirm its outcome. Elapsed time is not evidence",
        choices: children.length ? ["done", "still_working"] : ["done", "still_working", "drop", "step_done"],
        dropConsequence: "Drop this task occurrence, with Undo. Its recurring definition and recorded time remain."
      });
      if (candidates.length === 6) break;
    }
  }
  return {
    date: day,
    timeZone: ctx.APP_TIME_ZONE || "America/New_York",
    candidates: candidates.slice(0, 5),
    remaining: Math.max(0, candidates.length - 5),
    truncated: candidates.length > 5
  };
}

module.exports = {
  validate,
  apply,
  version,
  verify,
  review,
  choices,
  localDate,
  ownedFields: editable.filter((key) => !["title", "status", "_deleteUndoToken"].includes(key))
};
