"use strict";

const syncStore = require("../sync-store");
const { compactState } = require("../state-projection");
const triageSuppressions = require("../triage-suppressions");
const MAX_RESOLUTION_EVENTS = 5000;

module.exports = function mountSyncRoutes(app, ctx) {
  const {
    blockDB, broadcast, buildDayResponse, getTodayStr, isValidDate,
    meetingMaterializer, readTriageSuppressionsForWorkspace, resolveOwnerStrict,
  } = ctx;

  app.get("/api/sync/bootstrap", async (req, res, next) => {
    try {
      const date = req.query.date || getTodayStr();
      if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const snapshot = await syncStore.bootstrap({ workspaceId, date });
      snapshot.dayState = await buildDayResponse(date, userId, workspaceId);
      res.json(snapshot);
    } catch (error) { next(error); }
  });

  app.get("/api/sync/pull", async (req, res, next) => {
    try {
      const date = req.query.date || getTodayStr();
      if (!isValidDate(date)) return res.status(400).json({ error: "Invalid date" });
      const { userId, workspaceId } = await resolveOwnerStrict(req);
      const delta = await syncStore.pull({
        workspaceId,
        date,
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      if (delta.dayStateChanged || req.query.includeState === "1") {
        delta.dayState = await buildDayResponse(date, userId, workspaceId);
      }
      delete delta.dayStateChanged;
      res.json(delta);
    } catch (error) {
      if (error && error.code === "cursor_expired") {
        return res.status(410).json({ error: error.message, code: error.code, reset: true });
      }
      next(error);
    }
  });

  app.get("/api/triage/history", async (req, res, next) => {
    try {
      const { workspaceId } = await resolveOwnerStrict(req);
      res.json(await syncStore.listTriageHistory(workspaceId, {
        before: req.query.before,
        limit: req.query.limit,
      }));
    } catch (error) { next(error); }
  });

  app.post("/api/ingest/day-state/v2", async (req, res) => {
    const body = req.body || {};
    const snapshot = body.snapshot || {};
    const date = body.date || snapshot.date;
    if (Number(body.schema_version || body.schemaVersion) !== 2) {
      return res.status(400).json({ ok: false, error: "schema_version must be 2" });
    }
    if (!isValidDate(date)) return res.status(400).json({ ok: false, error: "Invalid date" });
    const resolvedEvents = Array.isArray(body.resolved_events) ? body.resolved_events : [];
    if (resolvedEvents.length > MAX_RESOLUTION_EVENTS) {
      return res.status(413).json({ ok: false, error: `resolved_events cannot exceed ${MAX_RESOLUTION_EVENTS}` });
    }

    let owner;
    try { owner = await resolveOwnerStrict(req); }
    catch (error) { return res.status(error.status || 400).json({ ok: false, error: error.message }); }
    const { userId, workspaceId } = owner;
    const compact = compactState({ ...snapshot, date });
    compact.date = date;
    compact.last_updated_at = new Date().toISOString();
    compact.last_updated_by = snapshot.last_updated_by || "sweep-suite-v2";

    try {
      if (Array.isArray(snapshot.meetings) && meetingMaterializer) {
        const materialized = await meetingMaterializer.materializeMeetings({
          date,
          meetings: snapshot.meetings,
          userId,
          workspaceId,
          hasMeetingsKey: true,
        });
        if (materialized && materialized.blockIds && materialized.blockIds.length) {
          broadcast("blocks-changed", {
            action: "meeting-materialize",
            blockIds: materialized.blockIds,
            date,
          }, workspaceId);
        }
      }
      await blockDB.saveDccState(date, compact, userId, workspaceId);
    } catch (error) {
      console.error("[dcc-state v2] compact save failed:", error.message);
      return res.status(500).json({ ok: false, error: "db save failed: " + error.message });
    }

    let archivedResolutions = 0;
    try {
      archivedResolutions = await syncStore.recordTriageHistory(workspaceId, resolvedEvents);
    } catch (error) {
      console.error("[dcc-state v2] resolution history failed:", error.message);
      return res.status(500).json({ ok: false, error: "resolution history failed: " + error.message });
    }

    let suppressedResolutions = [];
    try {
      const suppressions = await readTriageSuppressionsForWorkspace(workspaceId);
      const index = triageSuppressions.suppressionIndex(suppressions);
      suppressedResolutions = (compact.triage.open_items || []).map((item) => {
        const suppression = triageSuppressions.matchingSuppression(item, index);
        if (!suppression || suppression.reason === "scheduled") return null;
        return {
          id: item.id,
          reason: suppression.reason || "done",
          resolved_at: suppression.at || "",
          conversation_id: triageSuppressions.triageConversationId(item),
          subject_key: triageSuppressions.SUBJECT_SCOPED_REASONS.has(suppression.reason)
            ? (triageSuppressions.subjectKeyForSuppression(suppression) || triageSuppressions.subjectKeyForItem(item))
            : "",
        };
      }).filter(Boolean);
    } catch (error) {
      console.error("[dcc-state v2] suppression reconciliation failed:", error.message);
    }

    broadcast("dcc-state-changed", { source: "day-state-v2", date }, workspaceId);
    return res.json({
      ok: true,
      date,
      acknowledged_source_cursor: body.source_cursor || null,
      suppressed_resolutions: suppressedResolutions,
      archived_resolutions: archivedResolutions,
      imported_resolutions: 0,
    });
  });
};
