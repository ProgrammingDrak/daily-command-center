// Add Tasks and queue-add share this policy. Broad task search and retained queue
// classification deliberately keep their wider historical contracts.
const { isBlockDone } = require("./task-timing");
const CLOSED = ["done", "completed", "complete", "cancelled", "canceled", "deleted", "archived", "skipped"];
const NON_ACTION = ["note", "paragraph", "text", "heading", "divider", "image", "file", "bookmark", "code", "quote", "recurring-definition"];
const normalized = value => typeof value === "string" ? value.trim().toLowerCase() : "";
function eligible(task, dayRoot, isTaskRow) {
  const p = task?.properties || {};
  if (!task || task.deleted_at || !isTaskRow(task)) return false;
  if (typeof p.title !== "string" || !p.title.replace(/[\s\u200b\ufeff]/g, "")) return false;
  if ([task.type, p.type, p.kind].some(value => NON_ACTION.includes(normalized(value)))) return false;
  // saveNotes stores child note blocks with html/text and a source-task pointer.
  // Tasks may own notes, but they are not themselves these child note rows.
  if (p._sourceTaskId || (task.parent_id && typeof p.html === "string" && typeof p.text === "string")) return false;
  if (CLOSED.includes(normalized(p.status)) || p.checked === true || isBlockDone(task, dayRoot)) return false;
  return true;
}
const literals = values => values.map(value => "'" + value + "'").join(",");
// Parameter-free SQL generated from the same constants as the write predicate.
// b is the task, day its same-owner/workspace/date day_root. Filtering precedes LIMIT.
function sql() {
  const norm = expression => `lower(btrim(COALESCE(${expression},'')))`;
  const closed = literals(CLOSED), nonAction = literals(NON_ACTION);
  return `b.deleted_at IS NULL AND dcc_is_task_row(b.type,b.properties)
    AND jsonb_typeof(b.properties->'title')='string'
    AND regexp_replace(b.properties->>'title','[[:space:] ​﻿]','','g')<>''
    AND ${norm('b.type')} NOT IN (${nonAction})
    AND ${norm("b.properties->>'type'")} NOT IN (${nonAction})
    AND ${norm("b.properties->>'kind'")} NOT IN (${nonAction})
    AND COALESCE(b.properties->>'_sourceTaskId','')=''
    AND NOT (b.parent_id IS NOT NULL AND COALESCE(jsonb_typeof(b.properties->'html'),'')='string' AND COALESCE(jsonb_typeof(b.properties->'text'),'')='string')
    AND ${norm("b.properties->>'status'")} NOT IN (${closed})
    AND NOT (COALESCE(b.properties->'done','false'::jsonb)='true'::jsonb OR COALESCE(b.properties->'completed','false'::jsonb)='true'::jsonb OR COALESCE(b.properties->'checked','false'::jsonb)='true'::jsonb)
    AND COALESCE(b.properties->>'completedAt','')='' AND COALESCE(b.properties->>'doneAt','')=''
    AND NOT EXISTS (SELECT 1 FROM blocks day WHERE day.user_id=b.user_id AND day.workspace_id=b.workspace_id
      AND day.date=b.date AND day.type='day_root' AND day.deleted_at IS NULL AND (
        COALESCE(day.properties->'_done'->'ids','[]'::jsonb) ? b.id OR
        COALESCE(day.properties->'_done'->'at','{}'::jsonb) ? b.id OR
        COALESCE(day.properties->'_done'->'ids','[]'::jsonb) ? COALESCE(b.properties->>'local_id','') OR
        COALESCE(day.properties->'_done'->'at','{}'::jsonb) ? COALESCE(b.properties->>'local_id','')))`;
}
module.exports = { eligible, sql };
