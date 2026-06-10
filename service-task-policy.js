const ALLOWED_TASK_KINDS = new Set([
  "task",
  "sweep_suite_task",
  "chat_action",
  "meeting_action",
  "backlog",
]);

const ALLOWED_STATUSES = new Set([
  "open",
  "in_progress",
  "blocked",
  "done",
  "deferred",
]);

const ALLOWED_PROPERTY_FIELDS = new Set([
  "action_items",
  "blockedReason",
  "category",
  "completed",
  "completedAt",
  "completedBy",
  "completionNotes",
  "createdAt",
  "created_by",
  "date",
  "description",
  "detail",
  "done",
  "doneAt",
  "duration",
  "end",
  "estimated_minutes",
  "evidence",
  "id",
  "idempotency_key",
  "kind",
  "local_id",
  "metadata",
  "notes",
  "parent_task_id",
  "parentTaskId",
  "point_multiplier",
  "point_tier",
  "priority",
  "source",
  "source_id",
  "source_ref",
  "start",
  "status",
  "subtasks",
  "sweep_source_item_id",
  "tags",
  "task_id",
  "text",
  "title",
  "type",
  "updatedAt",
]);

const ALLOWED_PATCH_FIELDS = new Set([
  "_clientId",
  "date",
  "idempotency_key",
  "parent_id",
  "properties",
  "provenance",
  "sort_order",
]);

function parseProperties(properties) {
  if (!properties) return {};
  if (typeof properties === "string") return JSON.parse(properties);
  if (typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Block properties must be an object");
  }
  return { ...properties };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeServiceProperties(properties) {
  const props = parseProperties(properties);
  if (isPlainObject(props.metadata)) {
    if (!props.idempotency_key && props.metadata.idempotency_key) {
      props.idempotency_key = props.metadata.idempotency_key;
    }
    if (!props.created_by && props.metadata.created_by) {
      props.created_by = props.metadata.created_by;
    }
  }
  return props;
}

function getRequestIdempotency(input, props) {
  return input?.idempotency_key || input?.idempotencyKey || props.idempotency_key || props.metadata?.idempotency_key;
}

function getRequestProvenance(input, props) {
  const provenance = isPlainObject(input?.provenance) ? input.provenance : {};
  return {
    source: props.source || provenance.source,
    source_id: props.source_id || provenance.source_id,
    source_ref: props.source_ref || provenance.source_ref,
    created_by: props.created_by || props.metadata?.created_by || provenance.created_by,
  };
}

function assertServiceProvenance(input, props) {
  if (!getRequestIdempotency(input, props)) {
    throw new Error("Trusted DCC task writes require an idempotency_key");
  }
  const provenance = getRequestProvenance(input, props);
  if (!provenance.source || !(provenance.source_id || provenance.source_ref || provenance.created_by)) {
    throw new Error("Trusted DCC task writes require mutation provenance");
  }
}

function assertAllowedTaskProperties(props, existingProps = null) {
  const kind = props.kind;
  if (!kind || !ALLOWED_TASK_KINDS.has(kind)) {
    throw new Error(`Trusted DCC task writes require allowed kind: ${[...ALLOWED_TASK_KINDS].join(", ")}`);
  }
  if (props.status && !ALLOWED_STATUSES.has(props.status)) {
    throw new Error(`Trusted DCC task writes cannot set unsupported status: ${props.status}`);
  }

  const keys = new Set([
    ...Object.keys(existingProps || {}),
    ...Object.keys(props || {}),
  ]);
  for (const key of keys) {
    if (ALLOWED_PROPERTY_FIELDS.has(key)) continue;
    if (!existingProps || !sameValue(existingProps[key], props[key])) {
      throw new Error(`Trusted DCC task writes cannot mutate property: ${key}`);
    }
  }
}

function validateServiceCreateItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Block create payload must be an object");
  }
  const type = item.type || "block";
  if (type !== "block") {
    throw new Error("Trusted DCC task writes may only create block records");
  }
  const props = normalizeServiceProperties(item.properties);
  assertServiceProvenance(item, props);
  assertAllowedTaskProperties(props);
  return {
    ...item,
    type,
    properties: props,
  };
}

function validateServicePatchBody(existingBlock, body) {
  if (!existingBlock) throw new Error("Block not found");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Block patch payload must be an object");
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_PATCH_FIELDS.has(key)) {
      throw new Error(`Trusted DCC task writes cannot mutate block field: ${key}`);
    }
  }
  if (!("properties" in body)) {
    throw new Error("Trusted DCC task patches require properties");
  }
  const existingProps = normalizeServiceProperties(existingBlock.properties);
  const props = normalizeServiceProperties(body.properties);
  assertServiceProvenance(body, props);
  assertAllowedTaskProperties(props, existingProps);
  return {
    ...body,
    properties: props,
  };
}

module.exports = {
  ALLOWED_PROPERTY_FIELDS,
  ALLOWED_STATUSES,
  ALLOWED_TASK_KINDS,
  validateServiceCreateItem,
  validateServicePatchBody,
};
