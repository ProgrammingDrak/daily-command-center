/**
 * migrate.js — Data Migration from old JSON/localStorage system to SQLite blocks
 *
 * Reads data from:
 *   1. data/brain/recent/*.json (per-day user state: done, notes, actions, etc.)
 *   2. data/brain/globals.json (sticky notes, trivial tasks, life captures, etc.)
 *   3. data/state/day-state.json (PA-owned schedule/triage for today)
 *   4. data/state/archive/*.json (PA-owned state for past days)
 *   5. Browser localStorage dump (sent via POST body)
 *
 * Creates corresponding blocks in SQLite with deterministic IDs (idempotent).
 * Preserves all timestamps. Old files are archived, not deleted.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const blockDB = require("./db");

const DATA_DIR = path.join(__dirname, "data");
const BRAIN_DIR = path.join(DATA_DIR, "brain");
const RECENT_DIR = path.join(BRAIN_DIR, "recent");
const GLOBALS_FILE = path.join(BRAIN_DIR, "globals.json");
const STATE_DIR = path.join(DATA_DIR, "state");
const DAY_STATE_FILE = path.join(STATE_DIR, "day-state.json");
const ARCHIVE_DIR = path.join(STATE_DIR, "archive");
const PRE_MIGRATION_DIR = path.join(BRAIN_DIR, "archive", "pre-migration");

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

// Deterministic ID: hash of type + date + unique key → same data always gets same block ID
function deterministicId(type, ...parts) {
  const input = [type, ...parts].join("|");
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * Run the full migration. Returns a manifest of what was migrated.
 * If dryRun=true, reads everything but doesn't write to SQLite.
 */
function runMigration(db, { dryRun = false, localStorageDump = null } = {}) {
  const manifest = {
    dryRun,
    startedAt: new Date().toISOString(),
    dates: [],
    globals: { stickyNotes: 0, trivialTasks: 0, lifeCaptures: 0, pendingTasks: 0 },
    perDate: {},
    paState: { dates: 0 },
    errors: [],
    totalBlocks: 0
  };

  // Step 1: Archive old files (only on real run)
  if (!dryRun) {
    archiveOldFiles(manifest);
  }

  // Step 2: Discover all dates from brain/recent + state/archive
  const dates = discoverDates();
  manifest.dates = dates;

  // Step 3: Migrate per-day user state
  for (const date of dates) {
    const dateManifest = { blocks: 0, done: 0, notes: 0, actions: 0, subtasks: 0, sessions: 0, engrams: 0, moods: 0, addedTasks: 0 };
    try {
      // Load brain state for this date (user edits)
      let brainState = loadBrainState(date, localStorageDump);
      if (brainState) {
        migrateDayUserState(db, date, brainState, dateManifest, dryRun);
      }
    } catch (e) {
      manifest.errors.push({ date, error: e.message });
    }
    manifest.perDate[date] = dateManifest;
    manifest.totalBlocks += dateManifest.blocks;
  }

  // Step 4: Migrate PA-owned state (schedule, triage, meetings)
  try {
    migratePaState(db, manifest, dryRun);
  } catch (e) {
    manifest.errors.push({ source: "pa-state", error: e.message });
  }

  // Step 5: Migrate globals
  try {
    migrateGlobals(db, manifest, localStorageDump, dryRun);
  } catch (e) {
    manifest.errors.push({ source: "globals", error: e.message });
  }

  manifest.completedAt = new Date().toISOString();
  return manifest;
}

function discoverDates() {
  const dates = new Set();

  // From brain/recent
  if (fs.existsSync(RECENT_DIR)) {
    for (const f of fs.readdirSync(RECENT_DIR)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) dates.add(m[1]);
    }
  }

  // From state/archive
  if (fs.existsSync(ARCHIVE_DIR)) {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) dates.add(m[1]);
    }
  }

  // Current day-state
  const dayState = readJSON(DAY_STATE_FILE, null);
  if (dayState && dayState.date) dates.add(dayState.date);

  return [...dates].sort();
}

