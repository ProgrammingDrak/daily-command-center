const { createHash } = require("node:crypto");
const M = require("./lib/wishlist-model");
const { isLibraryTask, createProjectStore } = require("./project-store");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wishlists (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  attachment_block_id TEXT NOT NULL UNIQUE REFERENCES blocks(id),
  converted BOOLEAN NOT NULL DEFAULT FALSE,
  data JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wishlists_owner ON wishlists(workspace_id, user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS wishlist_records (
  wishlist_id UUID NOT NULL REFERENCES wishlists(id),
  kind TEXT NOT NULL CHECK (kind IN ('criteria','options','assessments','offers','research','tasks')),
  id UUID NOT NULL,
  data JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wishlist_id, kind, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS wishlist_assessment_pair ON wishlist_records
  (wishlist_id, (data->>'optionId'), (data->>'criterionId')) WHERE kind='assessments';
CREATE UNIQUE INDEX IF NOT EXISTS wishlist_task_link ON wishlist_records
  (wishlist_id, (data->>'taskId')) WHERE kind='tasks';
CREATE TABLE IF NOT EXISTS wishlist_offer_history (
  wishlist_id UUID NOT NULL,
  kind TEXT NOT NULL DEFAULT 'offers' CHECK (kind='offers'),
  offer_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  data JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wishlist_id, offer_id, revision),
  FOREIGN KEY (wishlist_id, kind, offer_id) REFERENCES wishlist_records(wishlist_id, kind, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS wishlist_mutations (
  wishlist_id UUID NOT NULL REFERENCES wishlists(id),
  id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  PRIMARY KEY (wishlist_id, id)
);
ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_offer_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_mutations ENABLE ROW LEVEL SECURITY;
`;

const references = {
  favoriteId: "options",
  optionId: "options",
  criterionId: "criteria",
  offerId: "offers",
  assessmentId: "assessments"
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordered = (data) => Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
const serialize = (row) => ({ ...row.data, id: row.id, revision: row.revision });
const normalize = (schema, data) => M.parse(schema, data);

function createStore({ pool, blockDB }) {
  async function transaction(run, read = false) {
    const q = await pool.connect();
    try {
      await q.query(read ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      const result = await run(q);
      await q.query("COMMIT");
      return result;
    } catch (error) {
      await q.query("ROLLBACK");
      if (error.code === "23505")
        throw M.fail("That assessment or task link already exists. Refresh and edit the existing record.", 409);
      throw error;
    } finally {
      q.release();
    }
  }

  async function owned(q, actor, id, lock = false) {
    const { rows } = await q.query(
      `SELECT l.* FROM wishlists l JOIN workspaces w ON w.id=l.workspace_id
      WHERE l.id=$1 AND l.workspace_id=$2 AND l.user_id=$3 AND w.owner_id=$3${lock ? " FOR UPDATE OF l" : ""}`,
      [id, actor.workspaceId, actor.userId]
    );
    if (!rows[0]) throw M.fail("Wishlist unavailable", 404);
    return rows[0];
  }

  async function findTask(q, actor, id, lock = false) {
    const { rows } = await q.query(
      `SELECT b.* FROM blocks b JOIN workspaces w ON w.id=b.workspace_id
      WHERE b.id=$1 AND b.workspace_id=$2 AND w.owner_id=$3 AND (b.user_id IS NULL OR b.user_id=$3)
      AND b.deleted_at IS NULL${lock ? " FOR UPDATE OF b" : ""}`,
      [id, actor.workspaceId, actor.userId]
    );
    const task = rows[0];
    if (!isLibraryTask(task, blockDB)) {
      throw M.fail("Task unavailable", 404);
    }
    return task;
  }

  async function list(actor) {
    const { rows } = await pool.query(
      `SELECT l.*, cover.id AS cover_id, concat_ws(' · ', favorite.data->>'title', NULLIF(favorite.data->>'variant', '')) AS favorite,
      next_task.title AS linked_next
      FROM wishlists l JOIN workspaces w ON w.id=l.workspace_id
      LEFT JOIN wishlist_records favorite ON favorite.wishlist_id=l.id AND favorite.kind='options'
        AND favorite.id::text=l.data->>'favoriteId'
      LEFT JOIN task_attachments cover ON cover.id::text=l.data->>'coverId' AND cover.block_id=l.attachment_block_id
        AND cover.workspace_id=l.workspace_id AND cover.user_id=l.user_id AND cover.deleted_at IS NULL AND cover.state='ready'
      LEFT JOIN LATERAL (
        SELECT COALESCE(b.properties->>'title', b.properties->>'text') AS title
        FROM wishlist_records r JOIN blocks b ON b.id=r.data->>'taskId'
        WHERE r.wishlist_id=l.id AND r.kind='tasks' AND b.workspace_id=l.workspace_id
          AND (b.user_id IS NULL OR b.user_id=l.user_id) AND b.deleted_at IS NULL
          AND COALESCE(b.properties->>'status','open')<>'done' AND b.properties->>'completedAt' IS NULL
        ORDER BY r.created_at, r.id LIMIT 1
      ) next_task ON true
      WHERE l.workspace_id=$1 AND l.user_id=$2 AND w.owner_id=$2
      ORDER BY l.updated_at DESC, l.id`,
      [actor.workspaceId, actor.userId]
    );
    return rows.map((row) => ({
      ...serialize(row),
      coverId: row.cover_id || null,
      favorite: row.favorite || null,
      nextAction: row.data.nextAction || row.linked_next || null
    }));
  }

  async function searchTasks(actor, query) {
    const search = typeof query === "string" ? query.trim().slice(0, 120) : "";
    if (!search) return [];
    const { rows } = await pool.query(
      `SELECT b.id, b.type, b.date::text, b.properties FROM blocks b JOIN workspaces w ON w.id=b.workspace_id
      WHERE b.workspace_id=$1 AND w.owner_id=$2 AND (b.user_id IS NULL OR b.user_id=$2)
      AND b.deleted_at IS NULL AND dcc_is_task_row(b.type,b.properties)
      AND strpos(lower(COALESCE(b.properties->>'title', b.properties->>'text')), lower($3))>0
      ORDER BY b.updated_at DESC LIMIT 40`,
      [actor.workspaceId, actor.userId, search]
    );
    return rows
      .filter((row) => isLibraryTask(row, blockDB))
      .map((row) => ({ id: row.id, title: row.properties.title || row.properties.text, date: row.date }));
  }

  async function get(actor, id) {
    return transaction(async (q) => {
      const row = await owned(q, actor, M.parse(M.uuid, id));
      const { rows } = await q.query("SELECT * FROM wishlist_records WHERE wishlist_id=$1 ORDER BY created_at,id", [
        id
      ]);
      const result = { ...serialize(row), converted: row.converted };
      for (const kind of Object.keys(M.records)) result[kind] = [];
      for (const record of rows) result[record.kind].push(serialize(record));
      const { rows: history } = await q.query(
        `SELECT offer_id AS "offerId", revision, data, recorded_at AS "recordedAt"
        FROM wishlist_offer_history WHERE wishlist_id=$1 ORDER BY recorded_at DESC, revision DESC`,
        [id]
      );
      result.offerHistory = history;
      if (row.converted) {
        const {
          rows: [original]
        } = await q.query("SELECT id, date, properties FROM blocks WHERE id=$1", [row.attachment_block_id]);
        const timeEntries = await blockDB.getTaskTimeEntries(original.id, actor.workspaceId, {}, q);
        const { rows: operations } = await q.query(
          "SELECT op_type AS action, timestamp FROM operations WHERE block_id=$1 ORDER BY id DESC LIMIT 50",
          [original.id]
        );
        result.original = {
          ...original,
          timeEntries: timeEntries.map(({ date, properties }) => ({ date, properties })),
          operations
        };
      }
      if (result.tasks.length) {
        const { rows: tasks } = await q.query(
          `SELECT id, COALESCE(properties->>'title',properties->>'text') AS title,
          date::text, properties->>'status' AS status
          FROM blocks WHERE workspace_id=$1 AND (user_id IS NULL OR user_id=$2)
          AND deleted_at IS NULL AND id=ANY($3::text[])`,
          [actor.workspaceId, actor.userId, result.tasks.map((task) => task.taskId)]
        );
        const byId = new Map(tasks.map((task) => [task.id, task]));
        result.tasks = result.tasks.map((task) => ({ ...task, task: byId.get(task.taskId) || null }));
      }
      return result;
    }, true);
  }

  async function create(actor, input) {
    const body = M.parse(M.create, input);
    const fingerprint = digest([body.title, body.taskId]);
    return transaction(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["wishlist-create:" + actor.workspaceId]);
      const {
        rows: [workspace]
      } = await q.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2", [actor.workspaceId, actor.userId]);
      if (!workspace) throw M.fail("Wishlist unavailable", 404);
      const {
        rows: [existing]
      } = await q.query("SELECT id, user_id, workspace_id FROM wishlists WHERE id=$1", [body.id]);
      if (existing) {
        await owned(q, actor, body.id);
        const {
          rows: [receipt]
        } = await q.query("SELECT fingerprint,result FROM wishlist_mutations WHERE wishlist_id=$1 AND id=$1", [
          body.id
        ]);
        if (receipt?.fingerprint !== fingerprint) throw M.fail("Creation identity already used", 409);
        return { ...receipt.result, duplicate: true };
      }

      let attachmentBlockId = "wishlist-files:" + body.id;
      let data = { title: body.title, stage: "Idea" };
      if (body.taskId) {
        const {
          rows: [previous]
        } = await q.query(
          `SELECT id FROM wishlists WHERE attachment_block_id=$1
          AND workspace_id=$2 AND user_id=$3 AND converted`,
          [body.taskId, actor.workspaceId, actor.userId]
        );
        if (previous) throw M.fail("This task already has a Wishlist", 409);
        await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["task-dependencies:" + actor.workspaceId]);
        await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["dcc-foreground:" + actor.userId]);
        const task = await findTask(q, actor, body.taskId, true);
        const p = task.properties;
        const {
          rows: [related]
        } = await q.query(
          `SELECT id FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL
          AND id<>$2 AND (parent_id=$2 OR properties->>'subtaskOf'=ANY($3::text[]) OR
          properties->>'wrapId'=ANY($3::text[]) OR properties->>'projectParentTaskId'=$2 OR (properties->>'kind'='delegated_item' AND
          (properties->>'blockerBlockId'=$2 OR properties->>'linkedBlockId'=$2)))
          AND type<>'time_entry' LIMIT 1`,
          [actor.workspaceId, task.id, [task.id, p.local_id].filter(Boolean)]
        );
        const {
          rows: [queue]
        } = await q.query(`SELECT state FROM work_rotations WHERE workspace_id=$1 AND user_id=$2`, [
          actor.workspaceId,
          actor.userId
        ]);
        const queueItem = queue?.state?.items?.[task.id];
        if (
          related ||
          p.subtaskOf ||
          p.wrapId ||
          p.startedAt ||
          p.recurrence ||
          p.repeat ||
          p.recurrenceId ||
          p.recurrenceRule ||
          p.repeatSeriesId ||
          p.responsibilityId ||
          p.kind === "meeting" ||
          p.projectRole === "parent" ||
          p.projectParentTaskId ||
          queueItem?.status === "foreground" ||
          ["meeting", "oneone", "guided"].includes(p.type)
        ) {
          throw M.fail("Resolve active work, recurring tasks, or linked tasks in DCC before converting this task", 409);
        }
        attachmentBlockId = task.id;
        data = {
          title: String(p.title || p.text)
            .trim()
            .slice(0, 300),
          stage: "Idea"
        };
        await blockDB.deleteBlock(task.id, q, "wishlist-convert:" + body.id);
      } else {
        await q.query(
          `INSERT INTO blocks(id,type,workspace_id,user_id,properties,created_at,updated_at)
          VALUES ($1,'wishlist_attachment',$2,$3,'{}',NOW(),NOW())`,
          [attachmentBlockId, actor.workspaceId, actor.userId]
        );
      }
      await q.query(
        `INSERT INTO wishlists(id, workspace_id, user_id, attachment_block_id, converted, data)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [body.id, actor.workspaceId, actor.userId, attachmentBlockId, !!body.taskId, data]
      );
      const result = { ...data, id: body.id, revision: 1, convertedTaskId: body.taskId || null };
      await q.query("INSERT INTO wishlist_mutations VALUES($1,$1,$2,$3)", [body.id, fingerprint, result]);
      return result;
    });
  }

  async function checkReferences(q, row, data) {
    for (const [key, kind] of Object.entries(references)) {
      if (!data[key]) continue;
      const { rows } = await q.query("SELECT id FROM wishlist_records WHERE wishlist_id=$1 AND kind=$2 AND id=$3", [
        row.id,
        kind,
        data[key]
      ]);
      if (!rows.length) throw M.fail("Linked record is unavailable in this Wishlist", 404);
    }
    for (const key of ["attachmentId", "coverId"]) {
      if (!data[key]) continue;
      const { rows } = await q.query(
        `SELECT id FROM task_attachments WHERE id=$1 AND block_id=$2
        AND user_id=$3 AND workspace_id=$4 AND deleted_at IS NULL AND state='ready'
        AND ($5::boolean IS FALSE OR mime IN ('image/png','image/jpeg','image/webp'))`,
        [data[key], row.attachment_block_id, row.user_id, row.workspace_id, key === "coverId"]
      );
      if (!rows.length) throw M.fail("Private attachment unavailable", 404);
    }
  }

  async function save(actor, id, kind, recordId, input) {
    const overview = kind === "overview";
    if (!overview && !Object.hasOwn(M.records, kind)) throw M.fail("Unknown record type");
    if (!overview) M.parse(M.uuid, recordId);
    const body = M.parse(M.envelope, input);
    const schema = overview ? M.overview : M.records[kind];
    const patch = normalize(schema.partial(), body.data);
    if (!Object.keys(patch).length) throw M.fail("Provide a field to update");
    const fingerprint = digest([kind, recordId || null, body.revision, ordered(patch)]);
    return transaction(async (q) => {
      const row = await owned(q, actor, M.parse(M.uuid, id), true);
      const {
        rows: [receipt]
      } = await q.query("SELECT fingerprint,result FROM wishlist_mutations WHERE wishlist_id=$1 AND id=$2", [
        id,
        body.mutationId
      ]);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw M.fail("Mutation identity already used", 409);
        return { ...receipt.result, duplicate: true };
      }
      const current = overview
        ? row
        : (
            await q.query("SELECT * FROM wishlist_records WHERE wishlist_id=$1 AND kind=$2 AND id=$3", [
              id,
              kind,
              recordId
            ])
          ).rows[0];
      if ((current?.revision || 0) !== body.revision)
        throw M.fail("This record changed. Refresh it before saving your edits.", 409);
      const data = normalize(schema, { ...current?.data, ...patch });
      if (overview) data.stage ||= "Idea";
      await checkReferences(
        q,
        row,
        Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== current?.data[key]))
      );
      if (current && ["assessments", "offers", "tasks"].includes(kind)) {
        for (const key of ["optionId", "criterionId", "taskId"]) {
          if (data[key] !== current.data[key]) throw M.fail("Create a new record for a different target", 409);
        }
      }
      if (kind === "tasks" && !current) await findTask(q, actor, data.taskId, true);
      const revision = body.revision + 1;
      if (overview) {
        await q.query("UPDATE wishlists SET data=$2,revision=$3,updated_at=NOW() WHERE id=$1", [id, data, revision]);
      } else {
        await q.query(
          `INSERT INTO wishlist_records(wishlist_id,kind,id,data,revision) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(wishlist_id,kind,id) DO UPDATE SET data=EXCLUDED.data,revision=EXCLUDED.revision`,
          [id, kind, recordId, data, revision]
        );
        await q.query("UPDATE wishlists SET updated_at=NOW() WHERE id=$1", [id]);
        if (
          kind === "offers" &&
          (!current ||
            [
              "price",
              "currency",
              "shipping",
              "taxes",
              "discount",
              "extras",
              "estimated",
              "availability",
              "checkedOn",
              "variant",
              "condition",
              "title"
            ].some((key) => (current.data[key] ?? null) !== (data[key] ?? null)))
        ) {
          await q.query("INSERT INTO wishlist_offer_history(wishlist_id,offer_id,revision,data) VALUES($1,$2,$3,$4)", [
            id,
            recordId,
            revision,
            data
          ]);
        }
      }
      const result = { ...data, id: recordId || id, revision };
      await q.query("INSERT INTO wishlist_mutations VALUES($1,$2,$3,$4)", [id, body.mutationId, fingerprint, result]);
      return result;
    });
  }

  async function addTask(actor, id, input) {
    const body = M.parse(M.linkNewTask, input);
    const fingerprint = digest(["new-linked-task", body.title, body.notes]);
    return transaction(async (q) => {
      await owned(q, actor, M.parse(M.uuid, id), true);
      const {
        rows: [receipt]
      } = await q.query("SELECT fingerprint,result FROM wishlist_mutations WHERE wishlist_id=$1 AND id=$2", [
        id,
        body.id
      ]);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw M.fail("Mutation identity already used", 409);
        return { ...receipt.result, duplicate: true };
      }
      const task = await createProjectStore({ blockDB, pool }).createTask(
        {
          title: body.title,
          source: "wishlist"
        },
        actor,
        q
      );
      const data = { taskId: task.id, notes: body.notes || null };
      await q.query("INSERT INTO wishlist_records(wishlist_id,kind,id,data) VALUES($1,'tasks',$2,$3)", [
        id,
        body.id,
        data
      ]);
      await q.query("UPDATE wishlists SET updated_at=NOW() WHERE id=$1", [id]);
      const result = {
        ...data,
        id: body.id,
        revision: 1,
        task: { id: task.id, title: body.title, date: null, status: "open" }
      };
      await q.query("INSERT INTO wishlist_mutations VALUES($1,$2,$3,$4)", [id, body.id, fingerprint, result]);
      return result;
    });
  }

  return { create, get, list, save, searchTasks, addTask };
}

module.exports = { createStore, SCHEMA_SQL };
