const nodeCrypto = require("node:crypto");

const ORGANIZATION_KINDS = new Set(["project", "task_facet", "task_view"]);
const FACET_CARDINALITIES = new Set(["single", "multi"]);
const FACET_SCOPES = new Set(["workspace", "project"]);

const BUILTIN_VIEWS = Object.freeze([
  { id: "all-open", name: "All open", system: true, query: { scope: "open" }, sort: { key: "project", dir: "asc" } },
  { id: "unscheduled", name: "Unscheduled", system: true, query: { scope: "open", scheduled: "no" }, sort: { key: "projectOrder", dir: "asc" } },
  { id: "scheduled", name: "Scheduled", system: true, query: { scope: "open", scheduled: "yes" }, sort: { key: "date", dir: "asc" } },
  { id: "solo", name: "Solo", system: true, query: { scope: "open", projectId: "solo" }, sort: { key: "title", dir: "asc" } },
  { id: "waiting", name: "Waiting", system: true, query: { scope: "open", readiness: "blocked" }, sort: { key: "title", dir: "asc" } },
  { id: "completed", name: "Completed", system: true, query: { scope: "completed" }, sort: { key: "completedAt", dir: "desc" } },
]);

function cleanText(value, max = 300) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ").slice(0, max);
}

function slugify(value) {
  return cleanText(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function clientError(message, statusCode = 400, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function isDone(block) {
  const props = (block && block.properties) || {};
  return props.status === "done" || props.done === true || !!props.completedAt;
}

function isLibraryTask(block, blockDB) {
  if (!block || block.deleted_at || ORGANIZATION_KINDS.has((block.properties || {}).kind)) return false;
  if (blockDB && typeof blockDB.isTaskRow === "function" && !blockDB.isTaskRow(block)) return false;
  const props = block.properties || {};
  const hasTitle = cleanText(props.title || props.text, 300);
  if (!hasTitle) return false;
  if (block.type !== "block") return ["added_task", "schedule_item", "pending_task", "trivial_task", "action_item", "subtask"].includes(block.type);
  return !!(props.local_id || ["task", "backlog", "shell", "meeting", "responsibility_task", "placeholder_task"].includes(props.kind)
    || ["task", "shell", "meeting", "oneone"].includes(props.type));
}

function normalizeValue(input, index, cryptoImpl = nodeCrypto) {
  const name = cleanText(typeof input === "string" ? input : input && input.name, 80);
  if (!name) return null;
  return {
    id: cleanText(input && input.id, 100) || `fv-${cryptoImpl.randomUUID()}`,
    name,
    color: cleanText(input && input.color, 24) || null,
    order: Number.isFinite(Number(input && input.order)) ? Number(input.order) : (index + 1) * 1000,
    archived: !!(input && input.archived),
  };
}

function normalizeFacet(input, current, cryptoImpl = nodeCrypto) {
  input = input || {};
  current = current || {};
  const name = cleanText(input.name !== undefined ? input.name : current.name, 80);
  if (!name) throw clientError("Category name is required");
  const scope = FACET_SCOPES.has(input.scope) ? input.scope : (current.scope || "workspace");
  const cardinality = FACET_CARDINALITIES.has(input.cardinality) ? input.cardinality : (current.cardinality || "single");
  const projectId = scope === "project" ? cleanText(input.projectId !== undefined ? input.projectId : current.projectId, 100) : null;
  if (scope === "project" && !projectId) throw clientError("Project-scoped categories require a project");
  const currentValues = Array.isArray(current.values) ? current.values : [];
  const sourceValues = Array.isArray(input.values) ? input.values : currentValues;
  const usedIds = new Set();
  const usedNames = new Set();
  const values = sourceValues.map((value, index) => normalizeValue(value, index, cryptoImpl)).filter(value => {
    const normalizedName = value && value.name.toLowerCase();
    if (!value || usedIds.has(value.id) || usedNames.has(normalizedName)) return false;
    usedIds.add(value.id);
    usedNames.add(normalizedName);
    return true;
  });
  // A removed value is archived instead of deleted. Existing task assignments
  // therefore remain readable and can be restored without rewriting every task.
  if (Array.isArray(input.values)) {
    for (const oldValue of currentValues) {
      if (usedIds.has(oldValue.id)) continue;
      values.push({ ...oldValue, archived: true });
      usedIds.add(oldValue.id);
    }
  }
  return {
    ...current,
    kind: "task_facet",
    name,
    slug: slugify(name),
    scope,
    projectId,
    cardinality,
    values,
    archived: input.archived !== undefined ? !!input.archived : !!current.archived,
  };
}

function normalizeView(input, current) {
  input = input || {};
  current = current || {};
  const name = cleanText(input.name !== undefined ? input.name : current.name, 80);
  if (!name) throw clientError("View name is required");
  const filters = Array.isArray(input.filters) ? input.filters : (Array.isArray(current.filters) ? current.filters : []);
  const columns = Array.isArray(input.columns) ? input.columns : (Array.isArray(current.columns) ? current.columns : []);
  const sort = input.sort && typeof input.sort === "object" ? input.sort : (current.sort || { key: "title", dir: "asc" });
  return {
    ...current,
    kind: "task_view",
    name,
    filters,
    groupBy: cleanText(input.groupBy !== undefined ? input.groupBy : current.groupBy, 120) || "none",
    sort: { key: cleanText(sort.key, 120) || "title", dir: sort.dir === "desc" ? "desc" : "asc" },
    columns,
    query: cleanText(input.query !== undefined ? input.query : current.query, 500),
    density: input.density === "compact" ? "compact" : (current.density || "comfortable"),
    scope: ["open", "completed", "all"].includes(input.scope) ? input.scope : (current.scope || "open"),
  };
}

function validateImportManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.items)) {
    throw clientError("A reviewed import preview is required");
  }
  if (!manifest.items.length || manifest.items.length > 5000) throw clientError("Imports must contain between 1 and 5,000 tasks");
  if (!Array.isArray(manifest.facets) || manifest.facets.length > 50) throw clientError("Imports support up to 50 categories");
  for (const facet of manifest.facets) {
    if (!Array.isArray(facet.values) || facet.values.length > 1000) throw clientError("Each imported category supports up to 1,000 values");
  }
  const byId = new Map();
  for (const item of manifest.items) {
    const id = cleanText(item && item.tempId, 200);
    if (!id || id !== String(item.tempId) || byId.has(id)) throw clientError("Imported tasks require unique stable IDs");
    if (!cleanText(item.title, 300)) throw clientError("Every imported task requires a title");
    byId.set(id, item);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw clientError("Imported task dependencies cannot contain a cycle");
    visiting.add(id);
    const item = byId.get(id);
    const refs = [...(Array.isArray(item.dependsOn) ? item.dependsOn : []), item.parentTempId].filter(Boolean).map(String);
    for (const ref of refs) {
      if (!byId.has(ref)) throw clientError("Every imported dependency must reference another imported task");
      if (ref === id) throw clientError("An imported task cannot depend on itself");
      visit(ref);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return manifest;
}

const HEADING_WORDS = new Set([
  "outside", "living room", "kitchen", "mudroom", "laundry room", "dining room", "4 season room",
  "prepare attic", "attic", "back bedroom", "back bedroom 2", "upstairs hall", "stairway room",
  "hall bathroom", "master bedroom", "master bathroom",
]);

function inferWorkstream(title) {
  const value = title.toLowerCase();
  const rules = [
    ["baseboard", "Baseboards"], ["door", "Doors"], ["cabinet", "Cabinets"], ["light", "Lighting"],
    ["outlet", "Electrical"], ["electr", "Electrical"], ["paint", "Painting"], ["stain", "Finishing"],
    ["floor", "Flooring"], ["toilet", "Plumbing"], ["sink", "Plumbing"], ["shower", "Plumbing"],
    ["yard", "Landscaping"], ["garden", "Landscaping"], ["clean", "Cleaning"], ["organize", "Organization"],
    ["fan", "Ceiling fans"], ["trim", "Trim"], ["window", "Windows"],
  ];
  const found = rules.find(([needle]) => value.includes(needle));
  return found ? found[1] : "General";
}

function inferItemType(title, owner) {
  const lower = title.toLowerCase();
  if (owner) return "External";
  if (title.includes("?") || /^(decide|determine|figure out|should we)\b/.test(lower)) return "Decision";
  if (/^(buy|order|purchase|pick up|find)\b/.test(lower)) return "Purchase";
  return "Action";
}

function cleanImportLine(line) {
  return String(line || "").replace(/^\uFEFF/, "").replace(/^\s*(?:[-*•◦▪]|\d+[.)])\s*/, "").trim();
}

function previewImport(input, cryptoImpl = nodeCrypto) {
  const text = String(input && input.text || "").replace(/\r/g, "");
  if (!text.trim()) throw clientError("Paste project tasks before previewing them");
  if (text.length > 200000) throw clientError("Import text must be under 200,000 characters");
  const projectName = cleanText(input.projectName || "Griffin Renovation", 100);
  const rawLines = text.split("\n");
  const items = [];
  let area = "Uncategorized";
  let owner = null;
  let ownerIndent = -1;
  let context = null;
  let contextIndent = -1;
  let vendor = null;
  let section = "rooms";
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const raw = rawLines[lineIndex];
    const line = cleanImportLine(raw);
    if (!line) continue;
    const bullet = /^(\s*)(?:[-*•◦▪]|\d+[.)])\s+/.exec(String(raw).replace(/^\uFEFF/, ""));
    const indent = bullet ? bullet[1].length : -1;
    if (context && indent <= contextIndent) { context = null; contextIndent = -1; }
    if (owner && indent <= ownerIndent) { owner = null; ownerIndent = -1; }
    const lower = line.toLowerCase().replace(/:$/, "");
    if (["house tasks", "work list by room"].includes(lower)) {
      section = "rooms";
      continue;
    }
    if (lower === "buy list") {
      section = "purchases";
      area = "Purchases";
      owner = null;
      vendor = null;
      context = null;
      continue;
    }
    if (section === "purchases" && !bullet) {
      vendor = cleanText(line.replace(/[👀]/gu, "").trim(), 80);
      continue;
    }
    const looksHeading = HEADING_WORDS.has(lower)
      || (!bullet && /^[A-Z][A-Za-z0-9 &'-]{2,35}:?$/.test(line) && !/[?.!]/.test(line)
        && !/^(buy|install|paint|clean|replace|fix|patch|hang|move|add|remove)\b/i.test(line));
    if (looksHeading && !/:$/.test(line) || HEADING_WORDS.has(lower)) {
      section = "rooms";
      area = line.replace(/:$/, "");
      owner = null;
      vendor = null;
      context = null;
      continue;
    }
    if (/:$/.test(line) && /^[A-Za-z][A-Za-z '-]{1,30}:$/.test(line)
        && !/\b(?:to|for|over|under|inside|outside|around)\b/i.test(line)) {
      owner = line.replace(/:$/, "");
      ownerIndent = indent;
      context = null;
      continue;
    }
    if (/:$/.test(line)) {
      context = line.replace(/:$/, "");
      contextIndent = indent;
      owner = null;
      continue;
    }
    let taskTitle = line;
    let itemOwner = owner;
    const trailingOwner = /\s+-\s+([A-Z][A-Za-z'-]{1,30})$/.exec(taskTitle);
    if (trailingOwner) {
      itemOwner = trailingOwner[1];
      taskTitle = taskTitle.slice(0, trailingOwner.index).trim();
    }
    const possessiveOwner = /^([A-Z][A-Za-z'-]{1,30})'s\s+(.+)$/.exec(taskTitle);
    if (possessiveOwner) {
      itemOwner = possessiveOwner[1];
      taskTitle = possessiveOwner[2];
    }
    if (context) taskTitle = `${context}: ${taskTitle}`;
    const sourceId = `import-${lineIndex + 1}-${cryptoImpl.randomUUID()}`;
    const compound = taskTitle.match(/^buy\s+(?:&|and)\s+(install|replace|build\/install)\s+(.+)$/i)
      || taskTitle.match(/^buy\s+(.+?)\s+(?:&|and)\s+(install|replace|build\/install)$/i);
    if (compound) {
      const prefixForm = /^(?:install|replace|build\/install)$/i.test(compound[1]);
      const action = (prefixForm ? compound[1] : compound[2]).toLowerCase();
      const object = (prefixForm ? compound[2] : compound[1]).trim();
      const actionTitle = `${action === "build/install" ? "Build/install" : action[0].toUpperCase() + action.slice(1)} ${object}`;
      const firstId = `${sourceId}-buy`;
      items.push({ tempId: firstId, title: `Buy ${object}`, area, workstream: inferWorkstream(object), itemType: "Purchase", owner: itemOwner, vendor, sourceLine: lineIndex + 1, sourceText: raw.trim(), dependsOn: [] });
      items.push({ tempId: `${sourceId}-action`, title: actionTitle, area, workstream: inferWorkstream(object), itemType: itemOwner ? "External" : "Action", owner: itemOwner, vendor, sourceLine: lineIndex + 1, sourceText: raw.trim(), dependsOn: [firstId] });
      continue;
    }
    items.push({
      tempId: sourceId,
      title: cleanText(taskTitle, 300),
      area,
      workstream: inferWorkstream(taskTitle),
      itemType: section === "purchases" ? "Purchase" : inferItemType(taskTitle, itemOwner),
      owner: itemOwner,
      vendor,
      sourceLine: lineIndex + 1,
      sourceText: raw.trim(),
      dependsOn: [],
    });
  }
  if (!items.length) throw clientError("No tasks could be found in the pasted text");

  const workstreamCounts = items.reduce((counts, item) => {
    counts[item.workstream] = (counts[item.workstream] || 0) + 1;
    return counts;
  }, {});
  const parents = Object.entries(workstreamCounts).filter(([, count]) => count > 1).map(([workstream], index) => ({
    tempId: `parent-${slugify(workstream)}-${index}`,
    title: workstream,
    area: null,
    workstream,
    itemType: "Action",
    owner: null,
    sourceLine: null,
    sourceText: `Workstream parent generated for ${workstream}`,
    dependsOn: [],
    role: "parent",
  }));
  const parentByWorkstream = new Map(parents.map(parent => [parent.workstream, parent.tempId]));
  for (const item of items) item.parentTempId = parentByWorkstream.get(item.workstream) || null;
  const allItems = [...parents, ...items].map((item, index) => ({ ...item, role: item.role || "leaf", projectOrder: (index + 1) * 1000 }));
  return {
    version: 1,
    project: { name: projectName, sourceUrl: cleanText(input.sourceUrl, 1000) || null },
    facets: [
      { name: "Area", scope: "project", cardinality: "single", values: [...new Set(items.map(item => item.area).filter(Boolean))] },
      { name: "Workstream", scope: "project", cardinality: "single", values: [...new Set(items.map(item => item.workstream).filter(Boolean))] },
      { name: "Type", scope: "workspace", cardinality: "single", values: [...new Set(items.map(item => item.itemType).filter(Boolean))] },
      ...([...new Set(items.map(item => item.vendor).filter(Boolean))].length ? [{ name: "Vendor", scope: "project", cardinality: "single", values: [...new Set(items.map(item => item.vendor).filter(Boolean))] }] : []),
    ],
    items: allItems,
    warnings: [],
    parser: "deterministic-v1",
  };
}

function createProjectStore(deps = {}) {
  const pool = deps.pool;
  const blockDB = deps.blockDB;
  const cryptoImpl = deps.crypto || nodeCrypto;
  if (!pool || !blockDB) throw new Error("project-store requires pool and blockDB");

  async function getOwnedBlock(id, workspaceId, client, includeDeleted = false) {
    const q = client || pool;
    const { rows } = await q.query(
      `SELECT * FROM blocks WHERE id=$1 AND workspace_id IS NOT DISTINCT FROM $2 ${includeDeleted ? "" : "AND deleted_at IS NULL"} LIMIT 1`,
      [id, workspaceId || null]
    );
    return rows[0] ? blockDB.parseBlock(rows[0]) : null;
  }

  async function listOrganization(workspaceId, client) {
    const q = client || pool;
    const { rows } = await q.query(
      `SELECT * FROM blocks WHERE type='block' AND workspace_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL
       AND properties->>'kind' IN ('project','task_facet','task_view') ORDER BY sort_order ASC, created_at ASC`,
      [workspaceId || null]
    );
    const parsed = rows.map(blockDB.parseBlock);
    return {
      projects: parsed.filter(row => row.properties.kind === "project"),
      facets: parsed.filter(row => row.properties.kind === "task_facet"),
      views: parsed.filter(row => row.properties.kind === "task_view"),
    };
  }

  async function listTaskRows(workspaceId) {
    const { rows } = await pool.query(
      `SELECT * FROM blocks WHERE workspace_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL
       ORDER BY CASE WHEN COALESCE(properties->>'projectOrder','') ~ '^-?[0-9]+(?:[.][0-9]+)?$'
                     THEN (properties->>'projectOrder')::double precision ELSE sort_order END,
                created_at ASC`,
      [workspaceId || null]
    );
    return rows.map(blockDB.parseBlock).filter(row => isLibraryTask(row, blockDB));
  }

  async function listLibrary(workspaceId) {
    const [tasks, organization, dependencyRows] = await Promise.all([
      listTaskRows(workspaceId),
      listOrganization(workspaceId),
      blockDB.getDelegatedItems(workspaceId),
    ]);
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    for (const task of tasks) {
      const localId = cleanText((task.properties || {}).local_id, 200);
      if (localId) byId.set(localId, task);
    }
    const dependencies = dependencyRows.filter(row => {
      const props = row.properties || {};
      return props.blockerType === "task" && props.blockerBlockId && props.linkedBlockId;
    });
    const readiness = {};
    for (const task of tasks) readiness[task.id] = { state: "ready", total: 0, satisfied: 0, blockers: [] };
    for (const edge of dependencies) {
      const props = edge.properties || {};
      const dependent = byId.get(String(props.linkedBlockId));
      const blocker = byId.get(String(props.blockerBlockId));
      if (!dependent) continue;
      const entry = readiness[dependent.id] || (readiness[dependent.id] = { state: "ready", total: 0, satisfied: 0, blockers: [] });
      const satisfied = !!blocker && isDone(blocker);
      entry.total++;
      if (satisfied) entry.satisfied++;
      else entry.blockers.push({ id: blocker ? blocker.id : props.blockerBlockId, title: blocker ? cleanText(blocker.properties.title || blocker.properties.text) : props.title || "Missing prerequisite" });
      if (!satisfied) entry.state = "blocked";
    }
    return { tasks, ...organization, dependencies, readiness, builtinViews: BUILTIN_VIEWS };
  }

  async function createOrganizationBlock(kind, properties, owner, client, sortOrder) {
    const now = new Date().toISOString();
    return blockDB.createBlock({
      id: `${kind}-${cryptoImpl.randomUUID()}`,
      type: "block",
      parent_id: null,
      date: null,
      sort_order: sortOrder == null ? null : sortOrder,
      properties: { ...properties, kind, createdAt: properties.createdAt || now, updatedAt: now },
      user_id: owner.userId,
      workspace_id: owner.workspaceId,
    }, client);
  }

  async function createProject(input, owner, client) {
    input = input || {};
    const name = cleanText(input.name, 100);
    if (!name) throw clientError("Project name is required");
    return createOrganizationBlock("project", {
      name, title: name, description: cleanText(input.description, 2000), slug: slugify(name),
      status: ["active", "paused", "complete", "archived"].includes(input.status) ? input.status : "active",
      color: cleanText(input.color, 24) || "#0075EB",
      source: input.source && typeof input.source === "object" ? input.source : null,
      sourceImportKey: cleanText(input.sourceImportKey, 160) || null,
    }, owner, client);
  }

  async function patchProject(id, input, owner) {
    const existing = await getOwnedBlock(id, owner.workspaceId);
    if (!existing || (existing.properties || {}).kind !== "project") throw clientError("Project not found", 404);
    const props = { ...existing.properties };
    if (input.name !== undefined) {
      props.name = cleanText(input.name, 100);
      if (!props.name) throw clientError("Project name is required");
      props.title = props.name;
      props.slug = slugify(props.name);
    }
    if (input.description !== undefined) props.description = cleanText(input.description, 2000);
    if (input.status !== undefined) {
      if (!["active", "paused", "complete", "archived"].includes(input.status)) throw clientError("Invalid project status");
      props.status = input.status;
    }
    if (input.color !== undefined) props.color = cleanText(input.color, 24) || "#0075EB";
    props.updatedAt = new Date().toISOString();
    return blockDB.updateBlock(id, { properties: props });
  }

  async function createFacet(input, owner, client) {
    const props = normalizeFacet(input, null, cryptoImpl);
    if (props.projectId) {
      const project = await getOwnedBlock(props.projectId, owner.workspaceId, client);
      if (!project || (project.properties || {}).kind !== "project") throw clientError("Project not found", 404);
    }
    return createOrganizationBlock("task_facet", props, owner, client);
  }

  async function patchFacet(id, input, owner, client) {
    const existing = await getOwnedBlock(id, owner.workspaceId, client);
    if (!existing || (existing.properties || {}).kind !== "task_facet") throw clientError("Category not found", 404);
    const props = normalizeFacet(input, existing.properties, cryptoImpl);
    props.updatedAt = new Date().toISOString();
    return blockDB.updateBlock(id, { properties: props }, client);
  }

  async function createView(input, owner) {
    return createOrganizationBlock("task_view", normalizeView(input), owner);
  }

  async function patchView(id, input, owner) {
    const existing = await getOwnedBlock(id, owner.workspaceId);
    if (!existing || (existing.properties || {}).kind !== "task_view") throw clientError("Saved view not found", 404);
    const props = normalizeView(input, existing.properties);
    props.updatedAt = new Date().toISOString();
    return blockDB.updateBlock(id, { properties: props });
  }

  async function deleteView(id, owner) {
    const existing = await getOwnedBlock(id, owner.workspaceId);
    if (!existing || (existing.properties || {}).kind !== "task_view") throw clientError("Saved view not found", 404);
    return blockDB.deleteBlock(id);
  }

  async function createTask(input, owner, client) {
    const title = cleanText(input && input.title, 300);
    if (!title) throw clientError("Task title is required");
    const duration = Math.max(1, Math.min(1440, Number(input.duration || input.durMin) || 30));
    const now = new Date().toISOString();
    const properties = {
      kind: input.kind || "backlog",
      local_id: input.local_id || `library-${cryptoImpl.randomUUID()}`,
      title,
      detail: cleanText(input.detail, 5000),
      type: input.type || "task",
      source: input.source || "manual",
      status: "open",
      priority: ["High", "Medium", "Low"].includes(input.priority) ? input.priority : "Medium",
      stage: input.stage || "Backlog",
      duration,
      durMin: duration,
      projectId: cleanText(input.projectId, 120) || null,
      projectParentTaskId: cleanText(input.projectParentTaskId, 120) || null,
      projectRole: input.projectRole === "parent" ? "parent" : "leaf",
      projectOrder: Number.isFinite(Number(input.projectOrder)) ? Number(input.projectOrder) : Date.now(),
      facetValues: input.facetValues && typeof input.facetValues === "object" ? input.facetValues : {},
      owner: cleanText(input.owner, 120) || null,
      sourceText: cleanText(input.sourceText, 2000) || null,
      sourceLine: Number.isFinite(Number(input.sourceLine)) ? Number(input.sourceLine) : null,
      importKey: cleanText(input.importKey, 200) || null,
      added_at: now,
    };
    return blockDB.createBlock({
      id: input.id || cryptoImpl.randomUUID(), type: "block", parent_id: null,
      date: input.date || null, sort_order: input.sort_order == null ? null : input.sort_order,
      properties, user_id: owner.userId, workspace_id: owner.workspaceId,
    }, client);
  }

  async function organizeTask(id, input, owner) {
    const task = await getOwnedBlock(id, owner.workspaceId);
    if (!task || !isLibraryTask(task, blockDB)) throw clientError("Task not found", 404);
    const organization = await listOrganization(owner.workspaceId);
    const projectId = input.projectId === undefined ? ((task.properties || {}).projectId || null) : (cleanText(input.projectId, 120) || null);
    if (projectId && !organization.projects.some(project => project.id === projectId && (project.properties || {}).status !== "archived")) {
      throw clientError("Project not found", 404);
    }
    const facetsById = new Map(organization.facets.map(facet => [facet.id, facet]));
    const incomingAssignments = input.facetValues && typeof input.facetValues === "object"
      ? input.facetValues : ((task.properties || {}).facetValues || {});
    const facetValues = {};
    for (const [facetId, rawValues] of Object.entries(incomingAssignments)) {
      const facet = facetsById.get(facetId);
      if (!facet || (facet.properties || {}).archived) continue;
      const def = facet.properties || {};
      if (def.scope === "project" && def.projectId !== projectId) continue;
      const valid = new Set((def.values || []).filter(value => !value.archived).map(value => value.id));
      let values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map(String).filter(value => valid.has(value));
      if (def.cardinality === "single") values = values.slice(0, 1);
      if (values.length) facetValues[facetId] = [...new Set(values)];
    }
    const props = { ...(task.properties || {}), projectId, facetValues, updatedAt: new Date().toISOString() };
    if (input.title !== undefined) {
      props.title = cleanText(input.title, 300);
      if (!props.title) throw clientError("Task title is required");
    }
    if (input.detail !== undefined) props.detail = cleanText(input.detail, 5000);
    if (input.priority !== undefined && ["High", "Medium", "Low"].includes(input.priority)) props.priority = input.priority;
    if (input.duration !== undefined) {
      const duration = Math.max(1, Math.min(1440, Number(input.duration) || 30));
      props.duration = duration;
      props.durMin = duration;
    }
    if (input.projectOrder !== undefined && Number.isFinite(Number(input.projectOrder))) props.projectOrder = Number(input.projectOrder);
    return blockDB.updateBlock(id, { properties: props });
  }

  async function reorderTasks(ids, owner) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    if (!unique.length) throw clientError("Task order is required");
    const client = await pool.connect();
    const updated = [];
    try {
      await client.query("BEGIN");
      for (let index = 0; index < unique.length; index++) {
        const task = await getOwnedBlock(unique[index], owner.workspaceId, client);
        if (!task || !isLibraryTask(task, blockDB)) throw clientError("Task not found", 404);
        const props = { ...(task.properties || {}), projectOrder: (index + 1) * 1000, updatedAt: new Date().toISOString() };
        updated.push(await blockDB.updateBlock(task.id, { properties: props }, client));
      }
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function commitImport(manifest, input, owner) {
    validateImportManifest(manifest);
    const idempotencyKey = cleanText(input && input.idempotencyKey, 160);
    if (!idempotencyKey) throw clientError("Import idempotency key is required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-import:${owner.workspaceId}:${idempotencyKey}`]);
      const { rows: existingRows } = await client.query(
        `SELECT * FROM blocks WHERE workspace_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL
         AND properties->>'kind'='project' AND properties->>'sourceImportKey'=$2 LIMIT 1`,
        [owner.workspaceId || null, idempotencyKey]
      );
      if (existingRows[0]) {
        await client.query("COMMIT");
        return { duplicate: true, project: blockDB.parseBlock(existingRows[0]), tasks: [] };
      }
      const project = await createProject({
        name: cleanText(manifest.project && manifest.project.name, 100) || "Imported project",
        description: "Imported into the Task Library",
        sourceImportKey: idempotencyKey,
        source: { type: "pasted_document", url: cleanText(manifest.project && manifest.project.sourceUrl, 1000) || null, importedAt: new Date().toISOString(), parser: manifest.parser || "reviewed" },
      }, owner, client);
      const organization = await listOrganization(owner.workspaceId, client);
      const facetMap = new Map();
      for (const facetInput of manifest.facets || []) {
        const normalizedName = cleanText(facetInput.name, 80).toLowerCase();
        let facet = organization.facets.find(row => {
          const p = row.properties || {};
          return String(p.name || "").toLowerCase() === normalizedName && p.scope === facetInput.scope
            && (p.scope !== "project" || p.projectId === project.id);
        });
        if (!facet) {
          facet = await createFacet({ ...facetInput, projectId: facetInput.scope === "project" ? project.id : null }, owner, client);
        } else {
          const existingValues = (facet.properties || {}).values || [];
          const mergedValues = [...existingValues];
          for (const valueName of facetInput.values || []) {
            const existing = mergedValues.find(value => String(value.name || "").toLowerCase() === String(valueName).toLowerCase());
            if (existing) existing.archived = false;
            else mergedValues.push({ name: valueName });
          }
          facet = await patchFacet(facet.id, { values: mergedValues }, owner, client);
        }
        facetMap.set(normalizedName, facet);
      }
      const taskMap = new Map();
      const tasks = [];
      for (const item of manifest.items) {
        const facetValues = {};
        for (const [facetName, valueName] of [["area", item.area], ["workstream", item.workstream], ["type", item.itemType], ["vendor", item.vendor]]) {
          if (!valueName) continue;
          const facet = facetMap.get(facetName);
          if (!facet) continue;
          const value = ((facet.properties || {}).values || []).find(entry => entry.name.toLowerCase() === String(valueName).toLowerCase());
          if (value) facetValues[facet.id] = [value.id];
        }
        const task = await createTask({
          title: item.title, projectId: project.id, projectRole: item.role, projectOrder: item.projectOrder,
          facetValues, owner: item.owner, sourceText: item.sourceText, sourceLine: item.sourceLine,
          importKey: `${idempotencyKey}:${item.tempId}`,
        }, owner, client);
        tasks.push(task);
        taskMap.set(item.tempId, task);
      }
      for (const item of manifest.items) {
        const task = taskMap.get(item.tempId);
        if (!task) continue;
        const parent = item.parentTempId ? taskMap.get(item.parentTempId) : null;
        if (parent) {
          task.properties = { ...task.properties, projectParentTaskId: parent.id };
          await blockDB.updateBlock(task.id, { properties: task.properties }, client);
        }
        const dependencyIds = [];
        for (const blockerTempId of item.dependsOn || []) {
          const blocker = taskMap.get(blockerTempId);
          if (!blocker) continue;
          const edge = await createOrganizationBlock("delegated_item", {
            blockerType: "task", blockerBlockId: blocker.id, linkedBlockId: task.id,
            title: blocker.properties.title, myTask: task.properties.title, status: "open", checkInDate: null,
          }, owner, client);
          dependencyIds.push(edge.id);
        }
        if (dependencyIds.length) {
          task.properties = { ...task.properties, dependencyWaitingItemIds: dependencyIds, dependencyWaitingItemId: dependencyIds[0] };
          await blockDB.updateBlock(task.id, { properties: task.properties }, client);
        }
      }
      await client.query("COMMIT");
      return { duplicate: false, project, tasks };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    listLibrary, listOrganization, createProject, patchProject, createFacet, patchFacet,
    createView, patchView, deleteView, createTask, organizeTask, reorderTasks,
    previewImport: input => previewImport(input, cryptoImpl), commitImport,
  };
}

module.exports = {
  BUILTIN_VIEWS, FACET_CARDINALITIES, FACET_SCOPES, ORGANIZATION_KINDS,
  cleanText, slugify, normalizeFacet, normalizeView, previewImport, validateImportManifest, isLibraryTask,
  createProjectStore,
};
