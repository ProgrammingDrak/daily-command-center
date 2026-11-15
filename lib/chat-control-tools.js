const object = { type: "object", additionalProperties: true };
function tool(name, description, properties, required = ["action"]) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true }
  };
}
const common = {
  action: { type: "string" },
  id: { type: "string" },
  expectedVersion: { type: "string", description: "Exact version from the latest read; required for edits." },
  sourceEventId: {
    type: "string",
    description: "Stable identity for this exact user instruction. Reuse identical arguments on retry."
  },
  input: object,
  offset: { type: "integer", minimum: 0 }
};
const tools = [
  tool(
    "dcc_connection_status",
    "Verify this DCC connection and report its actual account, workspace and granted permissions. Does not modify tasks.",
    {},
    []
  ),
  tool(
    "dcc_tasks",
    "Task management. Read before edits. list/get/create/update/schedule/complete/reopen/restore. list supports status open/done/all and paginates. schedule uses date null to unschedule; supply start HH:MM or null. Use bulk cleanup for deletion. Act on clear user instructions; never infer completion from elapsed time.",
    {
      ...common,
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "schedule", "complete", "reopen", "restore"]
      },
      query: { type: "string" },
      status: { type: "string", enum: ["open", "done", "all"] }
    }
  ),
  tool(
    "dcc_repeats",
    "Read or manage recurring definitions. Actions list/get/create/update/pause/resume/skip. Read the definition version before editing. input uses DCC repeat properties including title, repeatType and scheduleRule. For deletion use dcc_bulk_cleanup, which stops generation and removes only open occurrences including recurring workouts.",
    { ...common, action: { type: "string", enum: ["list", "get", "create", "update", "pause", "resume", "skip"] } }
  ),
  tool(
    "dcc_organization",
    "Manage projects, categories and saved views. list returns versions; create/update/delete require kind project/category/view. Deletion archives projects and categories. preview_import parses task text without creating tasks.",
    {
      ...common,
      kind: { type: "string", enum: ["project", "category", "view"] },
      action: { type: "string", enum: ["list", "create", "update", "delete", "preview_import", "import"] }
    }
  ),
  tool(
    "dcc_bulk_cleanup",
    "Recoverable account-scoped cleanup. prepare with exact ids or allRepeats:true returns the affected items and persistent jobId. run retires definitions before removing up to 25 open occurrences per call. Repeat run until completed; inspect conflicts. status paginates. undo restores in bounded chunks, definitions last. A clear user deletion instruction is sufficient; ask only if selection is ambiguous. Preserve completed history.",
    {
      action: { type: "string", enum: ["prepare", "run", "status", "undo"] },
      sourceEventId: common.sourceEventId,
      ids: { type: "array", items: { type: "string" }, maxItems: 1000 },
      allRepeats: { type: "boolean" },
      jobId: { type: "string" },
      offset: common.offset
    }
  ),
  tool(
    "dcc_files",
    "Manage private task attachments. list/download require read access; upload/remove/restore require full control. Upload retries use the same UUID id, filename, mime and base64 bytes; maximum 10MB. Returned file data is private to this DCC account.",
    {
      action: { type: "string", enum: ["list", "download", "upload", "remove", "restore"] },
      taskId: { type: "string" },
      id: { type: "string" },
      filename: { type: "string" },
      mime: { type: "string" },
      base64: { type: "string" }
    },
    ["action", "taskId"]
  ),
  tool(
    "dcc_time_records",
    "Read recorded task time entries with pagination. Corrections use dcc_correct_time with the Time records full-control permission.",
    { offset: common.offset },
    []
  )
];
tools[0].annotations = { readOnlyHint: true };
tools.at(-1).annotations = { readOnlyHint: true };
const categoryFor = {
  dcc_tasks: "tasks",
  dcc_repeats: "repeats",
  dcc_organization: "organization",
  dcc_bulk_cleanup: "tasks",
  dcc_files: "files",
  dcc_time_records: "time"
};
module.exports = { tools, categoryFor };
