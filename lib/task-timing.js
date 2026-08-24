// lib/task-timing.js — the ⌛→✅ duration ledger for a task: actualMinutes, the
// "⏱ Took ~Nm" note, and the deterministic `<blockId>-slacktimer` time_entry
// segment Day Review's planned-vs-actual reads.
//
// Extracted from routes/slack-events.js `handleDone` (dcc-canonical-task-model,
// Phase E1). The move is verbatim: same arithmetic, same note wordings, same
// time_entry id and properties. The pre-existing slack-events tests pass against
// it unmodified — that is the extraction's proof.
//
// WHY IT LEFT THE WEBHOOK. A ⌛ timer could only ever be closed by the ✅
// reaction, so `🔖 → ⌛ → check it off in the DCC UI` recorded no time at all.
// Completion is persisted in several places today — the row (`routes/dcc.js`
// quick-task, `routes/slack-events.js`) and the `day_root.properties._done`
// overlay (the browser) — and centralizing that is Phase C5's job, not this
// module's. So the timer is settled the way Track D settles a recurring instance:
// DERIVED ON READ. `reconcileTiming` runs on the itinerary day AND range GETs
// (`routes/blocks.js`), finds any done row still carrying a `startedAt` with no
// `actualMinutes`, and finalizes it. No writer is hooked and no Track C file is
// touched. Once C5 makes row status universal this becomes a no-op and C5
// deletes it.
//
// A derived stamp is REVERSIBLE, which is the difference between this and a
// writer hook. Anything reconcileTiming stamps is marked
// `actualMinutesFrom: "reconcile"`, so (a) un-checking a task it had settled
// clears the derived minutes again on the next read, and (b) a real ⌛→✅
// measurement is allowed to overwrite the derived guess. Without that a single
// accidental check-off would freeze a wrong duration in place forever, because
// finalizeTiming otherwise treats the first stamp as final.
//
// Layering follows responsibility-store.js: pure helpers are module-level
// exports (no DB, no HTTP, unit-testable), and everything that persists comes
// from createTaskTiming(). It reads through the injected `blockDB` wherever a
// primitive exists, and takes `pool` for exactly one statement the store layer
// has no primitive for (the timer row's hard delete). Note that this file trips
// the CI DB-risk guardrail's KEYWORD_RX on that `DELETE FROM`, independent of
// path, so its squash commit needs a `[db-ok]` tag.

const TIMER_ID_SUFFIX = "-slacktimer";
const TIMER_NOTE = "Slack ⌛→✅ timer";
const DERIVED_FLAG = "reconcile";
// A task whose minutes a HUMAN moved elsewhere. Distinct from DERIVED_FLAG because
// the reconciler must never re-derive over it: deleting actualMinutesFrom outright
// drops the row out of the derived branch of reconcileTiming's candidate filter and
// into the "startedAt with no actualMinutes" branch, which re-invents the very
// minutes the reallocation just moved away and re-mints their timer row. The time
// would then exist twice: once as the destination's segment, once as the origin's
// row-level projection. startWork clears it, so a genuinely new timer still settles.
const REALLOCATED_FLAG = "reallocated";
// Operation bookkeeping, stripped from any property bag carried onto a SUCCESSOR row:
// it describes the operation that produced the predecessor. Left in place, a chained
// reallocation inherited the previous operation's id and answered for the wrong one.
// The list keeps the retired resume fields so a row written by an older build is
// cleaned as it passes through rather than carrying dead state forward forever.
const REALLOC_BOOKKEEPING = [
  "reallocationOperationId", "reallocationSettledAt", "reallocationPriorTotals",
  "reallocationTouchedIds", "reallocationKeptSource", "movedToEntryIds",
];
// A ⌛ left running across days is a forgotten reaction, not 40 hours of work.
// The webhook path never had to care (a human pressed ✅), but reconcileTiming
// closes timers it finds lying around, so it needs a ceiling.
const MAX_TIMED_MINUTES = 16 * 60;
// Rows reconciled per read. A range read can span the entire archive, and each
// settle is several serial writes inside a GET the UI awaits.
const MAX_ROWS_PER_READ = 25;
// Pieces one segment may be cut into per reallocation. A ceiling, not a target:
// the request is client-supplied, and every piece is several serial writes.
const MAX_ALLOCATION_PARTS = 12;
const crypto = require("crypto");
const TaskTypes = require("../public/js/task-types");
const { localKeyToInstant, instantToLocalKey } = require("./scheduled-recurrence");
const { scoreTaskPoints } = require("../slot-scoring");
const { measuredTaskWindow } = require("../public/js/measured-task-window");

// ── Pure helpers ──────────────────────────────────────────────────────────────

// The `_done` overlay the browser writes to day_root: { ids: [...], at: { id: iso } }.
// Both halves are authoritative — `at` can carry an id `ids` never got (see
// routes/social-todo.js, which unions them the same way).
function doneIdsFromOverlay(dayRootProps) {
  const done = (dayRootProps && dayRootProps._done) || {};
  return new Set([
    ...(done.ids || []).map(String),
    ...Object.keys(done.at || {}).map(String),
  ]);
}

// A row is addressed by its DB id OR its client-minted local_id, depending on
// which surface completed it. Both are candidate overlay keys.
function blockIdentityKeys(block) {
  const props = (block && block.properties) || {};
  return [block && block.id, props.local_id].filter(Boolean).map(String);
}

// Done anywhere: on the row itself (Slack ✅, quick-task) or in the day overlay
// (the browser check-off). Deliberately generous — a false "open" leaves a timer
// unclosed, which is the bug this phase exists to fix.
function isBlockDone(block, dayRootProps) {
  const props = (block && block.properties) || {};
  if (props.status === "done" || props.done === true || props.completed === true) return true;
  if (props.completedAt || props.doneAt) return true;
  const doneIds = doneIdsFromOverlay(dayRootProps);
  if (!doneIds.size) return false;
  return blockIdentityKeys(block).some(k => doneIds.has(k));
}

