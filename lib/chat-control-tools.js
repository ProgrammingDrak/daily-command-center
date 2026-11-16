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
const text = { type: "string" };
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const clock = { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" };
const nullableObject = (properties) => ({ type: ["object", "null"], properties, additionalProperties: false });
const itineraryRead = {
  name: "dcc_itinerary",
  description:
    "Read the DCC itinerary including canonical IDs, versions and planned instants. Connected-calendar entries require calendar read access. Use the destination's IANA viewingZone and an inclusive date range up to 63 days. Does not record activity.",
  inputSchema: {
    type: "object",
    properties: { date, endDate: date, viewingZone: text, offset: common.offset },
    required: ["date"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
};
const itineraryWrite = tool(
  "dcc_itinerary_write",
  "Create a scheduled activity, update its title, notes, location or travel, or schedule an existing task by canonical ID. Create and schedule require date, start, end and IANA timeZone (e.g. Asia/Tokyo). Read the itinerary and supply expectedVersion for changes. Set moveFixed or allowOverlapWith only for explicitly authorized moves or intentional overlaps. Reuse sourceEventId and identical arguments on retry. Does not start or complete work. Use dcc_files to attach authorized bytes to the returned ID.",
  {
    action: { enum: ["create", "update", "schedule"] },
    id: common.id,
    expectedVersion: common.expectedVersion,
    sourceEventId: common.sourceEventId,
    allowOverlapWith: { type: "array", items: text, maxItems: 20 },
    moveFixed: { type: "boolean" },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: text,
        detail: text,
        date,
        start: clock,
        end: clock,
        endDate: date,
        timeZone: text,
        startOffset: text,
        endOffset: text,
        location: nullableObject({
          label: text,
          address: text,
          latitude: { type: "number" },
          longitude: { type: "number" },
          mapsUrl: text
        }),
        travel: nullableObject({
          origin: text,
          destination: text,
          method: text,
          serviceNumber: text,
          platformOrGate: text,
          reservation: text,
          confirmationNumber: text,
          durationMinutes: { type: "integer" }
        })
      }
    }
  },
  ["action", "sourceEventId", "input"]
);
itineraryWrite.annotations = { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false };

const attachChatFile = {
  ...tool(
    "dcc_attach_chat_file",
    "Attach one user-selected ChatGPT file to a canonical DCC task or itinerary activity. Supply a stable UUID v4 for this attachment and keep it on retry. Use ChatGPT's file picker to authorize the source. Supports private PDF, PNG, JPEG, WebP, TXT, Markdown and CSV up to 10 MB. The download URL must be supplied by ChatGPT.",
    {
      taskId: text,
      id: text,
      filename: text,
      file: {
        type: "object",
        additionalProperties: false,
        properties: { file_id: text, download_url: text, file_name: text, mime_type: text },
        required: ["file_id", "download_url"]
      }
    },
    ["taskId", "id", "file"]
  ),
  annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  _meta: { "openai/fileParams": ["file"] }
};
const tools = [
  attachChatFile,
  itineraryRead,
  itineraryWrite,
  tool(
    "dcc_connection_status",
    "Verify this DCC connection and report its actual account, workspace and granted permissions. Does not modify tasks.",
    {},
    []
  ),
  tool(
    "dcc_tasks",
    "Task management. Create accepts input title, detail, duration (minutes), priority (High/Medium/Low), date (YYYY-MM-DD), tags, projectId, parentId, location and sourceUrl. Use sourceEventId for every write and exact expectedVersion for edits. Read before edits. list/get/history/create/update/schedule/complete/reopen/restore. list supports status open/done/all and paginates. schedule uses date null to unschedule; supply start HH:MM or null. Use bulk cleanup for deletion. Act on clear user instructions; never infer completion from elapsed time.",
    {
      ...common,
      action: {
        type: "string",
        enum: ["list", "get", "history", "create", "update", "schedule", "complete", "reopen", "restore"]
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
    "Manage private task and itinerary attachments using the canonical task ID. list/download require read access; upload/remove/restore require full control. Upload retries use the same UUID id, filename, mime and base64 bytes; maximum 10MB. Returned file data is private to this DCC account.",
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
tools.find((entry) => entry.name === "dcc_connection_status").annotations = { readOnlyHint: true };
tools.at(-1).annotations = { readOnlyHint: true };
const categoryFor = {
  dcc_itinerary: "itinerary",
  dcc_itinerary_write: "itinerary",
  dcc_tasks: "tasks",
  dcc_repeats: "repeats",
  dcc_organization: "organization",
  dcc_bulk_cleanup: "cleanup",
  dcc_files: "files",
  dcc_attach_chat_file: "files",
  dcc_time_records: "time"
};
module.exports = { tools, categoryFor };