function loadBrainState(date, localStorageDump) {
  // Priority: localStorage dump > brain/recent file
  if (localStorageDump) {
    const fromLS = extractDateFromLocalStorage(date, localStorageDump);
    if (fromLS && Object.keys(fromLS).length > 2) return fromLS; // has more than just date+collectedAt
  }

  const filePath = path.join(RECENT_DIR, `${date}.json`);
  if (fs.existsSync(filePath)) {
    return readJSON(filePath, null);
  }

  return null;
}

function extractDateFromLocalStorage(date, dump) {
  if (!dump) return null;
  const state = { date };
  const prefix = "pa-";
  const keyMap = {
    [`pa-done-${date}`]: "done",
    [`pa-pushed-${date}`]: "pushed",
    [`pa-deleted-${date}`]: "deleted",
    [`pa-dur-${date}`]: "durChanges",
    [`pa-notes-${date}`]: "notes",
    [`pa-actions-${date}`]: "actions",
    [`pa-dismissed-${date}`]: "dismissed",
    [`pa-sessions-${date}`]: "sessions",
    [`pa-deferred-${date}`]: "deferred",
    [`pa-pomo-state-${date}`]: "pomo",
    [`pa-reviewed-${date}`]: "reviewed",
    [`pa-subtasks-${date}`]: "subtasks",
    [`pa-trivial-flags-${date}`]: "trivialFlags",
    [`pa-engrams-${date}`]: "engrams",
    [`pa-mood-${date}`]: "mood",
    [`pa-added-tasks-${date}`]: "addedTasks",
  };
  for (const [lsKey, stateKey] of Object.entries(keyMap)) {
    if (dump[lsKey]) {
      try {
        state[stateKey] = typeof dump[lsKey] === "string" ? JSON.parse(dump[lsKey]) : dump[lsKey];
      } catch {}
    }
  }
  return state;
}

