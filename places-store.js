const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const Model = require("./lib/places-model");
const Zones = require("./public/js/schedule-zones");
const { isLibraryTask } = require("./project-store");

const SCHEMA_SQL = readFileSync(join(__dirname, "migrations/013_places_experiences.sql"), "utf8");
const kinds = { place: "places", trip: "place_trips" };

function record(row) {
  return {
    ...row.data, id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.family_id ? { family: row.family_id } : { mergedInto: row.merged_into, attachmentSources: row.attachment_sources || [], mergedPlaceIds: row.merged_place_ids || [], hasAttachments: Boolean(row.attachment_block_id) })
  };
}

async function one(q, sql, args) { return (await q.query(sql, args)).rows[0]; }
function distinct(list) { return [...new Map(list.map(item => [Model.hash(item), item])).values()]; }
function blockFingerprint(block) { return Model.hash([block.date, block.parent_id, block.updated_at?.toISOString?.() || block.updated_at, block.properties]); }

function createStore({ pool, blockDB, APP_TIME_ZONE = "America/New_York" }) {
  async function owner(q, actor) {
    if (!await one(q, "SELECT 1 FROM workspaces WHERE id=$1 AND owner_id=$2", [actor.workspaceId, actor.userId]))
      throw Model.fail("Places are private to the workspace owner", 403);
  }

  async function get(q, actor, kind, id, revision) {
    const row = await one(q, `SELECT * FROM ${kinds[kind]} WHERE workspace_id=$1 AND user_id=$2 AND id=$3`,
      [actor.workspaceId, actor.userId, id]);
    if (!row) throw Model.fail("Record unavailable", 404);
    if (row.merged_into) throw Model.fail("This place was merged. Refresh the Places library.", 409);
    if (revision !== undefined && revision !== row.revision) throw Model.fail("This record changed in another session. Reload before saving.", 409);
    return row;
  }

  async function checkLinks(q, actor, links) {
    for (const link of links) {
      if (link.type === "task") {
        const block = await one(q, "SELECT * FROM blocks WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL", [link.id, actor.workspaceId]);
        if (!block || !isLibraryTask(block, blockDB)) throw Model.fail("Linked task unavailable", 404);
      } else {
        const id = Model.parse(Model.uuid, link.id);
        const row = await one(q, `SELECT w.id FROM wishlists w
          ${link.type === "research" ? "JOIN research_records r ON r.id=w.id" : ""}
          WHERE w.id=$1 AND w.workspace_id=$2 AND w.user_id=$3`, [id, actor.workspaceId, actor.userId]);
        if (!row) throw Model.fail("Linked Research or Wishlist record unavailable", 404);
      }
    }
  }

  async function placeMap(q, actor, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { rows } = await q.query("SELECT * FROM places WHERE workspace_id=$1 AND user_id=$2 AND id=ANY($3::uuid[]) AND merged_into IS NULL",
      [actor.workspaceId, actor.userId, unique]);
    if (rows.length !== unique.length) throw Model.fail("A linked place is unavailable. Reload the Places library.", 409);
    return new Map(rows.map(row => [row.id, record(row)]));
  }

  async function placeData(q, actor, id, value) {
    if (value.parents.length) {
      await placeMap(q, actor, value.parents);
      const cycle = await one(q, `WITH RECURSIVE ancestry(id) AS (
        SELECT unnest($1::uuid[])
        UNION
        SELECT child.value::uuid FROM ancestry a JOIN places p ON p.id=a.id
          CROSS JOIN LATERAL jsonb_array_elements_text(p.data->'parents') child(value)
          WHERE p.workspace_id=$2 AND p.user_id=$3
        ) SELECT 1 FROM ancestry WHERE id=$4`, [value.parents, actor.workspaceId, actor.userId, id]);
      if (cycle) throw Model.fail("A place cannot be its own ancestor", 409);
    }
    await checkLinks(q, actor, value.links);
  }

  async function insert(q, actor, kind, id, value, family = id) {
    const row = kind === "place"
      ? await one(q, "INSERT INTO places(id,workspace_id,user_id,data) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING *", [id, actor.workspaceId, actor.userId, value])
      : await one(q, "INSERT INTO place_trips(id,workspace_id,user_id,data,family_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING *",
        [id, actor.workspaceId, actor.userId, value, family]);
    if (!row) throw Model.fail("Identity already exists", 409);
    return record(row);
  }

  async function save(q, kind, row, value) {
    return record(await one(q, `UPDATE ${kinds[kind]} SET data=$2, revision=revision+1, updated_at=now() WHERE id=$1 RETURNING *`, [row.id, value]));
  }

  async function list(actor) {
    await owner(pool, actor);
    const [places, trips] = await Promise.all([
      pool.query(`SELECT p.*,
        ARRAY(SELECT id FROM places a WHERE a.workspace_id=p.workspace_id AND a.user_id=p.user_id AND a.merged_into=p.id AND a.attachment_block_id IS NOT NULL) AS attachment_sources,
        ARRAY(SELECT id FROM places a WHERE a.workspace_id=p.workspace_id AND a.user_id=p.user_id AND a.merged_into=p.id) AS merged_place_ids
        FROM places p WHERE workspace_id=$1 AND user_id=$2 AND merged_into IS NULL ORDER BY updated_at DESC,id`, [actor.workspaceId, actor.userId]),
      pool.query("SELECT * FROM place_trips WHERE workspace_id=$1 AND user_id=$2 ORDER BY updated_at DESC,id", [actor.workspaceId, actor.userId])
    ]);
    return { places: places.rows.map(record), trips: trips.rows.map(record) };
  }

  async function prepare(q, actor, row, start) {
    const dated = { ...row.data, mode: "Scheduled", start };
    const places = await placeMap(q, actor, dated.days.flatMap(day => day.stops.map(stop => stop.placeId)));
    const from = Zones.shiftDate(start, -2);
    const to = Zones.shiftDate(start, dated.days.length + 2);
    const blocks = await blockDB.getBlocksByDateRange(from, to, actor.workspaceId, q);
    const projections = (await q.query("SELECT * FROM place_trip_projections WHERE trip_id=$1", [row.id])).rows;
    const known = new Map(projections.map(p => [p.stop_id, p.block_id]));
    const projectedBlocks = (await q.query("SELECT * FROM blocks WHERE id=ANY($1::text[]) AND workspace_id=$2 AND deleted_at IS NULL",
      [projections.map(p => p.block_id).filter(Boolean), actor.workspaceId])).rows.map(blockDB.parseBlock);
    const days = Model.preview(dated, places, blocks, APP_TIME_ZONE, known);
    const orphaned = [];
    const candidates = days.flatMap(day => day.stops);
    for (const p of projections) {
      const stop = candidates.find(candidate => candidate.id === p.stop_id);
      const block = projectedBlocks.find(b => b.id === p.block_id);
      const edited = !block || blockFingerprint(block) !== p.applied_fingerprint;
      const completed = block?.properties.status === "done" || block?.properties.done || block?.properties.completedAt;
      if (!stop) {
        orphaned.push({ id: p.stop_id, blockId: p.block_id, title: block?.properties.title || "Removed activity", canRemove: !edited && !completed });
      } else {
        stop.blockId = p.block_id;
        if (edited) stop.issues.push("The existing DCC activity was moved, edited or removed. Resolve it in DCC before publishing.");
        else if (completed) stop.issues.push("This DCC activity is complete.");
      }
    }
    const approval = Model.hash({ id: row.id, revision: row.revision, start, zone: APP_TIME_ZONE, days, orphaned });
    return { days, orphaned, approval, appZone: APP_TIME_ZONE, tripZone: dated.zone, originalRevision: row.revision, projections };
  }

  async function review(actor, rawId, rawDate) {
    await owner(pool, actor);
    const row = await get(pool, actor, "trip", Model.parse(Model.uuid, rawId));
    const start = Model.parse(Model.date, rawDate || row.data.start);
    const { projections: _projections, ...result } = await prepare(pool, actor, row, start);
    return result;
  }

  async function publish(q, actor, row, input) {
    if (!row.data.start) throw Model.fail("Date this trip before publishing");
    const summary = await prepare(q, actor, row, row.data.start);
    if (summary.approval !== input.approval) throw Model.fail("The trip or schedule changed. Review a new preview.", 409);
    const stops = new Map(summary.days.flatMap(day => day.stops).map(stop => [stop.id, stop]));
    const chosen = [...new Set(input.stopIds)].map(id => stops.get(id));
    if (chosen.some(stop => !stop?.plan || stop.issues.length)) throw Model.fail("Selected activities have unresolved scheduling conflicts", 409);
    const written = [];
    for (const stop of chosen) {
      const properties = {
        kind: "task", type: "task", title: stop.title, detail: stop.notes, ...stop.plan.properties,
        source: "places", publicVisibility: "private", placeTripId: row.id, placeStopId: stop.id, ...(stop.placeId ? { placeId: stop.placeId } : {})
      };
      let block;
      if (stop.blockId) {
        const current = blockDB.parseBlock(await one(q, "SELECT * FROM blocks WHERE id=$1 AND deleted_at IS NULL AND workspace_id=$2 FOR UPDATE", [stop.blockId, actor.workspaceId]));
        const projection = summary.projections.find(p => p.stop_id === stop.id);
        if (!current || projection.applied_fingerprint !== blockFingerprint(current))
          throw Model.fail("A DCC activity changed. Review a new preview.", 409);
        const parent = await blockDB.ensureDayRoot(stop.plan.date, actor.userId, actor.workspaceId, q);
        block = await blockDB.updateBlock(stop.blockId, {
          date: stop.plan.date, parent_id: parent, properties: { ...current.properties, ...properties }
        }, q);
      } else {
        [block] = await blockDB.createItineraryTasks([{ date: stop.plan.date, properties }], actor, q);
      }
      await q.query(`INSERT INTO place_trip_projections(trip_id,stop_id,block_id,applied_fingerprint) VALUES($1,$2,$3,$4)
        ON CONFLICT (trip_id,stop_id) DO UPDATE SET applied_fingerprint=EXCLUDED.applied_fingerprint`,
        [row.id, stop.id, block.id, blockFingerprint(block)]);
      written.push(block.id);
    }
    return { id: row.id, blockIds: written };
  }

  async function unpublish(q, actor, row, input) {
    if (!row.data.start) throw Model.fail("Date this trip first");
    const summary = await prepare(q, actor, row, row.data.start);
    if (summary.approval !== input.approval) throw Model.fail("The trip or schedule changed. Review a new preview.", 409);
    const chosen = [...new Set(input.stopIds)].map(id => summary.orphaned.find(item => item.id === id));
    if (chosen.some(item => !item?.canRemove)) throw Model.fail("Choose unchanged activities removed from the trip", 409);
    for (const item of chosen) {
      const current = blockDB.parseBlock(await one(q, "SELECT * FROM blocks WHERE id=$1 AND deleted_at IS NULL AND workspace_id=$2 FOR UPDATE", [item.blockId, actor.workspaceId]));
      const projection = summary.projections.find(p => p.stop_id === item.id);
      if (!current || blockFingerprint(current) !== projection.applied_fingerprint) throw Model.fail("A DCC activity changed. Review a new preview.", 409);
      await blockDB.deleteBlock(item.blockId, q, "places-unpublish");
      await q.query("DELETE FROM place_trip_projections WHERE trip_id=$1 AND stop_id=$2", [row.id, item.id]);
    }
    return { id: row.id, blockIds: chosen.map(item => item.blockId) };
  }

  async function merge(q, actor, target, input) {
    if (target.id === input.sourceId) throw Model.fail("Choose a different place to merge");
    const source = await get(q, actor, "place", input.sourceId, input.sourceRevision);
    const next = { ...target.data };
    for (const key of ["sources", "geometries", "evidence", "tags", "collections", "visits", "companions", "links"])
      next[key] = distinct([...next[key], ...source.data[key]]);
    for (const key of ["notes", "description", "originalText"])
      next[key] = [...new Set([next[key], source.data[key]].filter(Boolean))].join("\n\n");
    next.availability = [...new Map([...(source.data.availability || []), ...(next.availability || [])].map(item => [item.date, item])).values()];
    next.parents = distinct([...next.parents, ...source.data.parents]).filter(id => id !== source.id && id !== target.id);
    const value = Model.parse(Model.place, next);
    await placeData(q, actor, target.id, value);
    const maybeChildren = (await q.query("SELECT * FROM places WHERE workspace_id=$1 AND user_id=$2 AND merged_into IS NULL AND id<>$3 AND id<>$4 AND data->'parents' ? ($4::uuid::text)",
      [actor.workspaceId, actor.userId, target.id, source.id])).rows;
    const updated = await save(q, "place", target, value);
    for (const child of maybeChildren) {
      const next = { ...child.data, parents: [...new Set(child.data.parents.map(id => id === source.id ? target.id : id))] };
      await placeData(q, actor, child.id, next);
      await save(q, "place", child, next);
    }
    const trips = (await q.query("SELECT * FROM place_trips WHERE workspace_id=$1 AND user_id=$2 AND data @> $3",
      [actor.workspaceId, actor.userId, { days: [{ stops: [{ placeId: source.id }] }] }])).rows;
    for (const t of trips) {
      const data = t.data;
      for (const day of data.days) for (const stop of day.stops) if (stop.placeId === source.id) stop.placeId = target.id;
      await save(q, "trip", t, data);
    }
    await q.query("UPDATE places SET merged_into=$1,revision=revision+1,updated_at=now() WHERE workspace_id=$2 AND user_id=$3 AND (id=$4 OR merged_into=$4)",
      [target.id, actor.workspaceId, actor.userId, source.id]);
    return updated;
  }

  async function change(q, actor, input) {
    if (input.action === "place-collect") {
      let count = 0;
      for (const item of input.items) {
        const place = await get(q, actor, "place", item.id, item.revision);
        if (place.data.collections.includes(input.collection)) continue;
        if (place.data.collections.length >= 50) throw Model.fail("A selected place already has 50 collections.", 409);
        await save(q, "place", place, { ...place.data, collections: [...place.data.collections, input.collection] });
        count++;
      }
      return { count };
    }
    const kind = input.kind || (input.action.startsWith("place") ? "place" : "trip");
    const { id, value } = input;
    const row = input.action.endsWith("-create") ? null : await get(q, actor, kind, id, input.revision);
    if (value) {
      if (kind === "place") {
        if (row) {
          value.sources = distinct([...row.data.sources, ...value.sources]);
          value.originalText = row.data.originalText || value.originalText;
        }
        if (value.sources.length > 100) throw Model.fail("A place can hold at most 100 distinct source references", 409);
        await placeData(q, actor, id, value);
      } else {
        await placeMap(q, actor, value.days.flatMap(day => day.stops.map(stop => stop.placeId)));
        await checkLinks(q, actor, value.links);
        if (row && (value.mode !== row.data.mode || value.start !== row.data.start))
          throw Model.fail("Choose Schedule this trip to change the planning mode");
        if (!row && value.mode !== "Hypothetical") throw Model.fail("Create a draft before scheduling your trip");
      }
      return row ? save(q, kind, row, value) : insert(q, actor, kind, id, value);
    }
    switch (input.action) {
      case "place-merge":
        return merge(q, actor, row, input);
      case "trip-copy": {
        const placeIds = row.data.days.flatMap(day => day.stops.map(stop => stop.placeId));
        const places = await placeMap(q, actor, placeIds);
        return insert(q, actor, kind, randomUUID(), Model.copy(row.data, input.version, input.strategy, places), row.family_id);
      }
      case "trip-date": {
        const dated = { ...row.data, mode: "Scheduled", start: input.date };
        return input.asCopy ? insert(q, actor, kind, randomUUID(), Model.copy(dated, "Dated copy", "duplicate"), row.family_id)
          : save(q, kind, row, dated);
      }
      case "trip-publish":
        return publish(q, actor, row, input);
      case "trip-unpublish":
        return unpublish(q, actor, row, input);
      case "linked-task": {
        if (row.data.links.length >= 60) throw Model.fail("This record already has 60 links", 409);
        const properties = { title: input.title, kind: "task", type: "task", source: "places", publicVisibility: "private", [kind === "place" ? "placeId" : "placeTripId"]: id,
          ...(input.date ? { placement: "unplanned", untimed: true } : {}) };
        const block = input.date ? (await blockDB.createItineraryTasks([{ date: input.date, properties }], actor, q))[0]
          : await blockDB.createBlock({ type: "block", date: null, properties, user_id: actor.userId, workspace_id: actor.workspaceId }, q);
        const linked = await save(q, kind, row, { ...row.data, links: [...row.data.links, { type: "task", id: block.id }] });
        return { ...linked, blockIds: [block.id] };
      }
    }
  }

  async function mutate(actor, rawId, body) {
    const requestId = Model.parse(Model.uuid, rawId);
    const input = Model.parse(Model.mutation, body);
    const fingerprint = Model.hash(input);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await owner(client, actor);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [actor.workspaceId]);
      const prior = await one(client, "SELECT fingerprint,result FROM place_mutations WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",
        [actor.workspaceId, actor.userId, requestId]);
      if (prior && prior.fingerprint !== fingerprint) throw Model.fail("Mutation identity was already used with different inputs", 409);
      const result = prior ? prior.result : await change(client, actor, input);
      if (!prior) await client.query("INSERT INTO place_mutations(workspace_id,user_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)",
        [actor.workspaceId, actor.userId, requestId, fingerprint, result]);
      await client.query("COMMIT");
      return prior ? { ...result, replayed: true } : result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async function proposal(actor, rawId, strategy) {
    if (strategy === "duplicate" || !Model.strategies.includes(strategy)) throw Model.fail("Choose a supported alternative");
    await owner(pool, actor);
    const row = await get(pool, actor, "trip", Model.parse(Model.uuid, rawId));
    const places = await placeMap(pool, actor, row.data.days.flatMap(day => day.stops.map(stop => stop.placeId)));
    const labels = { relaxed: "Relaxed", shorter: "Shorter", nearby: "Nearby stops", budget: "Budget-conscious", outdoors: "More outdoors", food: "Food-focused" };
    return { ...Model.copy(row.data, labels[strategy], strategy, places), strategy, originalRevision: row.revision };
  }

  async function routeInputs(actor, rawId, dayIndex, mode) {
    await owner(pool, actor);
    const row = await get(pool, actor, "trip", Model.parse(Model.uuid, rawId));
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || !row.data.days[dayIndex]) throw Model.fail("Choose a trip day");
    if (!Model.modes.includes(mode)) throw Model.fail("Choose a transport mode");
    const stops = row.data.days[dayIndex].stops;
    if (stops.length < 2 || stops.length > 25) throw Model.fail("Live routing requires 2–25 mapped stops on one day");
    const places = await placeMap(pool, actor, stops.map(stop => stop.placeId));
    const points = stops.map(stop => {
      const place = places.get(stop.placeId);
      const geometry = place?.geometries.find(entry => entry.shape.type === "Point");
      return geometry?.shape.coordinates;
    });
    if (points.some(point => !point)) throw Model.fail("Choose a point for every stop before routing this day.", 422);
    return { points, mode, stopIds: stops.map(stop => stop.id), revision: row.revision };
  }

  async function related(actor, rawQuery) {
    await owner(pool, actor);
    const query = String(rawQuery || "").trim().slice(0, 120);
    if (!query) return [];
    const term = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
    const [taskResult, wishlistResult] = await Promise.all([
      pool.query("SELECT * FROM blocks WHERE workspace_id=$1 AND deleted_at IS NULL AND properties->>'title' ILIKE $2 ORDER BY updated_at DESC LIMIT 40", [actor.workspaceId, term]),
      pool.query(`SELECT w.id,w.data->>'title' AS title,r.id IS NOT NULL AS research FROM wishlists w
        LEFT JOIN research_records r ON r.id=w.id WHERE w.workspace_id=$1 AND w.user_id=$2 AND w.data->>'title' ILIKE $3 LIMIT 20`,
        [actor.workspaceId, actor.userId, term])
    ]);
    return taskResult.rows.filter(row => isLibraryTask(row, blockDB)).map(row => ({ id: row.id, title: row.properties.title, type: "task" }))
      .concat(wishlistResult.rows.map(row => ({ id: row.id, title: row.title, type: row.research ? "research" : "wishlist" })));
  }

  return { list, mutate, review, proposal, related, routeInputs, authorize: actor => owner(pool, actor) };
}

module.exports = { createStore, SCHEMA_SQL };
