const { createHash, randomUUID } = require("node:crypto");
const W = require("./lib/wishlist-model");
const M = require("./lib/research-model");
const { createStore: wishlists } = require("./wishlist-store");
const { createProjectStore, isLibraryTask } = require("./project-store");
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])])
        )
      : v;
const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(stable(v)))
    .digest("hex");
const projectUrl = (id) => "/?researchProject=" + encodeURIComponent(id);
const recordUrl = (id) => "/research?id=" + encodeURIComponent(id);
const projectTaskUrl = (id) => "/?researchTask=" + encodeURIComponent(id);
function createStore(ctx) {
  const { pool, blockDB } = ctx;
  const wishlist = wishlists(ctx);
  async function transaction(actor, run, write = false) {
    if (!Number.isSafeInteger(actor.userId) || actor.userId < 1 || !actor.workspaceId)
      throw W.fail("Sign in to open Research & Ideas", 401);
    const q = await pool.connect();
    try {
      await q.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (write) await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["research:" + actor.workspaceId]);
      const owner = await q.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2", [
        actor.workspaceId,
        actor.userId
      ]);
      if (!owner.rows.length) throw W.fail("Research unavailable", 404);
      const result = await run(q);
      await q.query("COMMIT");
      return result;
    } catch (e) {
      await q.query("ROLLBACK");
      if (e.code === "23505")
        throw W.fail("This relationship or identifier already exists. Refresh before retrying.", 409);
      throw e;
    } finally {
      q.release();
    }
  }
  async function owned(q, actor, id) {
    W.parse(W.uuid, id);
    const r = await q.query(
      `SELECT w.*,COALESCE(r.kind,'wishlist') AS record_kind FROM wishlists w
      LEFT JOIN research_records r ON r.id=w.id WHERE w.id=$1 AND w.workspace_id=$2 AND w.user_id=$3`,
      [id, actor.workspaceId, actor.userId]
    );
    if (!r.rows[0]) throw W.fail("Research record unavailable", 404);
    return r.rows[0];
  }
  async function block(q, actor, id, relation) {
    const r = await q.query(
      `SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND (user_id=$3 OR user_id IS NULL) AND deleted_at IS NULL`,
      [id, actor.workspaceId, actor.userId]
    );
    const b = r.rows[0];
    if (!b || (relation === "project" ? b.properties?.kind !== "project" : !isLibraryTask(b, blockDB)))
      throw W.fail("Linked task or project unavailable", 404);
    return b;
  }
  async function mutation(q, actor, id, input, run) {
    const hash = digest(input);
    const old = await q.query(
      "SELECT fingerprint,result FROM research_mutations WHERE workspace_id=$1 AND user_id=$2 AND id=$3",
      [actor.workspaceId, actor.userId, id]
    );
    if (old.rows[0]) {
      if (old.rows[0].fingerprint !== hash) throw W.fail("Mutation identity already used", 409);
      return { ...old.rows[0].result, duplicate: true };
    }
    const result = await run();
    await q.query("INSERT INTO research_mutations VALUES($1,$2,$3,$4,$5)", [
      actor.workspaceId,
      actor.userId,
      id,
      hash,
      result
    ]);
    return result;
  }
  async function history(q, actor, id, kind, recordId, revision, data) {
    await q.query(
      `INSERT INTO wishlist_revisions(wishlist_id,kind,record_id,revision,data,actor_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, kind, recordId, revision, data, actor.userId]
    );
    await q.query("UPDATE wishlists SET updated_at=NOW() WHERE id=$1", [id]);
  }
  async function create(actor, input) {
    const b = W.parse(M.create, input);
    return transaction(
      actor,
      (q) =>
        mutation(q, actor, b.id, ["create", b], async () => {
          const store = wishlists({ ...ctx, transactionClient: q });
          const created = await store.create(actor, { id: b.id, title: b.title });
          if (created.duplicate) throw W.fail("Identifier already belongs to an existing Wishlist", 409);
          await q.query("INSERT INTO research_records(id,kind) VALUES($1,$2)", [b.id, b.kind]);
          const defaults = {
            idea: { lifecycle: "Captured" },
            research: { researchStatus: "Open" },
            product: { purchaseStatus: "Considering" },
            requirement: { purchaseStatus: "Considering", quantity: 1 }
          }[b.kind];
          const result = await store.save(actor, b.id, "overview", null, {
            revision: 1,
            mutationId: randomUUID(),
            data: defaults
          });
          return { ...result, kind: b.kind, url: recordUrl(b.id) };
        }),
      true
    );
  }
  async function save(actor, id, input) {
    // The canonical Wishlist revision envelope protects UI and MCP edits alike.
    return transaction(
      actor,
      async (q) => {
        await owned(q, actor, id);
        return wishlists({ ...ctx, transactionClient: q }).save(actor, id, "overview", null, input);
      },
      true
    );
  }
  async function search(actor, input = {}) {
    const b = W.parse(M.search, input);
    return transaction(actor, async (q) => {
      const { rows } = await q.query(
        `SELECT l.*,COALESCE(r.kind,'wishlist') AS record_kind FROM wishlists l
        LEFT JOIN research_records r ON r.id=l.id
        WHERE l.workspace_id=$1 AND l.user_id=$2
        AND ($3='all' OR COALESCE(r.kind,'wishlist')=$3 OR ($3='items' AND COALESCE(r.kind,'wishlist') IN ('wishlist','requirement','product')))
        AND COALESCE((l.data->>'archived')::boolean,FALSE)=$4
        AND ($5='' OR strpos(lower(l.data::text),lower($5))>0 OR EXISTS(
          SELECT 1 FROM research_entries e WHERE e.record_id=l.id AND strpos(lower(e.data::text),lower($5))>0)
          OR EXISTS(SELECT 1 FROM wishlist_records wr WHERE wr.wishlist_id=l.id AND strpos(lower(wr.data::text),lower($5))>0))
        AND ($6::text[] IS NULL OR COALESCE(l.data->>'lifecycle',l.data->>'researchStatus',l.data->>'purchaseStatus',l.data->>'stage')=ANY($6))
        AND ($7='' OR l.data->>'category'=$7) AND ($8='' OR l.data->'tags' ? $8)
        AND (NOT $9 OR l.data->>'purchaseStatus' IN ('Selected','To Buy','Ordered','Owned','Returned'))
        AND ($10::date IS NULL OR l.updated_at<$10::date)
        ORDER BY CASE WHEN $11='priority' THEN CASE l.data->>'priority' WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END ELSE 0 END,
        CASE WHEN $11='created' THEN l.created_at ELSE l.updated_at END DESC,l.id
        LIMIT $12 OFFSET $13`,
        [
          actor.workspaceId,
          actor.userId,
          b.kind,
          b.archived,
          b.query || "",
          b.status ?? null,
          b.category || "",
          b.tag || "",
          b.purchases,
          b.dormantBefore || null,
          b.sort,
          b.limit + 1,
          b.offset
        ]
      );
      return {
        records: rows.slice(0, b.limit).map((r) => ({
          ...r.data,
          id: r.id,
          revision: r.revision,
          kind: r.record_kind,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          url: recordUrl(r.id)
        })),
        nextOffset: rows.length > b.limit ? b.offset + b.limit : null
      };
    });
  }
  async function links(q, actor, id, blockId) {
    // Both directions resolve live owner-scoped targets. Hidden targets disclose nothing.
    const { rows } = await q.query(
      `SELECT e.*,e.data AS link_data,l.id AS target_id,l.revision AS target_revision,l.data,COALESCE(r.kind,'wishlist') AS kind
      FROM research_links e JOIN wishlists l ON l.id=CASE WHEN e.from_id=$3::uuid THEN e.to_id ELSE e.from_id END
      LEFT JOIN research_records r ON r.id=l.id
      WHERE l.workspace_id=$1 AND l.user_id=$2 AND e.active
      AND (($3::uuid IS NOT NULL AND (e.from_id=$3 OR e.to_id=$3) AND e.block_id IS NULL) OR ($4::text IS NOT NULL AND e.block_id=$4))
      ORDER BY e.created_at,e.id LIMIT 200`,
      [actor.workspaceId, actor.userId, id || null, blockId || null]
    );
    const result = rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      relation: r.relation,
      fromId: r.from_id,
      toId: r.to_id,
      blockId: r.block_id,
      details: r.link_data,
      record: { ...r.data, id: r.target_id, revision: r.target_revision, kind: r.kind, url: recordUrl(r.target_id) }
    }));
    if (id) {
      const blocks = await q.query(
        `SELECT e.*,b.properties FROM research_links e JOIN blocks b ON b.id=e.block_id
        WHERE e.from_id=$1 AND e.active AND b.workspace_id=$2 AND (b.user_id IS NULL OR b.user_id=$3) AND b.deleted_at IS NULL
        ORDER BY e.created_at,e.id LIMIT 200`,
        [id, actor.workspaceId, actor.userId]
      );
      for (const r of blocks.rows)
        result.push({
          id: r.id,
          revision: r.revision,
          relation: r.relation,
          fromId: r.from_id,
          blockId: r.block_id,
          details: r.data,
          record: {
            id: r.block_id,
            title: r.properties.title || r.properties.name || r.properties.text,
            kind: r.relation,
            url: r.relation === "project" ? projectUrl(r.block_id) : projectTaskUrl(r.block_id)
          }
        });
      const legacy = await q.query(
        `SELECT b.id,b.properties FROM wishlist_records wr JOIN blocks b ON b.id=wr.data->>'taskId'
        WHERE wr.wishlist_id=$1 AND wr.kind='tasks' AND b.workspace_id=$2 AND (b.user_id IS NULL OR b.user_id=$3) AND b.deleted_at IS NULL`,
        [id, actor.workspaceId, actor.userId]
      );
      for (const b of legacy.rows)
        if (!result.some((r) => r.blockId === b.id))
          result.push({
            relation: "task",
            legacy: true,
            record: {
              id: b.id,
              title: b.properties.title || b.properties.text,
              kind: "task",
              url: projectTaskUrl(b.id)
            }
          });
    }
    if (blockId) {
      const legacy = await q.query(
        `SELECT l.id,l.data FROM wishlist_records wr JOIN wishlists l ON l.id=wr.wishlist_id
        WHERE wr.kind='tasks' AND wr.data->>'taskId'=$1 AND l.workspace_id=$2 AND l.user_id=$3`,
        [blockId, actor.workspaceId, actor.userId]
      );
      for (const l of legacy.rows)
        if (!result.some((r) => r.record.id === l.id))
          result.push({
            relation: "task",
            legacy: true,
            record: { ...l.data, id: l.id, kind: "wishlist", url: recordUrl(l.id) }
          });
    }
    return result;
  }
  async function get(actor, id) {
    return transaction(actor, async (q) => {
      const row = await owned(q, actor, id);
      const result = await wishlists({ ...ctx, transactionClient: q }).get(actor, id);
      const entries = await q.query(
        "SELECT * FROM research_entries WHERE record_id=$1 ORDER BY created_at,id LIMIT 201",
        [id]
      );
      return {
        ...result,
        kind: row.record_kind,
        links: await links(q, actor, id),
        entries: entries.rows
          .slice(0, 200)
          .map((e) => ({ ...e.data, id: e.id, revision: e.revision, createdAt: e.created_at })),
        entriesTruncated: entries.rows.length > 200,
        url: recordUrl(id)
      };
    });
  }
  async function forBlock(actor, id) {
    return transaction(actor, async (q) => {
      const r = await q.query(
        `SELECT properties FROM blocks WHERE id=$1 AND workspace_id=$2 AND (user_id IS NULL OR user_id=$3) AND deleted_at IS NULL`,
        [id, actor.workspaceId, actor.userId]
      );
      if (!r.rows.length) throw W.fail("Task or project unavailable", 404);
      return { links: await links(q, actor, null, id) };
    });
  }
  async function link(actor, input) {
    const b = W.parse(M.edge, input);
    return transaction(
      actor,
      (q) =>
        mutation(q, actor, b.mutationId, ["link", b], async () => {
          const source = await owned(q, actor, b.fromId);
          let target;
          if (b.toId) target = await owned(q, actor, b.toId);
          else await block(q, actor, b.blockId, b.relation);
          if (b.fromId === b.toId) throw W.fail("A record cannot link to itself");
          if (
            b.relation === "candidate" &&
            !(source.record_kind === "requirement" && target?.record_kind === "product")
          )
            throw W.fail("Candidates link a requirement to a canonical product");
          let current = (await q.query("SELECT * FROM research_links WHERE id=$1", [b.id])).rows[0];
          if (!current && b.active && b.revision === 0) {
            const previous = (
              await q.query(
                `SELECT * FROM research_links WHERE NOT active AND relation=$1
          AND (($2::uuid IS NOT NULL AND LEAST(from_id,to_id)=LEAST($3::uuid,$2::uuid) AND GREATEST(from_id,to_id)=GREATEST($3::uuid,$2::uuid))
          OR ($4::text IS NOT NULL AND from_id=$3 AND block_id=$4))`,
                [b.relation, b.toId || null, b.fromId, b.blockId || null]
              )
            ).rows[0];
            if (previous) {
              await q.query("UPDATE research_links SET active=TRUE,revision=revision+1,data=$2 WHERE id=$1", [
                previous.id,
                b.data === undefined ? previous.data : b.data
              ]);
              await history(q, actor, b.fromId, "link", previous.id, previous.revision + 1, { ...b, restored: true });
              if (b.toId) await q.query("UPDATE wishlists SET updated_at=NOW() WHERE id=$1", [b.toId]);
              return { id: previous.id, revision: previous.revision + 1, active: true };
            }
          }
          if ((current?.revision || 0) !== b.revision)
            throw W.fail("Relationship changed. Refresh before saving.", 409);
          if (
            current &&
            (current.from_id !== b.fromId ||
              current.to_id !== (b.toId || null) ||
              current.block_id !== (b.blockId || null) ||
              current.relation !== b.relation)
          )
            throw W.fail("Relationship identity already used", 409);
          if (!current && !b.active) throw W.fail("Relationship unavailable", 404);
          const data = b.data === undefined ? current?.data || {} : b.data;
          await q.query(
            `INSERT INTO research_links(id,from_id,to_id,block_id,relation,data,revision,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,revision=EXCLUDED.revision,active=EXCLUDED.active`,
            [b.id, b.fromId, b.toId || null, b.blockId || null, b.relation, data, b.revision + 1, b.active]
          );
          await history(q, actor, b.fromId, "link", b.id, b.revision + 1, b);
          if (b.toId) await q.query("UPDATE wishlists SET updated_at=NOW() WHERE id=$1", [b.toId]);
          return { id: b.id, revision: b.revision + 1, active: b.active };
        }),
      true
    );
  }
  async function entry(actor, id, input) {
    const b = W.parse(M.entry, input);
    return transaction(
      actor,
      (q) =>
        mutation(q, actor, b.mutationId, ["entry", id, b], async () => {
          await owned(q, actor, id);
          const old = (await q.query("SELECT * FROM research_entries WHERE id=$1", [b.id])).rows[0];
          if (old && old.record_id !== id) throw W.fail("Entry unavailable", 404);
          if ((old?.revision || 0) !== b.revision) throw W.fail("Entry changed. Refresh before saving.", 409);
          const data = W.parse(W.entry, { ...old?.data, ...b.data });
          // Findings and conclusions are append-only. Only a question's state can be edited.
          if (old && Object.keys(b.data).some((k) => k !== "state"))
            throw W.fail("Append a new entry to preserve the original evidence", 409);
          if (data.supersedesId) {
            const prior = await q.query("SELECT id FROM research_entries WHERE id=$1 AND record_id=$2", [
              data.supersedesId,
              id
            ]);
            if (!prior.rows.length) throw W.fail("Superseded entry unavailable", 404);
          }
          await q.query(
            `INSERT INTO research_entries(id,record_id,data,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,revision=EXCLUDED.revision`,
            [b.id, id, data, b.revision + 1]
          );
          await history(q, actor, id, "entry", b.id, b.revision + 1, data);
          return { ...data, id: b.id, revision: b.revision + 1 };
        }),
      true
    );
  }
  async function activity(actor, input = {}) {
    const schema = require("zod").z.strictObject({
      id: W.uuid.optional(),
      offset: require("zod").z.int().min(0).max(100000).default(0),
      questions: require("zod").z.boolean().default(false)
    });
    const b = W.parse(schema, input);
    return transaction(actor, async (q) => {
      if (b.id) await owned(q, actor, b.id);
      const { rows } = b.questions
        ? await q.query(
            `SELECT e.*,l.data->>'title' AS record_title FROM research_entries e JOIN wishlists l ON l.id=e.record_id
        WHERE l.workspace_id=$1 AND l.user_id=$2 AND ($3::uuid IS NULL OR l.id=$3) AND e.data->>'entryType'='Question'
        AND COALESCE(e.data->>'state','Open')='Open' AND COALESCE((l.data->>'archived')::boolean,FALSE)=FALSE
        ORDER BY e.created_at,e.id LIMIT 51 OFFSET $4`,
            [actor.workspaceId, actor.userId, b.id || null, b.offset]
          )
        : await q.query(
            `SELECT h.*,l.data->>'title' AS record_title FROM wishlist_revisions h JOIN wishlists l ON l.id=h.wishlist_id
        WHERE l.workspace_id=$1 AND l.user_id=$2 AND ($3::uuid IS NULL OR l.id=$3)
        ORDER BY h.sequence DESC LIMIT 51 OFFSET $4`,
            [actor.workspaceId, actor.userId, b.id || null, b.offset]
          );
      return { entries: rows.slice(0, 50), nextOffset: rows.length > 50 ? b.offset + 50 : null };
    });
  }
  async function action(actor, id, input) {
    const b = W.parse(M.action, input);
    return transaction(
      actor,
      (q) =>
        mutation(q, actor, b.mutationId, ["action", id, b], async () => {
          const row = await owned(q, actor, id);
          if (row.data.archived) throw W.fail("Restore this record before creating work", 409);
          const store = createProjectStore(ctx);
          let created, relation;
          if (b.action === "project") {
            if (row.record_kind !== "idea") throw W.fail("Only ideas can be promoted to projects");
            const existing = (
              await q.query(
                `SELECT e.block_id FROM research_links e JOIN blocks b ON b.id=e.block_id WHERE e.from_id=$1 AND e.relation='project' AND e.active AND b.deleted_at IS NULL`,
                [id]
              )
            ).rows[0];
            if (existing) throw W.fail("This idea already has a project. Open the linked project.", 409);
            created = await store.createProject(
              {
                name: b.title || row.data.title,
                description: row.data.description || row.data.notes,
                source: { kind: "research", id }
              },
              actor,
              q
            );
            relation = "project";
            await wishlists({ ...ctx, transactionClient: q }).save(actor, id, "overview", null, {
              revision: row.revision,
              mutationId: randomUUID(),
              data: { lifecycle: "Active Project" }
            });
          } else {
            if (b.action === "purchase-task" && !["Selected", "To Buy"].includes(row.data.purchaseStatus))
              throw W.fail("Select this item before creating a purchase task", 409);
            if (b.action === "purchase-task" && !["product", "requirement"].includes(row.record_kind))
              throw W.fail("Choose an item or purchase requirement");
            const existing = (
              await q.query(
                `SELECT e.block_id FROM research_links e JOIN blocks t ON t.id=e.block_id
          WHERE e.from_id=$1 AND e.relation='task' AND e.active AND e.data->>'purpose'='purchase'
          AND t.deleted_at IS NULL AND COALESCE(t.properties->>'status','open')<>'done' AND t.properties->>'completedAt' IS NULL`,
                [id]
              )
            ).rows[0];
            if (b.action === "purchase-task" && existing) throw W.fail("An open purchase task already exists", 409);
            created = await store.createTask(
              {
                title: b.title || (b.action === "purchase-task" ? "Buy " : "Follow up: ") + row.data.title,
                source: "research",
                detail: recordUrl(id)
              },
              actor,
              q
            );
            relation = "task";
          }
          await q.query(`INSERT INTO research_links(id,from_id,block_id,relation,data) VALUES($1,$2,$3,$4,$5)`, [
            b.id,
            id,
            created.id,
            relation,
            { purpose: b.action === "purchase-task" ? "purchase" : "action" }
          ]);
          await history(q, actor, id, "action", b.id, 1, {
            action: b.action,
            blockId: created.id,
            title: created.properties?.title
          });
          return {
            id: created.id,
            title: created.properties?.title,
            kind: relation,
            url: relation === "project" ? projectUrl(created.id) : projectTaskUrl(created.id)
          };
        }),
      true
    );
  }
  return { create, save, search, get, link, entry, action, activity, forBlock, searchTasks: wishlist.searchTasks };
}
module.exports = { createStore };
