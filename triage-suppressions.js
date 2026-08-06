// ======== TRIAGE SUPPRESSIONS ========
//
// The durable, date-independent record of "I already handled this triage item".
//
// Two defects made triage look untouched on any surface that did not happen to be
// the tab you cleared it in:
//
//   1. "Gone" was stored on the day_root BLOCK for the date you were looking at
//      (`_dismissed` / `_triageDeleted` / `_triageScheduled`). Clearing 19 items on
//      2026-08-04 wrote 19 ids onto day-root-ws-1-2026-08-04 and nothing onto the
//      2026-08-05 root, so the next morning every one of them was back. A phone
//      opening a fresh day saw the raw list, which is what surfaced this.
//
//   2. Deleting an item POSTed the whole client `__state` to /api/ingest/day-state
//      with the item stripped from `triage.open_items` and appended to
//      `triage.deleted_items`. But `deleted_items` was written by the frontend and
//      read by NOTHING: `mergeOpenItems` only ever dropped items marked
//      status:"resolved" (which no reader sets) or aged out. `triage` is a
//      full-replace section in that ingest route, so the next Sweep Suite publish
//      overwrote the section wholesale and every deletion evaporated. On prod that
//      showed as 2026-08-04 holding `_triageDeleted: 19` on its day_root while the
//      same day's state carried `deleted_items: 0` and a full 21-item open list,
//      last written by "scheduled-task".
//
// So suppression cannot live in the day state at all: the sweep owns that section
// and replaces it. It lives in its own dateless rows instead
// (type="block", properties.kind="triage_suppression"), which are workspace-scoped,
// survive every publish, and belong to no single date.
//
// They are applied on the READ path only (buildDayResponse), never before a write.
// Filtering at the ingest door too was tried and reverted: it strips the item out of
// stored state, so undoing the suppression restores nothing. Storage stays raw and
// complete; exactly one place decides what a client sees.
//
// Pure module, no DB or express imports, so the tests can require() it under plain
// node the way dcc-intelligence.js's do.

const SUPPRESSION_KIND = "triage_suppression";

const SNAPSHOT_STRING_FIELDS = {
  id: 300,
  type: 80,
  source: 80,
  source_id: 300,
  title: 220,
  summary: 1000,
  priority: 40,
  source_ref: 1000,
  link: 1000,
  link_label: 80,
  action_label: 80,
  draft_id: 300,
  draft_type: 40,
  draft_link: 1000,
  draft_url: 1000,
  draft_preview: 1000,
  received_at: 80,
  conversation_id: 300,
  thread_id: 300,
};