function migrateDayUserState(db, date, state, dateManifest, dryRun) {
  if (dryRun) {
    // Count what would be migrated
    countUserState(state, dateManifest);
    return;
  }

  const dayRootId = blockDB.ensureDayRoot(db, date);

  // Migrate done/pushed/deleted state — these become properties on schedule_item blocks
  // We'll create lightweight marker blocks that record the user's state changes.
  // When Phase 4 runs, these get merged into the actual schedule_item blocks.

  // Migrate notes (per-task)
  if (state.notes && typeof state.notes === "object") {
    for (const [taskId, noteData] of Object.entries(state.notes)) {
      if (!noteData) continue;
      const html = typeof noteData === "string" ? noteData : (noteData.html || "");
      const text = typeof noteData === "string" ? noteData : (noteData.text || "");
      if (!html && !text) continue;

      const id = deterministicId("note", date, taskId);
      if (!blockDB.getBlock(db, id)) {
        blockDB.createBlock(db, {
          id, type: "note", parent_id: dayRootId, date,
          properties: { html, text, _sourceTaskId: taskId },
          sort_order: 0
        });
      }
      dateManifest.notes++;
      dateManifest.blocks++;
    }
  }

  // Migrate action items (per-task)
  if (state.actions && typeof state.actions === "object") {
    for (const [taskId, items] of Object.entries(state.actions)) {
      if (!Array.isArray(items)) continue;
      items.forEach((item, i) => {
        const id = deterministicId("action_item", date, taskId, i.toString());
        if (!blockDB.getBlock(db, id)) {
          blockDB.createBlock(db, {
            id, type: "action_item", parent_id: dayRootId, date,
            properties: {
              text: item.text || "",
              priority: item.priority || "Medium",
              done: !!item.done,
              _sourceTaskId: taskId,
              ...(item.created ? { created: item.created } : {}),
              ...(item.scheduled ? { scheduled: item.scheduled } : {}),
              ...(item.scheduledAt ? { scheduledAt: item.scheduledAt } : {})
            },
            sort_order: i
          });
        }
        dateManifest.actions++;
        dateManifest.blocks++;
      });
    }
  }

  // Migrate subtasks (per-task)
  if (state.subtasks && typeof state.subtasks === "object") {
    for (const [taskId, subs] of Object.entries(state.subtasks)) {
      if (!Array.isArray(subs)) continue;
      subs.forEach((sub, i) => {
        const id = deterministicId("subtask", date, taskId, i.toString());
        if (!blockDB.getBlock(db, id)) {
          blockDB.createBlock(db, {
            id, type: "subtask", parent_id: dayRootId, date,
            properties: {
              text: sub.text || "",
              done: !!sub.done,
              _sourceTaskId: taskId
            },
            sort_order: i
          });
        }
        dateManifest.subtasks++;
        dateManifest.blocks++;
      });
    }
  }

  // Migrate engrams
  if (Array.isArray(state.engrams)) {
    state.engrams.forEach((engram, i) => {
      if (!engram || !engram.tag) return;
      const id = deterministicId("engram", date, engram.tag, i.toString());
      if (!blockDB.getBlock(db, id)) {
        blockDB.createBlock(db, {
          id, type: "engram", parent_id: dayRootId, date,
          properties: {
            tag: engram.tag,
            name: engram.name || engram.tag,
            category: engram.category || "",
            context: engram.context || ""
          },
          sort_order: i
        });
      }
      dateManifest.engrams++;
      dateManifest.blocks++;
    });
  }

  // Migrate mood entries
  if (state.mood && state.mood.entries && Array.isArray(state.mood.entries)) {
    state.mood.entries.forEach((entry, i) => {
      const id = deterministicId("mood_entry", date, i.toString());
      if (!blockDB.getBlock(db, id)) {
        blockDB.createBlock(db, {
          id, type: "mood_entry", parent_id: dayRootId, date,
          properties: {
            mood: entry.mood || 3,
            energy: entry.energy || 3,
            time: entry.time || "",
            note: entry.note || ""
          },
          sort_order: i
        });
      }
      dateManifest.moods++;
      dateManifest.blocks++;
    });
  }

  // Migrate pomo sessions
  if (state.pomo && state.pomo.sessionLog && Array.isArray(state.pomo.sessionLog)) {
    // Create pomo_state container
    const pomoId = deterministicId("pomo_state", date);
    if (!blockDB.getBlock(db, pomoId)) {
      blockDB.createBlock(db, {
        id: pomoId, type: "pomo_state", parent_id: dayRootId, date,
        properties: {
          sessions: state.pomo.sessions || 0,
          taskTime: state.pomo.taskTime || {}
        },
        sort_order: 0
      });
    }
    state.pomo.sessionLog.forEach((session, i) => {
      const sessId = deterministicId("pomo_session", date, i.toString());
      if (!blockDB.getBlock(db, sessId)) {
        blockDB.createBlock(db, {
          id: sessId, type: "pomo_session", parent_id: pomoId, date,
          properties: {
            title: session.title || "",
            durSec: session.durSec || 0,
            type: session.type || "work",
            time: session.time || ""
          },
          sort_order: i
        });
      }
      dateManifest.sessions++;
      dateManifest.blocks++;
    });
  }

  // Migrate added tasks
  if (Array.isArray(state.addedTasks)) {
    state.addedTasks.forEach((task, i) => {
      if (!task || !task.title) return;
      const id = deterministicId("added_task", date, task.id || task.title);
      if (!blockDB.getBlock(db, id)) {
        blockDB.createBlock(db, {
          id, type: "added_task", parent_id: dayRootId, date,
          properties: {
            title: task.title,
            durMin: task.durMin || 30,
            detail: task.detail || "",
            source: task.source || "manual",
            notionUrl: task.notionUrl || "",
            priority: task.priority || "Medium",
            meta: task.meta || ""
          },
          sort_order: i
        });
      }
      dateManifest.addedTasks++;
      dateManifest.blocks++;
    });
  }

  // Store done/pushed/deleted as a consolidated state block for this date
  // This preserves the user's task state for Phase 4 to consume
  const doneIds = state.done?.ids || [];
  const doneAt = state.done?.at || {};
  const pushedIds = state.pushed?.ids || [];
  const pushedAt = state.pushed?.at || {};
  const deletedIds = Array.isArray(state.deleted) ? state.deleted : [];
  const durChanges = state.durChanges || {};

  if (doneIds.length || pushedIds.length || deletedIds.length || Object.keys(durChanges).length) {
    const stateId = deterministicId("_day_user_state", date);
    if (!blockDB.getBlock(db, stateId)) {
      // Store as a special internal block type — we need to add it
      // For now, use day_root properties to stash this
      const root = blockDB.getBlock(db, dayRootId);
      if (root) {
        blockDB.updateBlock(db, dayRootId, {
          properties: {
            date,
            _migratedDone: { ids: doneIds, at: doneAt },
            _migratedPushed: { ids: pushedIds, at: pushedAt },
            _migratedDeleted: deletedIds,
            _migratedDurChanges: durChanges
          }
        });
      }
    }
    dateManifest.done = doneIds.length;
    dateManifest.blocks++;
  }
}

