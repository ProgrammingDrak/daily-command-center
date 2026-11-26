/**
 * journal-preferences-store.js
 *
 * One journal-preferences record per workspace, stored as a regular `block`
 * with properties.kind = "journal_preferences" (the schedule-settings-store.js
 * pattern, so pg-schema.js and db.js VALID_TYPES stay untouched). Each user has
 * exactly one workspace (ws-<userId>), so this follows the account across
 * browsers and devices.
 *
 * Holds the paper a fresh journal starts on: either a classic notebook paper
 * id (JournalNotebook.PAPER_TYPES) or ink paper-library settings
 * (InkStrokes.normalizePaper). Unknown values are rejected on write and read
 * back as "no preference", so a bad row can never break a journal.
 */

const blockDB = require("./db");
const JournalNotebook = require("./public/js/journal-notebook");
const InkStrokes = require("./public/js/ink/strokes");

const KIND = "journal_preferences";
const DEFAULT_PAPER = "dotted";

/** Returns { paper, paperSettings } or null when the value is not a legal paper. */
function normalizePaperPreference(raw) {
  if (!raw || typeof raw !== "object") return null;
  const settings = raw.paperSettings;
  if (settings !== undefined && settings !== null) {
    if (typeof settings !== "object" || !InkStrokes.PAPERS.some((p) => p.id === settings.type)) return null;
    return { paper: DEFAULT_PAPER, paperSettings: InkStrokes.normalizePaper(settings) };
  }
  if (!JournalNotebook.PAPER_TYPES.some((type) => type.id === raw.paper)) return null;
  return { paper: raw.paper, paperSettings: null };
}

async function findBlock(workspaceId, deps) {
  // getBlocksByKind drops the workspace predicate when workspaceId is falsy.
  if (!workspaceId) return null;
  const db = (deps && deps.blockDB) || blockDB;
  if (!db || typeof db.getBlocksByKind !== "function") return null;
  const rows = await db.getBlocksByKind(KIND, workspaceId, deps && deps.client);
  return rows && rows[0] ? rows[0] : null;
}

async function getJournalPreferences(workspaceId, deps) {
  const block = await findBlock(workspaceId, deps);
  const stored = block && block.properties ? normalizePaperPreference(block.properties.lastPaper) : null;
  return { lastPaper: stored, _source: stored ? "user" : "defaults" };
}

async function updateJournalPreferences(workspaceId, userId, patch, deps) {
  if (!workspaceId) throw new Error("Missing workspace");
  const db = (deps && deps.blockDB) || blockDB;
  const lastPaper = normalizePaperPreference(patch && patch.lastPaper);
  if (!lastPaper) throw new Error("Invalid journal paper");
  const existing = await findBlock(workspaceId, deps);
  if (!existing) {
    await db.createBlock({
      type: "block",
      parent_id: null,
      date: null,
      properties: { kind: KIND, lastPaper },
      sort_order: 0,
      user_id: userId || null,
      workspace_id: workspaceId,
    });
  } else {
    await db.updateBlock(existing.id, { properties: { ...(existing.properties || {}), kind: KIND, lastPaper } });
  }
  return getJournalPreferences(workspaceId, deps);
}

module.exports = { getJournalPreferences, updateJournalPreferences, normalizePaperPreference, KIND };