// When did it finish? Prefer a real timestamp over `now`: reconciling a row that
// was checked off yesterday must not bill every hour since. Returns null when no
// timestamp is derivable — the caller skips rather than guesses.
function completionMsOf(block, dayRootProps) {
  const props = (block && block.properties) || {};
  const at = ((dayRootProps && dayRootProps._done) || {}).at || {};
  const candidates = [
    props.completedAt, props.doneAt,
    ...blockIdentityKeys(block).map(k => at[k]),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Drop the "⏱ …" line(s) this module wrote, leave the user's own text alone.
function stripTookNote(notes) {
  if (!notes) return notes || "";
  return String(notes)
    .split("\n")
    .filter(line => !/^\s*⏱/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The whole timing computation, isolated so it is testable without a DB and so
// the "no startedAt ⇒ no timing" guard has exactly one home. Arithmetic and both
// note wordings are verbatim from handleDone.
//
// `fallbackMinutes` is what keeps the two callers honest. The Slack ✅ path
// passes NO_HOURGLASS_MIN, because 🔖→✅ with no ⌛ has always meant "assume 5
// minutes". Every other path passes nothing, so a UI check-off on a task that
// was never started records NOTHING rather than inventing five minutes of work.
//
// `maxMinutes` is opt-in and only the reconciler uses it: the webhook path keeps
// its original unclamped arithmetic, while a timer reconcileTiming finds lying
// around days later gets a ceiling instead of billing every hour since.
function computeTiming({ props = {}, endMs, fallbackMinutes = null, maxMinutes = null, human }) {
  const startedMs = props.startedAt ? Date.parse(props.startedAt) : null;
  const timed = Number.isFinite(startedMs) && endMs > startedMs;
  if (!timed && fallbackMinutes == null) return null;
  const elapsedMin = timed ? Math.max(1, Math.round((endMs - startedMs) / 60000)) : fallbackMinutes;
  const clamped = timed && maxMinutes != null && elapsedMin > maxMinutes;
  const actualMinutes = clamped ? maxMinutes : elapsedMin;
  const startMs = timed ? (clamped ? endMs - actualMinutes * 60000 : startedMs) : endMs - actualMinutes * 60000;
  const note = !timed
    ? `⏱ ~${actualMinutes}m (✅ ${human(endMs)}, no timer)`
    : clamped
      ? `⏱ Took ≥${actualMinutes}m (⌛ ${human(startedMs)} → ✅ ${human(endMs)}, timer left running)`
      : `⏱ Took ~${actualMinutes}m (⌛ ${human(startedMs)} → ✅ ${human(endMs)})`;
  return { timed, clamped, actualMinutes, startMs, endMs, durSec: Math.round((endMs - startMs) / 1000), note };
}

function positivePlannedMinutes(props = {}) {
  for (const raw of [props.durationMinutes, props.estimatedMinutes, props.duration]) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (/^\d{2}:\d{2}$/.test(props.start || "") && /^\d{2}:\d{2}$/.test(props.end || "")) {
    const [sh, sm] = props.start.split(":").map(Number);
    const [eh, em] = props.end.split(":").map(Number);
    let value = eh * 60 + em - sh * 60 - sm;
    if (value <= 0) value += 1440;
    if (value > 0) return value;
  }
  return null;
}

function plannedWindowOf(block, timeZone = "America/New_York") {
  const props = (block && block.properties) || {};
  let startMs = Date.parse(props.plannedStartAt || "");
  let endMs = Date.parse(props.plannedEndAt || "");
  if (!Number.isFinite(startMs) && block && block.date && /^\d{2}:\d{2}$/.test(props.start || "")) {
    startMs = localKeyToInstant(`${String(block.date).slice(0, 10)}T${props.start}`, timeZone).getTime();
  }
  if (!Number.isFinite(endMs) && block && block.date && /^\d{2}:\d{2}$/.test(props.end || "")) {
    const date = String(block.date).slice(0, 10);
    endMs = localKeyToInstant(`${date}T${props.end}`, timeZone).getTime();
    if (Number.isFinite(startMs) && endMs <= startMs) {
      const next = new Date(`${date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      endMs = localKeyToInstant(`${next.toISOString().slice(0, 10)}T${props.end}`, timeZone).getTime();
    }
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { startMs, endMs }
    : null;
}

function splitSessionByLocalDay(startMs, endMs, timeZone = "America/New_York") {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const out = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard++ < 370) {
    const date = instantToLocalKey(new Date(cursor), timeZone).slice(0, 10);
    const nextDate = new Date(`${date}T12:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const midnight = localKeyToInstant(`${nextDate.toISOString().slice(0, 10)}T00:00`, timeZone).getTime();
    const segmentEnd = Math.min(endMs, midnight > cursor ? midnight : endMs);
    out.push({ date, startMs: cursor, endMs: segmentEnd, durSec: Math.max(1, Math.round((segmentEnd - cursor) / 1000)) });
    cursor = segmentEnd;
  }
  // The spans must sum to EXACTLY the window, and two things broke that. Math.max(1, …)
  // only ever rounds UP, so an unaligned midnight boundary gained a second: 23:59:59.600
  // to 00:00:29.600 produced 31s for a 30s window. Reachable, because startedAt carries
  // milliseconds and writeLogicalSession's own rounding pushes a later piece's computed
  // start a few hundred ms past midnight. And a sliver under a second cannot be a row of
  // its own at all, because every row needs at least 1s, so it is folded into its
  // neighbour rather than inflating the total by existing.
  for (let i = 0; i < out.length && out.length > 1; ) {
    const span = out[i];
    if (span.endMs - span.startMs >= 1000) { i++; continue; }
    const into = out[i + 1] || out[i - 1];
    into.startMs = Math.min(into.startMs, span.startMs);
    into.endMs = Math.max(into.endMs, span.endMs);
    out.splice(i, 1);
    if (!out[i]) i = Math.max(0, i - 1);
  }
  for (const span of out) span.durSec = Math.max(1, Math.round((span.endMs - span.startMs) / 1000));
  // Whatever rounding is left lands on the last span, which is planAllocations' own rule
  // applied one level down.
  const want = Math.max(1, Math.round((endMs - startMs) / 1000));
  const have = out.reduce((sum, span) => sum + span.durSec, 0);
  if (out.length && have !== want) {
    const last = out[out.length - 1];
    last.durSec = Math.max(1, last.durSec + (want - have));
  }
  return out;
}

function sessionRowId(block, workSessionId, date, index) {
  const digest = crypto.createHash("sha256")
    .update(`${block.workspace_id || ""}:${block.id}:${workSessionId}:${date}:${index}`)
    .digest("hex").slice(0, 24);
  return `work-session-${digest}`;
}

// ── Reallocation: reading a segment's window, and dividing it ────────────────
//
// TRANSFERRABLE AND SPLITTABLE. Time lands on the task you were pointed at, not
// always the task you were doing, so a tracked segment has to be re-attributable
// after the fact — moved whole to another task, or cut into pieces that each go
// somewhere. Both are ONE mechanic (a segment's seconds are re-divided among
// destination tasks) and so they get one code path, per the repo's
// one-canonical-mover rule: a move is a one-part reallocation, a split is an
// N-part one.

// A time_entry's `start` is NOT one shape. writeLogicalSession writes "HH:MM"
// alongside ISO startedAt/endedAt, finalizeTiming writes "HH:MM" only, and
// day-review's manual editor writes a naive local "YYYY-MM-DDTHH:MM:00". So the
// window is read in that order of trust, and `durSec` — the one field every
// writer agrees on and the only one Day Review and actualMinutes actually add up
// — is the authority for LENGTH. A segment whose start cannot be read is still
// splittable; its pieces just carry no clock times, which is exactly how an
// unpositioned manual segment already renders.
function entryWindow(entry, timeZone = "America/New_York") {
  const props = (entry && entry.properties) || {};
  // NON-FINITE IS NOT A LENGTH. `durSec` is client-writable (properties is a free-form
  // jsonb bag that PATCH /api/blocks/:id replaces wholesale), and the string "Infinity"
  // or "1e400" is valid JSON that Number() turns into Infinity. Left unchecked it
  // satisfied every guard downstream by accident: the conservation check compares
  // `Infinity !== Infinity`, which is false.
  const rawDur = Number(props.durSec);
  const declared = Number.isFinite(rawDur) ? Math.max(0, Math.round(rawDur)) : 0;
  const date = entry && entry.date ? String(entry.date).slice(0, 10) : null;
  let startMs = Date.parse(props.startedAt || "");
  if (!Number.isFinite(startMs)) {
    const raw = String(props.start || "");
    if (/^\d{2}:\d{2}$/.test(raw) && date) startMs = localKeyToInstant(`${date}T${raw}`, timeZone).getTime();
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) startMs = localKeyToInstant(raw.slice(0, 16), timeZone).getTime();
    else startMs = NaN;
  }
  if (!Number.isFinite(startMs)) return { startMs: null, endMs: null, durSec: declared };
  const endedMs = Date.parse(props.endedAt || "");
  if (declared > 0) return { startMs, endMs: startMs + declared * 1000, durSec: declared };
  if (Number.isFinite(endedMs) && endedMs > startMs) {
    return { startMs, endMs: endedMs, durSec: Math.round((endedMs - startMs) / 1000) };
  }
  return { startMs, endMs: startMs, durSec: 0 };
}

// THE CONSERVATION RULE. A reallocation never invents or loses tracked time: the
// pieces sum to EXACTLY the source segment's durSec. Every piece but the last
// takes the length it asks for; the last one takes whatever is left. That single
// arrangement is what makes the UI honest ("the first 20m went to A, the rest to
// B") and it is the only one where a minutes-to-seconds rounding cannot leak a
// second into or out of the ledger.
//
// Returns a result object rather than throwing: this is a pure validator, and the
// HTTP layer owns status codes.
function planAllocations(totalSec, requests, { maxParts = MAX_ALLOCATION_PARTS } = {}) {
  const total = Math.round(Number(totalSec) || 0);
  // `!(total > 0)` alone lets Infinity through, and an infinite total makes the last
  // piece's remainder infinite too.
  if (!Number.isFinite(total) || !(total > 0)) return { ok: false, error: "This segment has no tracked time to move" };
  if (!Array.isArray(requests) || !requests.length) return { ok: false, error: "Choose at least one destination" };
  if (requests.length > maxParts) return { ok: false, error: `Split into at most ${maxParts} pieces` };
  const parts = [];
  let used = 0;
  for (let i = 0; i < requests.length; i++) {
    if (i === requests.length - 1) {
      // The remainder wins on the last piece even when it was given a length, so
      // a stale or hand-edited number cannot unbalance the ledger.
      parts.push({ durSec: total - used });
      break;
    }
    const request = requests[i] || {};
    const asked = request.durSec != null ? Math.round(Number(request.durSec)) : Math.round(Number(request.minutes) * 60);
    if (!Number.isFinite(asked) || asked < 1) return { ok: false, error: "Every piece needs a length in minutes" };
    used += asked;
    if (used >= total) return { ok: false, error: "The pieces add up to more time than was tracked" };
    parts.push({ durSec: asked });
  }
  return { ok: true, parts };
}

function reallocatedRowId(entry, seed, index) {
  const digest = crypto.createHash("sha256")
    .update(`${entry.workspace_id || ""}:${entry.id}:${seed}:${index}`)
    .digest("hex").slice(0, 24);
  return `time-split-${digest}`;
}

function isStaleWorkEvent(props = {}, atMs) {
  const changedMs = Date.parse(props.workStateChangedAt || "");
  return Number.isFinite(changedMs) && Number.isFinite(atMs) && atMs < changedMs;
}

// ── Factory ───────────────────────────────────────────────────────────────────

function createTaskTiming({ pool, blockDB, timeZone = "America/New_York" } = {}) {
  const fmt = (ms, opts) => new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(ms));
  const hhmm = (ms) => fmt(ms, { hour12: false, hour: "2-digit", minute: "2-digit" });   // "14:50"
  const human = (ms) => fmt(ms, { hour12: true, hour: "numeric", minute: "2-digit" })    // "2:50 PM" -> "2:50p"
    .replace(/\s?([AP])M$/i, (_, p) => p.toLowerCase());

  const timerIdFor = (blockId) => `${blockId}${TIMER_ID_SUFFIX}`;

  // `client` reads through the caller's transaction. The reallocation mover re-projects a
  // task from segments it wrote in the same BEGIN/COMMIT, and a pool read cannot see them.
  async function getSessions(block, opts = {}, client = null) {
    if (!block || !block.id) return [];
    if (typeof blockDB.getTaskTimeEntries === "function") {
      return blockDB.getTaskTimeEntries(block.id, block.workspace_id || opts.workspaceId || null, opts, client);
    }
    const params = [String(block.id), block.workspace_id || opts.workspaceId || null];
    const deleted = opts.includeDeleted ? "" : "AND deleted_at IS NULL";
    const { rows } = await (client || pool).query(
      `SELECT * FROM blocks WHERE type = 'time_entry'
        AND properties->>'blockId' = $1
        AND workspace_id IS NOT DISTINCT FROM $2 ${deleted}
        ORDER BY date ASC, created_at ASC`, params
    );
    return rows;
  }

  function sessionTotalMinutes(rows) {
    const seconds = (rows || []).reduce((sum, row) => sum + Math.max(0, Number((row.properties || {}).durSec) || 0), 0);
    return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null;
  }

  async function writeLogicalSession({
    block, workSessionId, startMs, endMs, actor = "dcc", startedBy = null,
    endedBy = null, estimated = false, inferenceReason = null,
  }) {
    const segments = splitSessionByLocalDay(startMs, endMs, timeZone);
    const written = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const id = sessionRowId(block, workSessionId, segment.date, i);
      const existing = typeof blockDB.getBlockIncludingDeleted === "function"
        ? await blockDB.getBlockIncludingDeleted(id)
        : await blockDB.getBlock(id);
      if (existing) {
        const existingProps = existing.properties || {};
        const sameWorkspace = String(existing.workspace_id || "") === String(block.workspace_id || "");
        const sameTask = String(existingProps.blockId || "") === String(block.id);
        if (!sameWorkspace || !sameTask) throw new Error("Work session identity collision");
      }
      if (existing && !existing.deleted_at) { written.push(existing); continue; }
      if (existing && existing.deleted_at && typeof blockDB.undeleteBlock === "function") {
        written.push(await blockDB.undeleteBlock(id));
        continue;
      }
      const parentId = await blockDB.ensureDayRoot(segment.date, block.user_id || null, block.workspace_id || null);
      written.push(await blockDB.createBlock({
        id, type: "time_entry", parent_id: parentId, date: segment.date,
        properties: {
          blockId: block.id,
          taskTitle: (block.properties || {}).title || "Task",
          workSessionId,
          startedAt: new Date(segment.startMs).toISOString(),
          endedAt: new Date(segment.endMs).toISOString(),
          start: hhmm(segment.startMs), end: hhmm(segment.endMs),
          durSec: segment.durSec,
          source: "work-session",
          actor,
          startedBy: startedBy || actor,
          endedBy: endedBy || actor,
          estimated: !!estimated,
          inferred: !!estimated,
          inferenceReason: inferenceReason || undefined,
          logicalSessionStartedAt: new Date(startMs).toISOString(),
          logicalSessionEndedAt: new Date(endMs).toISOString(),
        },
        user_id: block.user_id || null,
        workspace_id: block.workspace_id || null,
      }));
    }
    return written;
  }

  // Re-derive a task's actualMinutes from the segments that CURRENTLY point at
  // it. This is the only write a reallocation needs to make on a TASK: the
  // minutes on the row are a projection of its time_entry rows, so moving a
  // segment has to re-project BOTH ends of the move. The rule is reopenWork's,
  // unchanged — a total replaces the stamp, no total removes it.
  //
  // The reconciler's derived flag is cleared, because a segment a human placed by
  // hand is a measurement, not a guess, and leaving the flag on would let the
  // next read withdraw it. The ⏱ note is stripped only when the number actually
  // moved: a note quoting minutes the row no longer claims is worse than no note,
  // but stripping one on a no-op write would delete it for nothing.
  async function recomputeActualMinutes({ block, workspaceId = null, priorSessionsTotal, client = null }) {
    if (!block || !block.id) return null;
    const sessions = await getSessions(block, { workspaceId }, client);
    const total = sessionTotalMinutes(sessions);
    const props = block.properties || {};
    const before = props.actualMinutes == null ? null : Number(props.actualMinutes);
    // MINUTES NO ROW EXPLAINS ARE NOT OURS TO DELETE. actualMinutes is a projection of
    // the task's time_entry rows, but the codebase knowingly produces rows that carry
    // minutes with no segment behind them: finalizeTiming stamps the minutes first and
    // mints its segment inside a try/catch it labels non-fatal, and pauseWork's
    // `sessionTotalMinutes(sessions) || (actualMinutes + measured)` fallback only makes
    // sense for that state. Re-projecting absolutely would delete that history the
    // moment such a task is picked as a destination: a task claiming 90m with no rows
    // would receive a 20m piece and end up claiming 20. So the projection is applied to
    // the SEGMENTS and the unexplained remainder is carried across untouched.
    // `null` is a real snapshot value meaning "no segments at all", so only `undefined`
    // may read as "no snapshot taken". Conflating them made a legacy 90m destination
    // measure its own unaccounted history against the incoming piece and keep 90
    // instead of 110. With no snapshot the stamp is treated as a pure projection,
    // which is what every non-reallocation caller means.
    const hasPrior = priorSessionsTotal !== undefined;
    const accountedBefore = hasPrior ? (priorSessionsTotal || 0) : (before || 0);
    // A RECONCILER GUESS is not history worth carrying. DERIVED_FLAG exists precisely so
    // a real measurement may overwrite it, so a derived stamp with no segments behind it
    // must not be treated as unaccounted minutes and added to the piece landing here.
    const derivedBefore = props.actualMinutesFrom === DERIVED_FLAG;
    const unaccounted = before == null || derivedBefore ? 0 : Math.max(0, before - accountedBefore);
    const projected = total == null ? (unaccounted || null) : total + unaccounted;
    const nextProps = { ...props };
    if (projected != null) nextProps.actualMinutes = projected; else delete nextProps.actualMinutes;
    // A human-placed segment is a measurement, so a real total retires any flag. A row
    // left with NOTHING gets the reallocated sentinel instead of a bare delete, or the
    // reconciler re-derives the minutes that just moved away (see REALLOCATED_FLAG).
    if (projected != null) delete nextProps.actualMinutesFrom;
    else if (before != null) nextProps.actualMinutesFrom = REALLOCATED_FLAG;
    else delete nextProps.actualMinutesFrom;
    if (before !== projected) {
      const stripped = stripTookNote(nextProps.notes);
      if (stripped) nextProps.notes = stripped; else delete nextProps.notes;
    }
    const written = await blockDB.updateBlock(block.id, { properties: nextProps }, client);
    block.properties = written && written.properties ? written.properties : nextProps;
    return { id: block.id, actualMinutes: projected == null ? null : projected, previousMinutes: before, carriedForward: unaccounted || undefined };
  }

  // THE ONE MOVER for tracked time, and it owns ONE TRANSACTION.
  //
  // `allocations` is [{ durSec, task }] or [{ durSec, newTask: { properties, date } }],
  // already planned by planAllocations, in the order the pieces sit on the clock: piece
  // one starts where the segment started, piece two picks up where piece one ended. That
  // ordering is the whole UX ("the first 20m was onboarding, the rest was the migration")
  // and it is why the caller must not reorder them.
  //
  // WHY A TRANSACTION, when nothing else in this module has one. Every other writer here
  // touches a single row, so a failure is atomic for free. A reallocation is N segment
  // rows plus a source row plus a projection on each end, and three review rounds found
  // three different partial-failure windows in it: shrinking the source first LOST time,
  // stamping an idempotency key before the tail INVENTED it and then reported success,
  // and a resume that read its own half-written state double-counted it. Each patch moved
  // the window rather than closing it, because the real problem is that the operation was
  // not atomic. db.js already threads a `client` through every primitive this needs, and
  // "the store owns the transaction" is the repo's stated idiom (rescheduleBlocks,
  // batchOp, createItineraryTasks). So: one BEGIN/COMMIT, and a failure changes nothing.
  //
  // What that buys, beyond correctness: there is no resume, therefore no resume state,
  // therefore no operation bookkeeping living in a client-writable properties bag for an
  // attacker to forge. `reallocationOperationId` is the only stamp left, it is written in
  // the same commit as the work, and so "stamped" honestly means "finished".
  //
  // Exactly one row may KEEP the source id: the piece that lands back on the origin task.
  // Every other piece is a new row at a deterministic id derived from the actionId, and
  // the source row is deleted when no piece stayed. Two reasons, both bugs if flipped:
  //
  //  1. A moved piece must not inherit an id that encodes the OLD task. The Slack timer
  //     row is literally `<taskId>-slacktimer` and deleteTimerRow hard-deletes it by that
  //     id, so a moved piece keeping it would be erased later by a clearTiming on a task
  //     it no longer belongs to.
  //  2. Deterministic ids make a retry land on the same rows. Seeded on the ACTION, not on
  //     the resolved destinations: a `newTask` piece mints a fresh task per attempt, so a
  //     destination-derived seed changed on every retry and orphaned the previous
  //     attempt's rows instead of overwriting them.
  async function reallocateTimeEntry({ entry, allocations, actor = "dcc", userId = null, workspaceId = null, actionId = null }) {
    if (!entry || !entry.id || entry.type !== "time_entry") throw new Error("Not a time entry");
    if (!Array.isArray(allocations) || !allocations.length) throw new Error("No allocations given");
    if (actionId && (entry.properties || {}).reallocationOperationId === actionId) {
      // Atomic, so the stamp means the whole operation committed. No resume, no repair.
      return {
        entries: [entry], tasks: [], createdTasks: [],
        originTaskId: String((entry.properties || {}).blockId || "") || null,
        sourceEntryDeleted: !!entry.deleted_at, duplicate: true,
      };
    }

    // No client factory means no BEGIN, no ROLLBACK and no FOR UPDATE: exactly the
    // un-atomic sequence this function was rewritten to replace. Refuse rather than
    // quietly degrade. Every real caller injects pg-pool, which has connect(); the reason
    // this is an error and not a fallback is that a test harness missing `connect` would
    // otherwise make every rollback assertion in the suite pass with nothing rolled back.
    if (!pool || typeof pool.connect !== "function") {
      throw new Error("reallocateTimeEntry needs a pool that can open a transaction");
    }
    const ownsTransaction = true;
    const client = await pool.connect();
    try {
      if (ownsTransaction) await client.query("BEGIN");

      // Re-read the source UNDER A ROW LOCK. Two submissions racing on one segment would
      // otherwise both pass the conservation check against the same pre-split length and
      // both apply, and the second would be measuring against a length that no longer
      // exists by the time it writes.
      const locked = typeof blockDB.getBlockIncludingDeleted === "function"
        ? await blockDB.getBlockIncludingDeleted(entry.id, client, true)
        : entry;
      if (!locked) throw new Error("Tracked time not found");
      const props = locked.properties || {};
      // BEFORE the tombstone check, for the reason the route states for its own ordering:
      // a whole move stamps the source and deletes it in the SAME commit, so a stamped
      // tombstone is a COMMITTED operation, not a missing row. Checked the other way
      // round, a concurrent retry that blocked on the lock above re-read the row the
      // winner had just tombstoned and got a 500, so the dialog reported failure for time
      // that had landed.
      if (actionId && props.reallocationOperationId === actionId) {
        if (ownsTransaction) await client.query("COMMIT");
        return {
          entries: [locked], tasks: [], createdTasks: [],
          originTaskId: String(props.blockId || "") || null,
          sourceEntryDeleted: !!locked.deleted_at, duplicate: true,
        };
      }
      if (locked.deleted_at) throw new Error("Tracked time not found");

      const window = entryWindow(locked, timeZone);
      const total = allocations.reduce((sum, part) => sum + Math.round(Number(part.durSec) || 0), 0);
      // Belt to planAllocations' braces, re-checked against the LOCKED row. The store must
      // not be the layer that trusts the caller conserved the time, because it is the
      // layer that writes it.
      // Finite on BOTH sides. `Infinity !== Infinity` is false, so without this the belt
      // and the braces both held up a length neither was written to accept, and the
      // infinite piece then produced zero rows (splitSessionByLocalDay refuses a
      // non-finite window) so nothing "stayed" and the source was deleted underneath it.
      if (!Number.isFinite(window.durSec) || !Number.isFinite(total)
        || !window.durSec || total !== window.durSec) {
        throw new Error("Reallocation does not conserve tracked time");
      }

      const originId = String(props.blockId || "");
      const fence = locked.workspace_id || workspaceId || null;
      // ABSENT IS NOT "MINE". The repo's usual fence is `if (a && b && a !== b) deny`, and
      // db.js createBlock says in as many words that it therefore PASSES on a row whose
      // workspace is absent. `properties.blockId` is client-writable, so without the
      // fallback an unfenced legacy task could be named as the origin and written.
      const ownerId = locked.user_id == null ? null : String(locked.user_id);
      function writableHere(block) {
        if (block.workspace_id) return String(block.workspace_id) === String(fence || "");
        if (!block.user_id) return true;
        return ownerId != null && String(block.user_id) === ownerId;
      }

      // One day_root lookup per DISTINCT date, matching db.createItineraryTasks' rule, and
      // every one of them through the client so a rollback takes them with it.
      const dayRoots = new Map();
      async function dayRootFor(date) {
        if (!dayRoots.has(date)) dayRoots.set(date, await blockDB.ensureDayRoot(date, locked.user_id || userId || null, fence, client));
        return dayRoots.get(date);
      }
      const ensureRootWith = dayRootFor;

      // Destinations that do not exist yet are created HERE, inside the transaction, so a
      // failure leaves no orphan task behind. The route builds the property bag, because
      // what a task looks like is its business, not this module's.
      const resolved = [];
      for (const part of allocations) {
        if (part.task) { resolved.push({ durSec: part.durSec, task: part.task }); continue; }
        const spec = part.newTask || {};
        const taskDate = spec.date || locked.date;
        // ensureRoot:false and the root ensured HERE, with the client. createItineraryTask
        // calls ensureDayRoot without passing its client through, so leaving the default
        // on would run that insert on the pool, outside this transaction, and a rollback
        // would leave the day_root behind.
        await ensureRootWith(taskDate);
        const made = await blockDB.createItineraryTask({
          date: taskDate,
          ensureRoot: false,
          properties: spec.properties || {},
          userId: locked.user_id || userId || null,
          workspaceId: fence,
          score: true,
          client,
        });
        resolved.push({ durSec: part.durSec, task: made, created: true });
      }

      const seed = actionId || resolved.map(part => `${part.durSec}>${part.task.id}`).join("|");
      const at = new Date().toISOString();
      const keepIndex = resolved.findIndex(part => originId && String(part.task.id) === originId);

      // Operation bookkeeping describes the operation that produced this row's
      // PREDECESSOR, so it must not ride forward onto its successors. Left in place, a
      // chained reallocation (split, then move the remainder) inherited the previous
      // operation's id and its replay guard answered for the wrong operation.
      const carried = { ...props };
      for (const key of REALLOC_BOOKKEEPING) delete carried[key];

      // ── plan every row before writing any of them ──
      // A piece is not always ONE row. splitSessionByLocalDay is what writeLogicalSession
      // uses so a session running past local midnight becomes one row per local day, each
      // dated to the day its own window belongs to. Pinning every piece to the SOURCE
      // row's date produced a row whose `end` preceded its `start`, which Day Review drew
      // on the wrong day. Reachable: finalizeTiming writes one unsplit row for an
      // hourglass that spanned midnight, and Day Review's editor allows it by hand.
      const planned = [];
      let offset = 0;
      for (let i = 0; i < resolved.length; i++) {
        const part = resolved[i];
        const moved = !originId || String(part.task.id) !== originId;
        const startMs = window.startMs == null ? null : window.startMs + offset * 1000;
        const spans = startMs == null
          ? [{ date: locked.date, startMs: null, endMs: null, durSec: part.durSec }]
          : splitSessionByLocalDay(startMs, startMs + part.durSec * 1000, timeZone);
        for (let j = 0; j < spans.length; j++) {
          const span = spans[j];
          const nextProps = { ...carried };
          nextProps.blockId = part.task.id;
          nextProps.taskTitle = (part.task.properties || {}).title || props.taskTitle || "Task";
          nextProps.durSec = span.durSec;
          nextProps.reallocatedAt = at;
          nextProps.reallocatedBy = actor;
          if (span.startMs != null) {
            nextProps.start = hhmm(span.startMs);
            nextProps.end = hhmm(span.endMs);
            // Only rewrite the shape the SOURCE row had. A manual segment carries the
            // naive-local start/end only, and Day Review's editor re-saves it by
            // spreading the old props: an ISO startedAt invented here would survive that
            // edit, and entryWindow trusts startedAt first, so the next move of that row
            // would position its pieces at the old hour with the new length.
            if (props.startedAt) {
              nextProps.startedAt = new Date(span.startMs).toISOString();
              nextProps.endedAt = new Date(span.endMs).toISOString();
              nextProps.logicalSessionStartedAt = nextProps.startedAt;
              nextProps.logicalSessionEndedAt = nextProps.endedAt;
            } else {
              for (const key of ["startedAt", "endedAt", "logicalSessionStartedAt", "logicalSessionEndedAt"]) delete nextProps[key];
            }
          } else {
            // No readable start means no clock at all. Carrying the source's window over
            // would give every piece the same times with a different length, and Day
            // Review would stack them on top of each other.
            for (const key of ["start", "end", "startedAt", "endedAt", "logicalSessionStartedAt", "logicalSessionEndedAt"]) delete nextProps[key];
          }
          if (resolved.length > 1 || spans.length > 1) nextProps.splitFromEntryId = locked.id;
          // EVERY piece is hand-placed, so no piece stays a guess. Gating this on `moved`
          // left the staying half of a split carrying inferenceReason with a duration the
          // user chose, and reopenWork hard-deletes rows by exactly that field.
          for (const key of ["estimated", "inferred", "inferenceReason"]) delete nextProps[key];
          if (moved) {
            // A fresh session id, so no later writeLogicalSession can derive a row id that
            // collides with a piece now filed under a different task; its identity guard
            // would throw and take the pause with it.
            nextProps.workSessionId = `ws-realloc-${reallocatedRowId(locked, seed, `${i}.${j}`).slice(-24)}`;
            if (props.workSessionId) nextProps.movedFromWorkSessionId = props.workSessionId;
            if (originId) nextProps.movedFromTaskId = originId;
          }
          planned.push({
            // The source id is reused by the FIRST span of the piece that stays, so a
            // midnight-straddling keep piece still leaves its later days on fresh rows.
            id: i === keepIndex && j === 0 ? locked.id : reallocatedRowId(locked, seed, `${i}.${j}`),
            reusesSource: i === keepIndex && j === 0,
            date: span.date,
            props: nextProps,
          });
        }
        offset += part.durSec;
      }

      // Snapshot what each task's segments accounted for BEFORE the writes. A local
      // variable, never persisted: recomputeActualMinutes needs it to tell a projection
      // apart from minutes no row ever explained, and the earlier design that stamped it
      // onto the segment both leaked a forgery surface and let a replay read its own
      // output back as history.
      const touched = new Map();
      if (originId) touched.set(originId, null);
      for (const part of resolved) touched.set(String(part.task.id), part.task);
      const priorTotals = new Map();
      // FOR UPDATE on every touched TASK, and unconditionally. The segment lock above only
      // serializes reallocations of the SAME segment; two segments moving onto one task
      // were not serialized at all, and the projection is a read-modify-write that writes
      // `properties` wholesale (db.updateBlock replaces the bag), so the second operation
      // either lost the first's minutes or read them back as `unaccounted` and added them
      // on top. The second shape is sticky: every later recompute carries the phantom
      // forward. Reusing the route's pre-transaction read (`known`) would skip the very
      // lock the snapshot depends on, so it is deliberately not used here.
      //
      // Sorted, so two operations touching the same pair of tasks acquire in the same
      // order and cannot deadlock each other.
      for (const id of [...touched.keys()].sort()) {
        const block = typeof blockDB.getBlockIncludingDeleted === "function"
          ? await blockDB.getBlockIncludingDeleted(id, client, true)
          : await blockDB.getBlock(id, client);
        if (!block || block.deleted_at || !writableHere(block)) continue;
        priorTotals.set(id, sessionTotalMinutes(await getSessions(block, { workspaceId: block.workspace_id || fence }, client)));
      }

      const keepRow = planned.find(row => row.reusesSource) || null;
      const stamp = actionId ? { reallocationOperationId: actionId } : null;

      const entries = [];
      for (const row of planned) {
        const rowProps = row.reusesSource && stamp ? { ...row.props, ...stamp } : row.props;
        if (row.reusesSource) {
          // db.updateBlock leaves parent_id alone on a date change, so a keep piece whose
          // first span landed on a later local day would stay filed under the previous
          // day's container.
          const dayChanged = String(row.date || "") !== String(locked.date || "");
          entries.push(await blockDB.updateBlock(locked.id, dayChanged
            ? { properties: rowProps, date: row.date, parent_id: await dayRootFor(row.date) }
            : { properties: rowProps, date: row.date }, client));
          continue;
        }
        const existing = typeof blockDB.getBlockIncludingDeleted === "function"
          ? await blockDB.getBlockIncludingDeleted(row.id, client)
          : await blockDB.getBlock(row.id, client);
        if (existing) {
          // The guard writeLogicalSession applies to its own derived ids. Ids are
          // client-suppliable here (POST /api/blocks accepts one), so a row at a derived
          // id is not provably ours: overwriting it blindly would let a planted row in
          // another tenant absorb this segment, and would clobber an unrelated row on any
          // collision. Strict equality, so an absent workspace fails CLOSED.
          if (String(existing.workspace_id || "") !== String(fence || "") || existing.type !== "time_entry") {
            throw new Error("Reallocated segment identity collision");
          }
          if (existing.deleted_at && typeof blockDB.undeleteBlock === "function") await blockDB.undeleteBlock(row.id, client);
          entries.push(await blockDB.updateBlock(row.id, { properties: rowProps, date: row.date }, client));
          continue;
        }
        entries.push(await blockDB.createBlock({
          id: row.id, type: "time_entry", parent_id: await dayRootFor(row.date), date: row.date,
          properties: rowProps,
          user_id: locked.user_id || userId || null,
          workspace_id: fence,
        }, client));
      }

      // Nothing stayed, so the source is double-counted and goes. Stamped first, because
      // the route answers a replay off this row and db.updateBlock refuses a tombstone, so
      // a bare delete would make the retry of a committed move read as a 404 and toast a
      // failure for work that landed. Both writes are in this transaction, so the stamp
      // cannot outlive a rollback.
      if (!keepRow) {
        if (stamp) {
          await blockDB.updateBlock(locked.id, {
            properties: { ...carried, ...stamp, reallocatedAt: at, reallocatedBy: actor, movedToEntryIds: entries.map(row => row.id) },
          }, client);
        }
        await blockDB.deleteBlock(locked.id, client);
      }

      // Projections last, and AFTER the delete, so the origin no longer sees the row that
      // just left it. Inside one transaction that ordering is free.
      const tasks = [];
      for (const [id, taskBlock] of touched) {
        const block = await blockDB.getBlock(id, client);
        if (!block || block.deleted_at) continue;
        // `properties.blockId` is client-writable, so the origin can name a task in
        // another workspace while the segment itself passes its own ownership check, and
        // db.updateBlock carries no tenant predicate.
        if (!writableHere(block)) continue;
        const result = await recomputeActualMinutes({
          block,
          workspaceId: block.workspace_id || fence,
          priorSessionsTotal: priorTotals.has(id) ? priorTotals.get(id) : null,
          client,
        });
        // Keep the caller's in-memory task objects in step with what was committed.
        if (taskBlock && block !== taskBlock) taskBlock.properties = block.properties;
        if (result) tasks.push(result);
      }

      if (ownsTransaction) await client.query("COMMIT");
      return {
        entries, tasks, originTaskId: originId || null, sourceEntryDeleted: !keepRow,
        // Reported by the layer that actually created them, so the route does not have to
        // infer it back out of the written rows.
        createdTasks: resolved
          .filter(part => part.created)
          .map(part => ({ id: part.task.id, title: (part.task.properties || {}).title || "" })),
      };
    } catch (error) {
      if (ownsTransaction) { try { await client.query("ROLLBACK"); } catch { /* preserve the write error */ } }
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }



  function modeFor(block) {
    return TaskTypes.rule((block && block.properties) || block || "task", "actualTimeMode");
  }

  async function startWork({ block, atMs = Date.now(), actor = "dcc", actionId = null } = {}) {
    if (!block || !block.id || block.deleted_at) return { changed: false, reason: "missing" };
    const props = block.properties || {};
    if (actionId && props.workStateOperationId === actionId) return { changed: false, reason: "duplicate", block };
    if (isStaleWorkEvent(props, atMs)) return { changed: false, reason: "stale", block };
    if (modeFor(block) !== "work_sessions") return { changed: false, reason: "not-trackable" };
    if (isBlockDone(block, null)) return { changed: false, reason: "completed" };
    if (props.startedAt) return { changed: false, reason: "already-active", block };
    const startedAt = new Date(atMs).toISOString();
    const seed = `${block.workspace_id || ""}:${block.id}:${actionId || startedAt}`;
    const activeWorkSessionId = `ws-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
    const nextProps = {
      ...props, startedAt, activeWorkSessionId, startedBy: actor, everStarted: true,
      workStateChangedAt: startedAt, workStateChangedBy: actor,
      workStateOperationId: actionId || props.workStateOperationId,
    };
    // Starting fresh work retires the reallocated sentinel, so the reconciler is allowed
    // to settle THIS timer even though the row's earlier minutes live on another task.
    if (nextProps.actualMinutesFrom === REALLOCATED_FLAG) delete nextProps.actualMinutesFrom;
    const written = await blockDB.updateBlock(block.id, { properties: nextProps });
    block.properties = written && written.properties ? written.properties : nextProps;
    return { changed: true, block };
  }

  async function pauseWork({ block, atMs = Date.now(), actor = "dcc", actionId = null } = {}) {
    if (!block || !block.id || block.deleted_at) return { changed: false, reason: "missing" };
    const props = block.properties || {};
    if (actionId && props.workStateOperationId === actionId) return { changed: false, reason: "duplicate", block };
    if (isStaleWorkEvent(props, atMs)) return { changed: false, reason: "stale", block };
    if (modeFor(block) !== "work_sessions") return { changed: false, reason: "not-trackable" };
    const startMs = Date.parse(props.startedAt || "");
    if (!Number.isFinite(startMs)) return { changed: false, reason: "not-active", block };
    if (!(atMs > startMs)) return { changed: false, reason: "stale", block };
    const workSessionId = props.activeWorkSessionId || `legacy-${block.id}-${startMs}`;
    await writeLogicalSession({ block, workSessionId, startMs, endMs: atMs, actor, startedBy: props.startedBy || actor, endedBy: actor });
    const sessions = await getSessions(block);
    const measuredMinutes = Math.max(1, Math.round((atMs - startMs) / 60000));
    const nextProps = {
      ...props,
      actualMinutes: sessionTotalMinutes(sessions) || ((Number(props.actualMinutes) || 0) + measuredMinutes),
      workStateChangedAt: new Date(atMs).toISOString(),
      workStateChangedBy: actor,
      lastWorkedAt: new Date(atMs).toISOString(),
      lastStartedBy: props.startedBy || actor,
      workStateOperationId: actionId || props.workStateOperationId,
    };
    // Real measured minutes retire the reallocated sentinel. startWork cannot be the
    // only place that does: a row whose timer is still running answers "already-active"
    // and writes nothing, so the pause is where such a row gets its stamp back.
    if (nextProps.actualMinutesFrom === REALLOCATED_FLAG) delete nextProps.actualMinutesFrom;
    delete nextProps.startedAt;
    delete nextProps.activeWorkSessionId;
    delete nextProps.startedBy;
    const written = await blockDB.updateBlock(block.id, { properties: nextProps });
    block.properties = written && written.properties ? written.properties : nextProps;
    return { changed: true, block, sessions };
  }

  async function completeWork({ block, atMs = Date.now(), actor = "dcc", actionId = null, normalizeExisting = false } = {}) {
    if (!block || !block.id || block.deleted_at) return { changed: false, reason: "missing" };
    if (actionId && (block.properties || {}).workStateOperationId === actionId) return { changed: false, reason: "duplicate", block };
    if (isStaleWorkEvent(block.properties || {}, atMs)) return { changed: false, reason: "stale", block };
    if (isBlockDone(block, null) && !normalizeExisting) return { changed: false, reason: "already-completed", block };
    const recordedAt = new Date(atMs).toISOString();
    const mode = modeFor(block);
    if (mode === "work_sessions" && (block.properties || {}).startedAt) {
      await pauseWork({ block, atMs, actor, actionId: actionId ? `${actionId}:close-session` : null });
    }
    let props = block.properties || {};
    let sessions = await getSessions(block);
    let completedAt = recordedAt;
    let plannedMinutes = null;
    if (mode === "planned_window") {
      const planned = plannedWindowOf(block, timeZone);
      if (planned) {
        completedAt = new Date(planned.endMs).toISOString();
        plannedMinutes = Math.max(1, Math.round((planned.endMs - planned.startMs) / 60000));
        const id = `planned-${block.id}-${planned.startMs}-${planned.endMs}`;
        const written = await writeLogicalSession({ block, workSessionId: id, startMs: planned.startMs, endMs: planned.endMs, actor, startedBy: actor, endedBy: actor, estimated: true, inferenceReason: "meeting-planned-window" });
        sessions = await getSessions(block);
        if (!sessions.length) sessions = written;
      }
    } else if (mode === "work_sessions" && !sessions.length && props.actualMinutes == null) {
      const minutes = positivePlannedMinutes(props);
      if (minutes) {
        const startMs = atMs - minutes * 60000;
        const id = `inferred-${block.id}-${atMs}-${minutes}`;
        const written = await writeLogicalSession({ block, workSessionId: id, startMs, endMs: atMs, actor, startedBy: actor, endedBy: actor, estimated: true, inferenceReason: "planned-duration-completion" });
        sessions = await getSessions(block);
        if (!sessions.length) sessions = written;
      }
    }
    props = block.properties || props;
    const nextProps = {
      ...props,
      status: "done", done: true, completed: true,
      completedAt, doneAt: completedAt,
      completedBy: actor, workStateChangedAt: recordedAt, workStateChangedBy: actor,
      workStateOperationId: actionId || props.workStateOperationId,
    };
    if (mode === "planned_window") nextProps.completionRecordedAt = recordedAt;
    else delete nextProps.completionRecordedAt;
    const total = plannedMinutes != null
      ? plannedMinutes
      : sessionTotalMinutes(sessions) || (props.actualMinutes == null ? null : Number(props.actualMinutes));
    if (total != null) nextProps.actualMinutes = total;
    else delete nextProps.actualMinutes;
    delete nextProps.startedAt;
    delete nextProps.activeWorkSessionId;
    delete nextProps.startedBy;
    const written = await blockDB.updateBlock(block.id, { properties: nextProps });
    block.properties = written && written.properties ? written.properties : nextProps;
    return { changed: true, block, sessions };
  }

  async function reopenWork({ block, atMs = Date.now(), actor = "dcc", actionId = null } = {}) {
    if (!block || !block.id || block.deleted_at) return { changed: false, reason: "missing" };
    if (actionId && (block.properties || {}).workStateOperationId === actionId) return { changed: false, reason: "duplicate", block };
    if (isStaleWorkEvent(block.properties || {}, atMs)) return { changed: false, reason: "stale", block };
    const sessions = await getSessions(block);
    for (const row of sessions) {
      const reason = (row.properties || {}).inferenceReason;
      if (reason === "planned-duration-completion" || reason === "meeting-planned-window") await blockDB.deleteBlock(row.id);
    }
    const kept = await getSessions(block);
    const previous = block.properties || {};
    const nextProps = { ...previous, workStateChangedAt: new Date(atMs).toISOString(), workStateChangedBy: actor, workStateOperationId: actionId || previous.workStateOperationId };
    for (const key of ["done", "completed", "completedAt", "doneAt", "completionRecordedAt", "completedBy", "startedAt", "activeWorkSessionId", "startedBy"]) delete nextProps[key];
    nextProps.status = "open";
    const total = sessionTotalMinutes(kept);
    if (total != null) nextProps.actualMinutes = total; else delete nextProps.actualMinutes;
    const written = await blockDB.updateBlock(block.id, { properties: nextProps });
    block.properties = written && written.properties ? written.properties : nextProps;
    return { changed: true, block, sessions: kept };
  }

  // The module's one raw statement: the store layer has no hard-delete primitive
  // (db.js's only one is purgeSoftDeleted). Hard, not soft, on purpose — the
  // segment is a derived row we mint at a deterministic id, so a tombstone has
  // no undo value and would make the existence check above see a row that no
  // longer renders, silently swallowing the next re-completion's timer.
  //
  // Fenced on workspace_id as well as the id. The id is derived, but
  // POST /api/blocks accepts a client-supplied id, so a row at this id is not
  // provably ours on id alone, and every other query in this change carries a
  // tenant predicate.
  // `workspace_id IS NULL` is admitted too: a legacy or unfenced row can carry a
  // null workspace, and `workspace_id = $2` would evaluate to NULL and match
  // nothing while still reporting success — leaving a phantom segment that also
  // makes the existence check above skip minting the correct one. The id is
  // derived from a globally unique block id, so a null-workspace row at that id
  // belongs to nobody else.
  async function deleteTimerRow(block) {
    const ws = block.workspace_id || null;
    await pool.query(
      `DELETE FROM blocks WHERE id = $1 AND type = 'time_entry'
        AND ($2::text IS NULL OR workspace_id = $2 OR workspace_id IS NULL)`,
      [timerIdFor(block.id), ws]
    );
  }

  // Close the timer on a block: stamp actualMinutes, append the ⏱ note, and
  // upsert the Day Review segment. ONE updateBlock — `mergeProps` lets the
  // caller fold its own fields (the completion stamps, for the ✅ path) into the
  // same write, exactly as handleDone used to do it.
  //
  // Timing is skipped, but mergeProps is still written, when there is nothing to
  // time (no startedAt and no fallback) or when actualMinutes is already set.
  // `derived` marks a stamp as reconcileTiming's guess rather than a measured
  // ⌛→✅. A derived stamp is overwritable by a real one; a real one is final.
  async function finalizeTiming({
    block, endMs, fallbackMinutes = null, maxMinutes = null, mergeProps = null,
    userId = null, workspaceId = null, timerNote = TIMER_NOTE, title = null, derived = false,
    completionIntent = undefined,
  }) {
    if (!block || !block.id) return { changed: false, timed: false, actualMinutes: null };
    const props = block.properties || {};
    // A real measurement supersedes a derived one; nothing supersedes a real one.
    const retimingDerived = props.actualMinutes != null && props.actualMinutesFrom === DERIVED_FLAG && !derived;
    const alreadyTimed = props.actualMinutes != null && !retimingDerived;
    const timing = alreadyTimed ? null : computeTiming({ props, endMs, fallbackMinutes, maxMinutes, human });
    if (!timing && !mergeProps) return { changed: false, timed: false, actualMinutes: props.actualMinutes ?? null };

    const nextProps = { ...props, ...(mergeProps || {}) };
    if (timing) {
      nextProps.actualMinutes = timing.actualMinutes;
      // Replacing a derived stamp: drop its ⏱ line so the note is not doubled,
      // and clear the flag so the measured value is now final.
      const base = retimingDerived ? stripTookNote(nextProps.notes) : nextProps.notes;
      nextProps.notes = base ? `${base}\n\n${timing.note}` : timing.note;
      if (derived) nextProps.actualMinutesFrom = DERIVED_FLAG;
      else delete nextProps.actualMinutesFrom;
    }
    const roundedWindow = timing && timing.timed && !timing.clamped
      ? measuredTaskWindow(props.startedAt, timing.endMs, { timeZone })
      : null;
    if (roundedWindow) {
      const minutes = roundedWindow.durationMinutes;
      nextProps.start = roundedWindow.start;
      nextProps.end = roundedWindow.end;
      nextProps.duration = minutes;
      nextProps.durationMinutes = minutes;
      nextProps.estimatedMinutes = minutes;
      nextProps.pointsDurationMinutes = minutes;
      nextProps._pinnedStart = roundedWindow.start;
      const explicitOverride = nextProps.pointsOverride != null ||
        (nextProps.pointsBreakdown && nextProps.pointsBreakdown.pointsOverride != null);
      if (!explicitOverride) {
        const prior = nextProps.pointsBreakdown || {};
        const scored = scoreTaskPoints({
          ...nextProps,
          pointsDurationMinutes: minutes,
          point_multiplier: prior.pointMultiplier,
          point_tier: prior.pointTier,
        });
        nextProps.points = scored.awardPoints;
        nextProps.pointsBreakdown = scored;
      }
    }
    const written = await blockDB.updateBlock(block.id, { properties: nextProps, completionIntent });
    block.properties = written && written.properties ? written.properties : nextProps;

    let timeEntry = null;
    if (timing) {
      // Deterministic id ⇒ a Slack retry, a second reconcile pass, or both at
      // once all land on the same row. Non-fatal: the minutes on the task are
      // the load-bearing write; the segment is Day Review garnish.
      try {
        const teId = timerIdFor(block.id);
        // Replacing a derived stamp has to replace the derived SEGMENT too, or
        // Day Review keeps rendering the guessed window under the right minutes.
        if (retimingDerived) await deleteTimerRow(block);
        // getBlock is this repo's read primitive and is tombstone-inclusive, which is
        // what an existence check on a deterministic id wants... but it means a
        // TOMBSTONE at this id blocks the mint forever. deleteTimerRow's own comment
        // spells out why it hard-deletes ("a tombstone ... would make the existence
        // check above see a row that no longer renders, silently swallowing the next
        // re-completion's timer"), and a reallocation now produces exactly that: moving
        // a `<taskId>-slacktimer` segment wholly to another task SOFT-deletes the source,
        // because the replay stamp the route answers off has to survive on it. Without
        // the revive branch the task then claims minutes with no segment behind it
        // forever, and every later recompute carries them as unexplained.
        const priorTimerRow = await blockDB.getBlock(teId);
        const teProps = {
          blockId: block.id, taskTitle: title || props.title || "Slack task",
          start: hhmm(timing.startMs), end: hhmm(timing.endMs),
          durSec: timing.durSec, source: "slack", note: timerNote,
        };
        if (priorTimerRow && priorTimerRow.deleted_at) {
          // Its old seconds live on another task now, so reusing the row for this NEW
          // measurement double-counts nothing, and it is the only way this task gets a
          // segment again.
          if (typeof blockDB.undeleteBlock === "function") await blockDB.undeleteBlock(teId);
          timeEntry = await blockDB.updateBlock(teId, { properties: teProps, date: block.date });
        } else if (!priorTimerRow) {
          const date = block.date;
          const parentId = await blockDB.ensureDayRoot(date, userId, workspaceId);
          timeEntry = await blockDB.createBlock({
            id: teId, type: "time_entry", parent_id: parentId, date,
            properties: teProps,
            user_id: userId, workspace_id: workspaceId,
          });
        }
      } catch (e) { console.error("[task-timing] time_entry failed (non-fatal):", e.message); }
    }
    return { changed: true, timed: !!(timing && timing.timed), actualMinutes: timing ? timing.actualMinutes : (props.actualMinutes ?? null), roundedWindow, timeEntry };
  }

  // The inverse: un-time a block. Clears actualMinutes (and any derived flag),
  // strips the ⏱ note, and drops the timer segment via deleteTimerRow.
  //
  // `dropProps` removes keys outright rather than setting them to undefined:
  // properties is JSONB, so an undefined value would vanish on serialization but
  // linger in the caller's in-memory copy. Explicit beats incidental.
  async function clearTiming({ block, mergeProps = null, dropProps = [], completionIntent = undefined }) {
    if (!block || !block.id) return { changed: false };
    const props = block.properties || {};
    const nextProps = { ...props, ...(mergeProps || {}) };
    for (const key of dropProps) delete nextProps[key];
    delete nextProps.actualMinutes;
    delete nextProps.actualMinutesFrom;
    const stripped = stripTookNote(nextProps.notes);
    if (stripped) nextProps.notes = stripped; else delete nextProps.notes;
    const written = await blockDB.updateBlock(block.id, { properties: nextProps, completionIntent });
    block.properties = written && written.properties ? written.properties : nextProps;
    try {
      await deleteTimerRow(block);
    } catch (e) { console.error("[task-timing] timer delete failed (non-fatal):", e.message); }
    return { changed: true };
  }

  // THE RECONCILER — the derived half of "a ⌛ timer closes no matter which
  // surface finished the task".
  //
  // `blocks` is the itinerary read's own result set (it already carries each
  // date's day_root, so the `_done` overlay comes free — no extra query). Cheap
  // by construction: the candidate filter is pure in-memory, and a day with no
  // orphaned timer does zero DB work. Mutates the rows it finalizes so the very
  // response that triggered it is already correct.
  //
  // Read paths must never fail on this: every row is guarded individually and a
  // thrown error is logged, not propagated.
  async function reconcileTiming(blocks, { userId = null, workspaceId = null, maxRows = MAX_ROWS_PER_READ } = {}) {
    if (!Array.isArray(blocks) || !blocks.length) return 0;

    // Overlays first: the candidate predicate needs them to tell a row that still
    // needs work from one already settled, and that distinction has to be made
    // BEFORE the cap or already-derived rows would fill every slot and starve the
    // unsettled tail forever.
    const rootProps = new Map();
    for (const b of blocks) {
      if (b && b.type === "day_root") rootProps.set(String(b.date), b.properties || {});
    }

    const all = blocks.filter(b => {
      if (!b || b.type !== "block" || b.deleted_at) return false;
      const p = b.properties || {};
      // OUR OWN stamp is reconsidered regardless of startedAt: clearStart deletes
      // startedAt whenever completedAt is absent, which is always true of an
      // overlay-only completion, so gating on it would make a derived stamp
      // permanently unwithdrawable. But a derived row that is STILL done needs
      // nothing, so it is not a candidate at all.
      if (p.actualMinutesFrom === DERIVED_FLAG) return !isBlockDone(b, rootProps.get(String(b.date)) || null);
      // A human moved this row's minutes to another task. `startedAt` can outlive that
      // (an overlay-only completion never clears it), so without this arm the row falls
      // into the branch below and the reconciler re-derives the exact minutes the
      // reallocation removed, re-minting their timer row too. startWork clears the flag,
      // so restarting the task makes it settleable again.
      if (p.actualMinutesFrom === REALLOCATED_FLAG) return false;
      return !!p.startedAt && p.actualMinutes == null;
    });
    if (!all.length) return 0;
    // Bounded per read. unfinished-tasks.js loads the whole archive with no
    // lookback cap, so the first post-deploy range read could otherwise settle
    // hundreds of rows serially inside a GET the UI is waiting on. The tail
    // settles across the next few reads instead. Never silently: say what was left.
    const candidates = all.slice(0, maxRows);
    if (all.length > candidates.length) {
      console.log(`[task-timing] ${all.length} rows to reconcile, doing ${candidates.length} this read; the rest settle on later reads`);
    }

    let closed = 0;
    let withdrawn = 0;
    for (const block of candidates) {
      try {
        // RE-READ BEFORE WRITING. This runs on a read path, and db.js updateBlock
        // replaces `properties` WHOLESALE rather than merging, so persisting the
        // snapshot handed to us would destroy anything committed between the
        // caller's SELECT and this write — handleDone's completion stamps, or the
        // poller's title/permalink enrichment on exactly these Slack rows. Costs
        // one query per genuine candidate only; the common case never gets here.
        const fresh = await blockDB.getBlock(block.id);
        if (!fresh || fresh.deleted_at) continue;
        block.properties = fresh.properties || {};       // and keep the response truthful
        const props = block.properties;
        const derivedStamp = props.actualMinutesFrom === DERIVED_FLAG;
        // Re-qualify against the fresh row: it may have been settled already.
        if (!derivedStamp && (!props.startedAt || props.actualMinutes != null)) continue;

        const overlay = rootProps.get(String(block.date)) || null;
        if (!isBlockDone(block, overlay)) {
          if (!derivedStamp) continue;
          await clearTiming({ block });
          withdrawn++;
          continue;
        }
        // A prior read already derived the right answer and the task is still
        // done. Leave it stable until either an un-check clears it or a real
        // Slack ✅ calls finalizeTiming with derived=false and supersedes it.
        if (derivedStamp) continue;
        const endMs = completionMsOf(block, overlay);
        if (endMs == null) continue;             // no honest end time — leave it alone
        const res = await finalizeTiming({
          block, endMs, maxMinutes: MAX_TIMED_MINUTES,
          userId: userId || block.user_id || null,
          workspaceId: workspaceId || block.workspace_id || null,
          timerNote: "Slack ⌛ timer (closed on completion)",
          derived: true,
        });
        if (!res.changed) continue;
        closed++;
        // The segment was minted mid-read, so it is not in the rows we already
        // fetched. Fold it in or Day Review shows the time one refresh late.
        // Presence-checked so this stays right whatever the caller's array holds.
        if (res.timeEntry && !blocks.some(b => b && b.id === res.timeEntry.id)) blocks.push(res.timeEntry);
      } catch (e) {
        console.error(`[task-timing] reconcile failed for ${block.id} (non-fatal):`, e.message);
      }
    }
    // Counted separately: logging a WITHDRAWAL as a closure says the opposite of
    // what happened, which is exactly wrong when chasing a flapping row.
    if (closed || withdrawn) {
      console.log(`[task-timing] closed ${closed} orphaned ⌛ timer(s), withdrew ${withdrawn} derived stamp(s)`);
    }
    return closed + withdrawn;
  }

  return {
    finalizeTiming, clearTiming, reconcileTiming, timerIdFor, getSessions,
    startWork, pauseWork, completeWork, reopenWork,
    recomputeActualMinutes, reallocateTimeEntry,
  };
}

module.exports = createTaskTiming;
module.exports.createTaskTiming = createTaskTiming;
module.exports.computeTiming = computeTiming;
module.exports.isBlockDone = isBlockDone;
module.exports.completionMsOf = completionMsOf;
module.exports.doneIdsFromOverlay = doneIdsFromOverlay;
module.exports.blockIdentityKeys = blockIdentityKeys;
module.exports.stripTookNote = stripTookNote;
module.exports.TIMER_ID_SUFFIX = TIMER_ID_SUFFIX;
module.exports.TIMER_NOTE = TIMER_NOTE;
module.exports.DERIVED_FLAG = DERIVED_FLAG;
module.exports.REALLOCATED_FLAG = REALLOCATED_FLAG;
module.exports.REALLOC_BOOKKEEPING = REALLOC_BOOKKEEPING;
module.exports.MAX_TIMED_MINUTES = MAX_TIMED_MINUTES;
module.exports.positivePlannedMinutes = positivePlannedMinutes;
module.exports.plannedWindowOf = plannedWindowOf;
module.exports.splitSessionByLocalDay = splitSessionByLocalDay;
module.exports.sessionRowId = sessionRowId;
module.exports.isStaleWorkEvent = isStaleWorkEvent;
module.exports.entryWindow = entryWindow;
module.exports.planAllocations = planAllocations;
module.exports.reallocatedRowId = reallocatedRowId;
module.exports.MAX_ALLOCATION_PARTS = MAX_ALLOCATION_PARTS;