function countUserState(state, dateManifest) {
  if (state.notes) dateManifest.notes = Object.keys(state.notes).length;
  if (state.actions) {
    for (const items of Object.values(state.actions)) {
      if (Array.isArray(items)) dateManifest.actions += items.length;
    }
  }
  if (state.subtasks) {
    for (const subs of Object.values(state.subtasks)) {
      if (Array.isArray(subs)) dateManifest.subtasks += subs.length;
    }
  }
  if (Array.isArray(state.engrams)) dateManifest.engrams = state.engrams.length;
  if (state.mood?.entries) dateManifest.moods = state.mood.entries.length;
  if (state.pomo?.sessionLog) dateManifest.sessions = state.pomo.sessionLog.length;
  if (Array.isArray(state.addedTasks)) dateManifest.addedTasks = state.addedTasks.length;
  if (state.done?.ids) dateManifest.done = state.done.ids.length;
  dateManifest.blocks = dateManifest.notes + dateManifest.actions + dateManifest.subtasks +
    dateManifest.engrams + dateManifest.moods + dateManifest.sessions + dateManifest.addedTasks +
    (dateManifest.done > 0 ? 1 : 0);
}

function migratePaState(db, manifest, dryRun) {
  // Migrate current day-state
  const dayState = readJSON(DAY_STATE_FILE, null);
  if (dayState && dayState.date) {
    if (!dryRun) {
      blockDB.savePaState(db, dayState.date, dayState);
    }
    manifest.paState.dates++;
  }

  // Migrate archived day-states
  if (fs.existsSync(ARCHIVE_DIR)) {
    for (const f of fs.readdirSync(ARCHIVE_DIR)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const archState = readJSON(path.join(ARCHIVE_DIR, f), null);
      if (archState) {
        if (!dryRun) {
          blockDB.savePaState(db, m[1], archState);
        }
        manifest.paState.dates++;
      }
    }
  }
}

