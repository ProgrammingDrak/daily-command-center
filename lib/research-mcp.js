const { z } = require("zod");
const M = require("./research-model");
const W = require("./wishlist-model");
const { createStore } = require("../research-store");
const schemas = {
  dcc_search_research: M.search,
  dcc_read_research: z.strictObject({ id: W.uuid }),
  dcc_create_research: M.create,
  dcc_update_research: z.strictObject({ id: W.uuid, ...W.envelope.shape, data: W.overview.partial() }),
  dcc_append_research: z.strictObject({ recordId: W.uuid, ...M.entry.shape }),
  dcc_link_research: M.edge,
  dcc_research_activity: z.strictObject({
    id: W.uuid.optional(),
    offset: z.int().min(0).max(100000).default(0),
    questions: z.boolean().default(false)
  }),
  dcc_research_action: z.strictObject({ recordId: W.uuid, ...M.action.shape })
};
const descriptions = {
  dcc_search_research:
    "Search private ideas, reusable research, purchase requirements, canonical products and existing Wishlists. Filter status, tags, category, dormantBefore, purchases or archived. Paginated. Research is not scheduled work.",
  dcc_read_research:
    "Read one canonical record with findings, comparisons, dated prices, private attachment references, questions and bidirectional links. Follow research and requirement links for associated research and candidates. Entries above 200 remain available through activity history.",
  dcc_create_research:
    "Capture an idea, research topic, purchase requirement or canonical product with only a title. Search for an existing record first. Reuse the fresh UUID on retry. Creates no task or schedule.",
  dcc_update_research:
    "Update only changed fields using the current revision and a stable mutation UUID. Archive with archived:true; restore with false. Preserve dated price observations and actual purchase details separately. History retains earlier values.",
  dcc_append_research:
    "Append an attributed finding, evidence, AI summary, question, decision, recommendation or note. Never invent sources or prices. Fresh entry UUID with revision 0. Resolve or supersede an existing entry by updating only state at its current revision. New conclusions use new entries, optionally supersedesId.",
  dcc_link_research:
    "Link reusable records or existing canonical tasks/projects. Candidates link a requirement to a product. Read first; use a new UUID and revision 0 to add. Unlink with active:false and current revision, preserving endpoints. Reuse mutation UUID and exact arguments on retry.",
  dcc_research_activity:
    "Retrieve paginated revision history or unresolved questions across the account or for one record. Distinguishes user decisions, AI summaries, evidence and superseded information.",
  dcc_research_action:
    "Explicitly create and link an undated canonical task, a selected-item purchase task, or promote an idea to an existing DCC project type. Requires research write plus tasks write or organization write. Never schedules or joins Working Queue. Reuse IDs and mutation UUID on retry."
};
const reads = new Set(["dcc_search_research", "dcc_read_research", "dcc_research_activity"]);
const scopeFor = (name) =>
  Object.hasOwn(schemas, name) ? "dcc.research." + (reads.has(name) ? "read" : "write") : null;
const tools = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name],
  inputSchema: z.toJSONSchema(schema),
  annotations: { readOnlyHint: reads.has(name), destructiveHint: false, idempotentHint: true }
}));
async function run(ctx, name, input, identity) {
  if (!identity.scopes?.includes(scopeFor(name))) throw W.fail("Research permission required", 403);
  const b = W.parse(schemas[name], input),
    s = createStore(ctx);
  let result;
  if (name === "dcc_search_research") return s.search(identity, b);
  if (name === "dcc_read_research") return s.get(identity, b.id);
  if (name === "dcc_research_activity") return s.activity(identity, b);
  if (name === "dcc_create_research") result = await s.create(identity, b);
  if (name === "dcc_update_research") {
    const { id, ...body } = b;
    result = await s.save(identity, id, body);
  }
  if (name === "dcc_append_research") {
    const { recordId, ...body } = b;
    result = await s.entry(identity, recordId, body);
  }
  if (name === "dcc_link_research") {
    if (b.blockId && !identity.scopes.includes(b.relation === "project" ? "dcc.organization.read" : "dcc.tasks.read"))
      throw W.fail("Task or project read permission required", 403);
    result = await s.link(identity, b);
  }
  if (name === "dcc_research_action") {
    if (!identity.scopes.includes(b.action === "project" ? "dcc.organization.write" : "dcc.tasks.write"))
      throw W.fail("Task or project write permission required", 403);
    const { recordId, ...body } = b;
    result = await s.action(identity, recordId, body);
    if (!result.duplicate)
      ctx.broadcast?.("blocks-changed", { action: "research-action", blockIds: [result.id] }, identity.workspaceId);
  }
  ctx.broadcast?.("research-changed", { id: b.recordId || b.id || b.fromId }, identity.workspaceId);
  return identity.scopes.includes("dcc.research.read")
    ? result
    : { id: result.id, revision: result.revision, duplicate: result.duplicate === true };
}
module.exports = { tools, scopeFor, run };