function clipped(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function gmailConversationIdFromItemId(id) {
  const text = String(id || "");
  if (!text.startsWith("gmail:")) return "";
  const parts = text.split(":");
  return parts.length >= 2 ? parts[1] : "";
}

function triageConversationId(item) {
  if (!item) return "";
  return clipped(
    item.conversation_id || item.conversationId || item.thread_id || item.threadId
      || gmailConversationIdFromItemId(item.id),
    300
  );
}

function triageReceivedAt(item) {
  if (!item) return "";
  return clipped(item.received_at || item.receivedAt || "", 80);
}

// Persist only the fields needed to render a completed row or restore an item after
// Undo. The source payload is third-party data and Express accepts a 5 MB body, so a
// raw object copy would turn every suppression into an unbounded durable blob.
function snapshotTriageItem(item) {
  const source = item && typeof item === "object" ? item : {};
  const out = {};
  for (const [field, max] of Object.entries(SNAPSHOT_STRING_FIELDS)) {
    let value = source[field];
    if (field === "received_at") value = triageReceivedAt(source);
    if (field === "conversation_id") value = triageConversationId(source);
    if (value !== undefined && value !== null && value !== "") out[field] = clipped(value, max);
  }
  for (const field of ["estimated_minutes", "duration_minutes", "durationMinutes", "durMin"]) {
    const n = Number(source[field]);
    if (Number.isFinite(n) && n >= 0) out[field] = n;
  }
  return out;
}

// The identity of a triage item, and it MUST stay byte-identical to the key
// mergeOpenItems builds — a suppression that keys differently than the merge does
// is a suppression that never matches. dcc-intelligence.js imports this rather
// than keeping its own copy, which is the only reason the two can't drift.
//
// Note what live items actually carry: prod open_items have `id` and `type` and NO
// `source`/`source_id` at all (e.g. {id: "gmail:19f3d0b61ba384a8", type: "email"}),
// so the real-world key is "email|gmail:19f3d0b61ba384a8". The source/source_id
// arms are for reader output that has been through normalizeTriageItem.
function triageItemKey(item) {
  if (!item) return "";
  const source = item.source || item.type || "unknown";
  const id = item.source_id || item.id || item.title || "";
  return `${source}|${id}`;
}

// A suppression matches an item on EITHER the composite key or the bare id.
// Belt and braces on purpose: the composite key is what the merge dedupes on, but
// it is built from fields the sweep controls, and a reader that starts emitting
// `source` where it used to emit only `type` would silently change every key and
// resurrect the entire backlog. The bare id is the client's handle and is stable
// across that change.
function suppressionIndex(suppressions) {
  const keys = new Map();
  const ids = new Map();
  const gmailCutoffs = new Map();
  for (const s of suppressions || []) {
    if (!s || s.active === false) continue;
    if (s.key) keys.set(s.key, s);
    if (s.triage_id) ids.set(s.triage_id, s);
    // Before Sweep Suite gained message-level Gmail ids, a handled turn was stored as
    // gmail:<thread>. Treat that legacy row as a time cutoff, not a permanent thread
    // tombstone: old messages stay dead, but a later inbound turn is allowed through.
    if (/^gmail:[^:]+$/.test(String(s.triage_id || "")) && s.at) {
      const conversationId = gmailConversationIdFromItemId(s.triage_id);
      if (!gmailCutoffs.has(conversationId)) gmailCutoffs.set(conversationId, []);
      gmailCutoffs.get(conversationId).push(s);
    }
  }
  return { keys, ids, gmailCutoffs };
}

function matchingSuppression(item, index) {
  if (!item || !index) return false;
  if (index.ids.size && item.id && index.ids.has(item.id)) return index.ids.get(item.id);
  const key = triageItemKey(item);
  if (index.keys.size && index.keys.has(key)) return index.keys.get(key);

  const conversationId = triageConversationId(item);
  const receivedAt = Date.parse(triageReceivedAt(item));
  if (!conversationId || Number.isNaN(receivedAt)) return null;
  const cutoffs = index.gmailCutoffs && index.gmailCutoffs.get(conversationId);
  if (!cutoffs) return null;
  return cutoffs
    .filter((s) => {
      const cutoff = Date.parse(s.at);
      return !Number.isNaN(cutoff) && receivedAt <= cutoff;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
}

function isSuppressed(item, index) {
  return !!matchingSuppression(item, index);
}

// Strip suppressed items out of a triage section and hand back what was stripped.
//
// `suppressed_items` rides along because the client still has to render the
// "Completed" list and offer Undo, and it can no longer derive that from open_items:
// the whole point is that a handled item is gone from open_items on every device.
//
// The two halves are scoped DIFFERENTLY, and the asymmetry is the load-bearing part:
//
//   open_items       is filtered against EVERY suppression, forever. An item handled
//                    three months ago must still be filtered out of today's list, so
//                    narrowing this input would resurrect exactly what the feature
//                    exists to bury.
//
//   suppressed_items is filtered to the day being read. It feeds one thing, the
//                    "Completed" list on a single day's view, and that list is
//                    day-scoped everywhere else (the local overlay it merges with
//                    lives under a date-stamped localStorage key). Shipping the
//                    unbounded set instead made Completed accumulate every item ever
//                    handled, on every date including past ones, and had the client
//                    mint a DOM row plus a fresh click listener per entry on every
//                    render.
//
// Returns a NEW object; the caller's triage is not mutated.
// Which LOCAL day a suppression belongs to.
//
// Not a `.slice(0, 10)` on the ISO string, which is the shape this started as and is
// wrong by one day for a third of every evening: `at` is a UTC instant
// (`new Date().toISOString()`), while the date being read is the app's local calendar
// day (server.js getTodayStr formats in APP_TIME_ZONE, default America/New_York). An
// item handled at 21:30 ET on the 5th stores "2026-08-06T01:30:00Z", so the UTC slice
// files it under the 6th: it vanishes from the 5th's Completed list (losing its Undo)
// and cannot be recovered from the 6th either, because the CLIENT re-filters with
// triageCompletionDateKey, which converts the same instant back to local time.
//
// `at` is also normalized rather than trusted: suppressionFromBlock falls back to the
// row's created_at, and node-postgres hands back timestamptz as a Date, whose String()
// is "Wed Aug 06 ..." and would never match a YYYY-MM-DD.
function suppressionDayKey(at, opts) {
  if (!at) return "";
  const tz = opts && opts.timeZone;
  const d = at instanceof Date ? at : new Date(at);
  if (isNaN(d.getTime())) return String(at).slice(0, 10);
  if (!tz) return d.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function applyTriageSuppressions(triage, suppressions, opts) {
  const base = triage && typeof triage === "object" ? triage : {};
  const list = Array.isArray(suppressions) ? suppressions : [];
  if (!list.length) return { ...base, suppressed_items: [] };
  const index = suppressionIndex(list);
  const openItems = Array.isArray(base.open_items) ? base.open_items : [];
  const date = (opts && opts.date) || base.date || "";
  // No date to scope by means hand back the full list rather than silently an empty
  // one: a missing Completed list is a lost Undo, which is worse than a long one.
  const forDay = date ? list.filter((s) => suppressionDayKey(s && s.at, opts) === date) : list;
  return {
    ...base,
    open_items: openItems.filter((item) => !isSuppressed(item, index)),
    suppressed_items: forDay,
  };
}

// A publish owns its source-derived triage list, with one deliberate exception:
// Undo may restore a saved snapshot after the source has already reconciled that
// exact id into resolved_items. Keep those explicitly reopened rows until the
// user handles them again. Incoming facts still refresh a matching row.
function mergeTriageForIngest(existing, incoming) {
  const previous = existing && typeof existing === "object" ? existing : {};
  const next = incoming && typeof incoming === "object" ? incoming : {};
  const reopened = (Array.isArray(previous.open_items) ? previous.open_items : [])
    .filter((item) => item && item._dcc_reopened === true);
  const byId = new Map(reopened.map((item) => [String(item.id || triageItemKey(item)), item]));
  for (const item of Array.isArray(next.open_items) ? next.open_items : []) {
    if (!item) continue;
    const id = String(item.id || triageItemKey(item));
    byId.set(id, { ...(byId.get(id) || {}), ...item });
  }
  const reopenedIds = new Set(reopened.map((item) => String(item.id || "")));
  return {
    ...previous,
    ...next,
    open_items: Array.from(byId.values()),
    resolved_items: (Array.isArray(next.resolved_items) ? next.resolved_items : [])
      .filter((item) => !reopenedIds.has(String(item && item.id || ""))),
  };
}

// Shape a suppression row for storage. `title` is deliberately NOT stored under a
// `title` property: these are dateless type="block" rows, and TaskModel's
// selectUnscheduled treats a dateless titled block as BACKLOG WORK. Storing the
// title as `title` would file every handled triage item into Drake's backlog. It
// goes in `itemTitle`, which no selector reads.
// Every field is String()-coerced and clamped. These rows are durable and unbounded
// in count, and they are read back on the day path, so an unclamped value is not
// merely untidy: a non-string would persist as nested JSON, and the global
// express.json({limit:"5mb"}) would let one request store a multi-megabyte title that
// then rides along on day reads. The 220/1000 limits match what the repo already
// applies to the same two fields in routes/social-todo.js.
function buildSuppressionProperties({ triageId, key, itemTitle, reason, note, at, trivial, conversationId, receivedAt, itemSnapshot }) {
  const snapshot = snapshotTriageItem(itemSnapshot);
  return {
    kind: SUPPRESSION_KIND,
    triage_id: String(triageId || "").trim().slice(0, 300),
    key: String(key || "").trim().slice(0, 300),
    itemTitle: String(itemTitle || "").trim().slice(0, 220),
    reason: reason === "deleted" ? "deleted" : "done",
    // A trivial dismissal ("not worth it") is handled, but it is NOT completed work.
    // completedTriageTasksForDate drops it, and that check used to read the local
    // overlay -- which the phone does not have. Without persisting the flag, a trivial
    // dismissal on the laptop showed up on the phone as done work, in the Done tab and
    // in the day's actual/planned totals, so the two devices disagreed about the day.
    trivial: !!trivial,
    note: String(note || "").trim().slice(0, 1000),
    at: String(at || new Date().toISOString()),
    conversation_id: clipped(conversationId || triageConversationId(snapshot), 300),
    received_at: clipped(receivedAt || triageReceivedAt(snapshot), 80),
    itemSnapshot: snapshot,
    active: true,
    reopenedAt: "",
  };
}

// Read side: turn stored blocks back into the flat records the state section and
// the client both speak.
function suppressionFromBlock(block) {
  if (!block) return null;
  const p = block.properties || {};
  if (p.kind !== SUPPRESSION_KIND) return null;
  return {
    block_id: block.id,
    triage_id: p.triage_id || "",
    key: p.key || "",
    title: p.itemTitle || "",
    reason: p.reason || "done",
    trivial: !!p.trivial,
    note: p.note || "",
    conversation_id: p.conversation_id || "",
    received_at: p.received_at || "",
    item: p.itemSnapshot && typeof p.itemSnapshot === "object" ? p.itemSnapshot : {},
    active: p.active !== false && !block.deleted_at,
    reopened_at: p.reopenedAt || "",
    // created_at arrives from node-postgres as a Date; ISO-normalize so every consumer
    // (and suppressionDayKey) sees one shape.
    at: p.at || (block.created_at instanceof Date ? block.created_at.toISOString() : block.created_at) || "",
  };
}

function suppressionsFromBlocks(blocks) {
  return (blocks || []).map(suppressionFromBlock).filter((s) => s && s.active);
}

module.exports = {
  SUPPRESSION_KIND,
  triageItemKey,
  suppressionDayKey,
  suppressionIndex,
  matchingSuppression,
  isSuppressed,
  applyTriageSuppressions,
  buildSuppressionProperties,
  suppressionFromBlock,
  suppressionsFromBlocks,
  gmailConversationIdFromItemId,
  triageConversationId,
  triageReceivedAt,
  snapshotTriageItem,
  mergeTriageForIngest,
};
