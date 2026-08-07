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
// A ⌛ left running across days is a forgotten reaction, not 40 hours of work.
// The webhook path never had to care (a human pressed ✅), but reconcileTiming
// closes timers it finds lying around, so it needs a ceiling.
const MAX_TIMED_MINUTES = 16 * 60;
// Rows reconciled per read. A range read can span the entire archive, and each
// settle is several serial writes inside a GET the UI awaits.
const MAX_ROWS_PER_READ = 25;
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

// ── Factory ───────────────────────────────────────────────────────────────────

function createTaskTiming({ pool, blockDB, timeZone = "America/New_York" } = {}) {
  const fmt = (ms, opts) => new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(ms));
  const hhmm = (ms) => fmt(ms, { hour12: false, hour: "2-digit", minute: "2-digit" });   // "14:50"
  const human = (ms) => fmt(ms, { hour12: true, hour: "numeric", minute: "2-digit" })    // "2:50 PM" -> "2:50p"
    .replace(/\s?([AP])M$/i, (_, p) => p.toLowerCase());

  const timerIdFor = (blockId) => `${blockId}${TIMER_ID_SUFFIX}`;

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
    await blockDB.updateBlock(block.id, { properties: nextProps });
    block.properties = nextProps;                 // keep the caller's copy truthful

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
        // getBlock is this repo's read primitive and is tombstone-inclusive,
        // which is what this existence check wants.
        if (!(await blockDB.getBlock(teId))) {
          const date = block.date;
          const parentId = await blockDB.ensureDayRoot(date, userId, workspaceId);
          timeEntry = await blockDB.createBlock({
            id: teId, type: "time_entry", parent_id: parentId, date,
            properties: {
              blockId: block.id, taskTitle: title || props.title || "Slack task",
              start: hhmm(timing.startMs), end: hhmm(timing.endMs),
              durSec: timing.durSec, source: "slack", note: timerNote,
            },
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
  async function clearTiming({ block, mergeProps = null, dropProps = [] }) {
    if (!block || !block.id) return { changed: false };
    const props = block.properties || {};
    const nextProps = { ...props, ...(mergeProps || {}) };
    for (const key of dropProps) delete nextProps[key];
    delete nextProps.actualMinutes;
    delete nextProps.actualMinutesFrom;
    const stripped = stripTookNote(nextProps.notes);
    if (stripped) nextProps.notes = stripped; else delete nextProps.notes;
    await blockDB.updateBlock(block.id, { properties: nextProps });
    block.properties = nextProps;
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

  return { finalizeTiming, clearTiming, reconcileTiming, timerIdFor };
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
module.exports.MAX_TIMED_MINUTES = MAX_TIMED_MINUTES;