function migrateGlobals(db, manifest, localStorageDump, dryRun) {
  const globals = readJSON(GLOBALS_FILE, {});

  // Also check localStorage dump for globals
  if (localStorageDump) {
    const lsGlobals = {
      stickyNotes: tryParse(localStorageDump["pa-sticky-notes"], []),
      trivialTasks: tryParse(localStorageDump["pa-trivial-tasks"], []),
      lifeCaptures: tryParse(localStorageDump["pa-life-captures"], []),
      pendingTasks: tryParse(localStorageDump["pa-pending-tasks"], []),
    };
    // Prefer localStorage if it has more data
    for (const [key, val] of Object.entries(lsGlobals)) {
      if (Array.isArray(val) && val.length > (globals[key]?.length || 0)) {
        globals[key] = val;
      }
    }
  }

  // Sticky notes
  if (Array.isArray(globals.stickyNotes)) {
    globals.stickyNotes.forEach((note, i) => {
      if (!note) return;
      const id = deterministicId("sticky_note", note.id || i.toString());
      manifest.globals.stickyNotes++;
      manifest.totalBlocks++;
      if (dryRun) return;
      if (blockDB.getBlock(db, id)) return;
      blockDB.createBlock(db, {
        id, type: "sticky_note",
        properties: {
          html: note.html || "",
          text: note.text || note.html?.replace(/<[^>]*>/g, "") || ""
        },
        sort_order: i
      });
    });
  }

  // Trivial tasks
  if (Array.isArray(globals.trivialTasks)) {
    globals.trivialTasks.forEach((task, i) => {
      if (!task) return;
      const id = deterministicId("trivial_task", task.id || task.text || i.toString());
      manifest.globals.trivialTasks++;
      manifest.totalBlocks++;
      if (dryRun) return;
      if (blockDB.getBlock(db, id)) return;
      blockDB.createBlock(db, {
        id, type: "trivial_task",
        properties: {
          text: task.text || "",
          done: !!task.done,
          ...(task.doneAt ? { doneAt: task.doneAt } : {})
        },
        sort_order: i
      });
    });
  }

  // Life captures
  if (Array.isArray(globals.lifeCaptures)) {
    globals.lifeCaptures.forEach((cap, i) => {
      if (!cap) return;
      const id = deterministicId("life_capture", cap.id || cap.text || i.toString());
      manifest.globals.lifeCaptures++;
      manifest.totalBlocks++;
      if (dryRun) return;
      if (blockDB.getBlock(db, id)) return;
      blockDB.createBlock(db, {
        id, type: "life_capture",
        properties: {
          text: cap.text || "",
          category: cap.category || "",
          mood: cap.mood || 0,
          context: cap.context || ""
        },
        sort_order: i
      });
    });
  }

  // Pending tasks
  const pendingTasks = globals.pendingTasks || tryParse(localStorageDump?.["pa-pending-tasks"], []);
  if (Array.isArray(pendingTasks)) {
    pendingTasks.forEach((task, i) => {
      if (!task || !task.title) return;
      const id = deterministicId("pending_task", task.id || task.title);
      manifest.globals.pendingTasks++;
      manifest.totalBlocks++;
      if (dryRun) return;
      if (blockDB.getBlock(db, id)) return;
      blockDB.createBlock(db, {
        id, type: "pending_task",
        properties: {
          title: task.title,
          priority: task.priority || "Medium",
          source_task: task.source_task || "",
          source_task_id: task.source_task_id || "",
          status: task.status || "queued",
          ...(task.created_at ? { created_at: task.created_at } : {})
        },
        sort_order: i
      });
    });
  }
}

function archiveOldFiles(manifest) {
  // Create pre-migration archive directory
  if (!fs.existsSync(PRE_MIGRATION_DIR)) {
    fs.mkdirSync(PRE_MIGRATION_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveSubDir = path.join(PRE_MIGRATION_DIR, `migration-${timestamp}`);
  fs.mkdirSync(archiveSubDir, { recursive: true });

  // Copy (not move) brain/recent files
  if (fs.existsSync(RECENT_DIR)) {
    const recentArchive = path.join(archiveSubDir, "recent");
    fs.mkdirSync(recentArchive, { recursive: true });
    for (const f of fs.readdirSync(RECENT_DIR)) {
      fs.copyFileSync(path.join(RECENT_DIR, f), path.join(recentArchive, f));
    }
  }

  // Copy globals
  if (fs.existsSync(GLOBALS_FILE)) {
    fs.copyFileSync(GLOBALS_FILE, path.join(archiveSubDir, "globals.json"));
  }

  // Copy day-state
  if (fs.existsSync(DAY_STATE_FILE)) {
    fs.copyFileSync(DAY_STATE_FILE, path.join(archiveSubDir, "day-state.json"));
  }

  manifest._archivePath = archiveSubDir;
}

function tryParse(val, fallback) {
  if (val === undefined || val === null) return fallback;
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); }
  catch { return fallback; }
}

module.exports = { runMigration, discoverDates, deterministicId };
