const crypto = require("crypto");
const { google } = require("googleapis");
const blockDB = require("./db");
const gcalAuth = require("./gcal-auth");
const pool = require("./pg-pool");

const AUTOMATION_KINDS = new Set([
  "meeting_prep",
  "meeting_transcript",
  "meeting_summary",
  "proposed_action_item",
]);

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseJSON(v, fallback) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function propsOf(block) {
  return block && block.properties ? block.properties : {};
}

function titleOf(block) {
  const p = propsOf(block);
  return p.title || p.label || p.summary || "(Untitled meeting)";
}

function tokenizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 3 && !["meeting", "sync", "weekly", "daily", "with"].includes(w))
    .slice(0, 5);
}

function attendeeEmails(gcalRow) {
  const attendees = parseJSON(gcalRow && gcalRow.attendees_json, []);
  return attendees
    .filter(a => a && a.email && !a.resource && !a.self)
    .map(a => a.email)
    .filter(Boolean);
}

function extractAttachments(gcalRow) {
  const raw = parseJSON(gcalRow && gcalRow.raw_json, {});
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  return attachments.map(a => ({
    type: "calendar_attachment",
    title: a.title || a.fileUrl || "Calendar attachment",
    url: a.fileUrl || a.iconLink || null,
    mimeType: a.mimeType || null,
    sourceId: a.fileId || null,
  }));
}

function buildGmailQuery(meeting, gcalRow) {
  const attendees = attendeeEmails(gcalRow);
  const titleTerms = tokenizeTitle(titleOf(meeting));
  const people = attendees.slice(0, 6).map(email => `{from:${email} OR to:${email}}`);
  const topic = titleTerms.length ? `(${titleTerms.join(" OR ")})` : "";
  const pieces = [...people, topic, "newer_than:90d"];
  return pieces.filter(Boolean).join(" ");
}

function sourceBundle(meeting, gcalRow) {
  const p = propsOf(meeting);
  const sources = [];
  sources.push({
    type: "calendar_event",
    title: titleOf(meeting),
    url: p.calUrl || (gcalRow && gcalRow.html_link) || null,
    sourceId: p.source_id || (gcalRow && gcalRow.gcal_event_id) || meeting.id,
  });
  for (const att of extractAttachments(gcalRow)) sources.push(att);
  const query = buildGmailQuery(meeting, gcalRow);
  if (query) {
    sources.push({
      type: "gmail_query",
      title: "Scoped Gmail evidence search",
      query,
      status: "candidate",
      note: "Run against attendee emails plus title keywords; current app OAuth is Calendar-only, so this is recorded for review/connector execution.",
    });
  }
  return sources;
}

async function discoverGmailSources(meeting, gcalRow, userId) {
  const query = buildGmailQuery(meeting, gcalRow);
  if (!query || !userId) return [];
  try {
    const accountKey = (gcalRow && gcalRow.account_key) || gcalAuth.DEFAULT_ACCOUNT_KEY;
    const auth = await gcalAuth.getAuthClient(userId, accountKey);
    if (!auth) return [];
    const gmail = google.gmail({ version: "v1", auth });
    const listed = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 5 });
    const messages = listed.data.messages || [];
    const sources = [];
    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });
      const headers = detail.data.payload && detail.data.payload.headers ? detail.data.payload.headers : [];
      const header = name => (headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";
      sources.push({
        type: "gmail_message",
        title: header("Subject") || "Gmail evidence",
        from: header("From") || null,
        date: header("Date") || null,
        snippet: detail.data.snippet || "",
        url: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
        sourceId: msg.id,
      });
    }
    return sources;
  } catch (e) {
    return [{
      type: "gmail_query",
      title: "Scoped Gmail evidence search",
      query,
      status: "needs_reauth_or_connector",
      note: "Gmail search could not run from DCC. Reconnect Google after Gmail readonly scope is available, or run this query through the Gmail connector.",
      error: e.message,
    }];
  }
}

async function loadGcalRow(blockId) {
  const normalizedBlockId = String(blockId || "").startsWith("mtg-") ? String(blockId).slice(4) : blockId;
  // gcal_events is the legacy realtime-sync cache (attendee/attachment metadata).
  // Realtime GCal sync is disabled and the table isn't in pg-schema, so it may be
  // absent entirely. It only enriches prep sourcing — a miss must degrade to null,
  // never 500 the whole automation call (which ends by re-serializing via here).
  try {
    const { rows } = await pool.query("SELECT * FROM gcal_events WHERE block_id = $1 LIMIT 1", [normalizedBlockId]);
    return rows[0] || null;
  } catch (e) {
    console.error("[meeting-automation] gcal_events lookup skipped:", e.message);
    return null;
  }
}

async function loadMeeting(blockId, workspaceId) {
  const normalizedBlockId = String(blockId || "").startsWith("mtg-") ? String(blockId).slice(4) : blockId;
  const meeting = await blockDB.getBlock(normalizedBlockId);
  if (!meeting || meeting.deleted_at) {
    const err = new Error("Meeting block not found");
    err.statusCode = 404;
    throw err;
  }
  if (meeting.workspace_id && workspaceId && meeting.workspace_id !== workspaceId) {
    const err = new Error("Meeting block not found");
    err.statusCode = 404;
    throw err;
  }
  const p = propsOf(meeting);
  const isMeeting = p.source === "gcal" || p.type === "meeting" || p.type === "oneone" || p.gcal_event_id || p.source_id;
  if (!isMeeting) {
    const err = new Error("Block is not a calendar meeting");
    err.statusCode = 400;
    throw err;
  }
  return meeting;
}

async function loadArtifacts(blockId, workspaceId) {
  const children = await blockDB.getChildren(blockId, workspaceId);
  return children.filter(b => AUTOMATION_KINDS.has(propsOf(b).kind));
}

function newestByKind(artifacts, kind) {
  return artifacts
    .filter(b => propsOf(b).kind === kind)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
}

function serializeBundle(meeting, gcalRow, artifacts) {
  const byKind = {};
  for (const kind of AUTOMATION_KINDS) byKind[kind] = [];
  for (const artifact of artifacts) {
    const p = propsOf(artifact);
    byKind[p.kind].push({ id: artifact.id, ...p, created_at: artifact.created_at, updated_at: artifact.updated_at });
  }
  return {
    meeting: {
      id: meeting.id,
      date: meeting.date,
      title: titleOf(meeting),
      start: propsOf(meeting).start || null,
      end: propsOf(meeting).end || null,
      calUrl: propsOf(meeting).calUrl || (gcalRow && gcalRow.html_link) || null,
      attendees: attendeeEmails(gcalRow),
    },
    prep: newestByKind(artifacts, "meeting_prep") ? { id: newestByKind(artifacts, "meeting_prep").id, ...propsOf(newestByKind(artifacts, "meeting_prep")) } : null,
    transcript: newestByKind(artifacts, "meeting_transcript") ? { id: newestByKind(artifacts, "meeting_transcript").id, ...propsOf(newestByKind(artifacts, "meeting_transcript")) } : null,
    summary: newestByKind(artifacts, "meeting_summary") ? { id: newestByKind(artifacts, "meeting_summary").id, ...propsOf(newestByKind(artifacts, "meeting_summary")) } : null,
    proposedActions: byKind.proposed_action_item,
    artifacts: byKind,
  };
}

function markdownToHtml(markdown) {
  return String(markdown || "")
    .split(/\n{2,}/)
    .map(chunk => {
      if (/^###\s+/.test(chunk)) return `<h4>${esc(chunk.replace(/^###\s+/, ""))}</h4>`;
      if (/^-\s+/m.test(chunk)) {
        const items = chunk.split(/\n/).filter(Boolean).map(line => `<li>${esc(line.replace(/^-\s+/, ""))}</li>`).join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${esc(chunk).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function buildPrepMarkdown(meeting, gcalRow, sources) {
  const p = propsOf(meeting);
  const attendees = attendeeEmails(gcalRow);
  const description = p.detail || (gcalRow && gcalRow.description) || "";
  const attachments = sources.filter(s => s.type === "calendar_attachment");
  const gmailSource = sources.find(s => s.type === "gmail_query");
  const lines = [
    "### Meeting Prep",
    `- Topic: ${titleOf(meeting)}`,
    p.start && p.end ? `- Time: ${p.start} - ${p.end}` : null,
    attendees.length ? `- People: ${attendees.join(", ")}` : "- People: No attendee metadata synced yet.",
    description ? `- Calendar context: ${description.replace(/\s+/g, " ").slice(0, 500)}` : "- Calendar context: No description on the synced event.",
    attachments.length ? `- Attachments to review: ${attachments.map(a => a.title).join(", ")}` : "- Attachments to review: none found on the calendar event.",
    gmailSource ? `- Gmail evidence query: ${gmailSource.query}` : null,
    "",
    "### Suggested Readiness Check",
    "- Confirm the desired outcome for this meeting.",
    "- Review open action items tied to this meeting card.",
    "- Scan the cited calendar/Gmail evidence before the meeting starts.",
  ].filter(Boolean);
  return lines.join("\n");
}

async function upsertArtifact({ meeting, workspaceId, userId, kind, properties, sortOrder }) {
  const artifacts = await loadArtifacts(meeting.id, workspaceId);
  const existing = newestByKind(artifacts, kind);
  const nextProps = {
    ...propsOf(existing),
    ...properties,
    kind,
    meetingBlockId: meeting.id,
    generatedAt: new Date().toISOString(),
  };
  if (existing && kind !== "proposed_action_item") {
    return blockDB.updateBlock(existing.id, { properties: nextProps, date: meeting.date, parent_id: meeting.id });
  }
  return blockDB.createBlock({
    id: properties.id,
    type: "block",
    parent_id: meeting.id,
    date: meeting.date,
    properties: nextProps,
    sort_order: sortOrder || 0,
    user_id: userId,
    workspace_id: workspaceId,
  });
}

// Flip the meeting BLOCK's own prep_status to "ready" once a prep brief exists,
// so the itinerary prep chip (data.js/persistence.js -> ev.prepStatus) turns from
// pending to ready. The materializer stamps "pending" at birth; this is the other
// half. Reloads the block first so we never clobber a concurrent notes/recap write.
async function markPrepReady(meetingId) {
  try {
    const fresh = await blockDB.getBlock(meetingId);
    if (!fresh) return;
    const fp = propsOf(fresh);
    if (fp.prep_status === "ready") return;
    await blockDB.updateBlock(meetingId, { properties: { ...fp, prep_status: "ready" } });
  } catch (e) {
    console.error("[meeting-automation] markPrepReady failed (non-fatal):", e.message);
  }
}

async function getAutomation(blockId, workspaceId) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const gcalRow = await loadGcalRow(blockId);
  const artifacts = await loadArtifacts(blockId, workspaceId);
  return serializeBundle(meeting, gcalRow, artifacts);
}

async function generatePrep(blockId, { workspaceId, userId, extraSources = [] }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const gcalRow = await loadGcalRow(blockId);
  const baseSources = sourceBundle(meeting, gcalRow);
  const gmailSources = await discoverGmailSources(meeting, gcalRow, userId);
  const sources = [
    ...baseSources.filter(s => s.type !== "gmail_query" || gmailSources.length === 0),
    ...gmailSources,
    ...extraSources,
  ];
  const markdown = buildPrepMarkdown(meeting, gcalRow, sources);
  await upsertArtifact({
    meeting,
    workspaceId,
    userId,
    kind: "meeting_prep",
    sortOrder: 100,
    properties: {
      title: `Prep: ${titleOf(meeting)}`,
      status: "draft",
      markdown,
      html: markdownToHtml(markdown),
      sources,
    },
  });
  // Fallback fill: a template prep now exists, so the chip should read "ready".
  await markPrepReady(meeting.id);
  return getAutomation(blockId, workspaceId);
}

function summarizeTranscript(text) {
  const clean = String(text || "").replace(/\r/g, "").trim();
  if (!clean) return "No transcript text provided.";
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, 5).join(" ").slice(0, 1200) || clean.slice(0, 1200);
}

function extractActionCandidates(text) {
  const candidates = [];
  const lines = String(text || "").split(/\n+/).map(l => l.trim()).filter(Boolean);
  const actionRe = /\b(action item|todo|to-do|follow up|follow-up|next step|will|need to|needs to|should)\b/i;
  for (const line of lines) {
    if (!actionRe.test(line)) continue;
    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/^(action item|todo|to-do|follow up|follow-up|next step)\s*[:\-]\s*/i, "")
      .trim();
    if (cleaned.length < 5) continue;
    candidates.push(cleaned.slice(0, 220));
  }
  return [...new Set(candidates)].slice(0, 12);
}

async function ingestTranscript(blockId, { workspaceId, userId, transcriptText, sources = [] }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const text = String(transcriptText || "").trim();
  const storedText = text.length > 85000 ? text.slice(0, 85000) : text;
  const transcriptId = crypto.createHash("sha1").update(meeting.id + "|" + text).digest("hex");
  await upsertArtifact({
    meeting,
    workspaceId,
    userId,
    kind: "meeting_transcript",
    sortOrder: 200,
    properties: {
      title: `Transcript: ${titleOf(meeting)}`,
      status: text ? "ingested" : "empty",
      transcriptHash: transcriptId,
      text: storedText,
      originalLength: text.length,
      truncated: storedText.length !== text.length,
      sources,
    },
  });
  const summaryText = summarizeTranscript(text);
  await upsertArtifact({
    meeting,
    workspaceId,
    userId,
    kind: "meeting_summary",
    sortOrder: 210,
    properties: {
      title: `Summary: ${titleOf(meeting)}`,
      status: "draft",
      markdown: `### Meeting Summary\n${summaryText}`,
      html: markdownToHtml(`### Meeting Summary\n${summaryText}`),
      sources,
    },
  });

  const existing = await loadArtifacts(meeting.id, workspaceId);
  const existingTexts = new Set(existing.filter(b => propsOf(b).kind === "proposed_action_item").map(b => (propsOf(b).text || "").toLowerCase()));
  const createdActions = [];
  for (const [idx, actionText] of extractActionCandidates(text).entries()) {
    if (existingTexts.has(actionText.toLowerCase())) continue;
    createdActions.push(await upsertArtifact({
      meeting,
      workspaceId,
      userId,
      kind: "proposed_action_item",
      sortOrder: 300 + idx,
      properties: {
        title: actionText,
        text: actionText,
        priority: "Medium",
        status: "proposed",
        done: false,
        sources,
      },
    }));
  }
  return { ...(await getAutomation(blockId, workspaceId)), createdActionCount: createdActions.length };
}

async function approveActions(blockId, { workspaceId, userId, actionIds = [] }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const artifacts = await loadArtifacts(blockId, workspaceId);
  const proposals = artifacts.filter(b => propsOf(b).kind === "proposed_action_item" && propsOf(b).status !== "approved");
  const selected = actionIds.length ? proposals.filter(b => actionIds.includes(b.id)) : proposals;
  const created = [];
  for (const proposal of selected) {
    const p = propsOf(proposal);
    const action = await blockDB.createBlock({
      type: "block",
      parent_id: meeting.id,
      date: meeting.date,
      properties: {
        text: p.text || p.title,
        title: p.text || p.title,
        priority: p.priority || "Medium",
        done: false,
        created: new Date().toISOString(),
        tags: ["action-item"],
        _sourceTaskId: `mtg-${meeting.id}`,
        meetingAutomation: {
          meetingBlockId: meeting.id,
          proposedActionId: proposal.id,
          approvedAt: new Date().toISOString(),
        },
      },
      sort_order: 500 + created.length,
      user_id: userId,
      workspace_id: workspaceId,
    });
    created.push(action);
    await blockDB.updateBlock(proposal.id, {
      properties: { ...p, status: "approved", approvedAt: new Date().toISOString(), approvedBlockId: action.id },
    });
  }
  return { ...(await getAutomation(blockId, workspaceId)), approvedCount: created.length, approvedBlocks: created };
}

// Place an already-approved action onto a day. approveActions leaves each action
// as a child of the meeting (parent_id = meeting.id, tags:["action-item"]); this
// promotes one to a standalone day task: kind:"task" so the client fold admits it
// (persistence.js), parent_id detached, and a real date (plus an optional pinned
// start). Declining placement in the UI just never calls this, so the action stays
// under the meeting exactly as before.
async function placeApprovedAction(blockId, actionBlockId, { workspaceId, userId, date, start = null }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    const err = new Error("Invalid date (want YYYY-MM-DD)"); err.statusCode = 400; throw err;
  }
  const action = await blockDB.getBlock(actionBlockId);
  if (!action || action.deleted_at) {
    const err = new Error("Action block not found"); err.statusCode = 404; throw err;
  }
  if (action.workspace_id && workspaceId && action.workspace_id !== workspaceId) {
    const err = new Error("Action block not found"); err.statusCode = 404; throw err;
  }
  const p = propsOf(action);
  // Only place an action that actually belongs to this meeting (child link or the
  // meetingAutomation provenance stamp), so a stray id can't be reparented.
  const belongs = String(action.parent_id || "") === String(meeting.id) ||
    ((p.meetingAutomation || {}).meetingBlockId === meeting.id);
  if (!belongs) {
    const err = new Error("Action does not belong to this meeting"); err.statusCode = 400; throw err;
  }
  const nextProps = { ...p, kind: "task" };
  if (start && /^([01]\d|2[0-3]):[0-5]\d$/.test(start)) {
    nextProps.start = start;
    nextProps._pinnedStart = start;
  }
  await blockDB.updateBlock(action.id, { properties: nextProps, parent_id: null, date });
  return { ok: true, actionBlockId: action.id, date, start: nextProps.start || null };
}

// Merge an auto-generated recap into a meeting block's own notes without
// clobbering anything the user typed. The recap lives below a stable marker, so
// a re-post replaces only its own region (idempotent) and leaves user notes above.
function mergeRecapIntoNotes(existingNotes, recapMarkdown) {
  const HEADER = "_Meeting recap (auto):_";
  const SEP = `\n\n---\n${HEADER}\n\n`;
  const base = String(existingNotes || "");
  const idx = base.indexOf(HEADER);
  const userPart = (idx >= 0 ? base.slice(0, idx).replace(/\n*-*\n*\s*$/, "") : base).replace(/\s+$/, "");
  const recap = String(recapMarkdown || "").trim();
  if (!recap) return userPart;
  return userPart ? `${userPart}${SEP}${recap}` : `${HEADER}\n\n${recap}`;
}

// Artifact HTML is always rendered into the meeting panel via innerHTML, and
// source URLs into <a href>. applyArtifacts takes CALLER-supplied content, so it
// must never persist untrusted HTML or non-http(s) URLs: HTML is regenerated from
// markdown through the escaping markdownToHtml (client `html` is ignored), and a
// source keeps its url only when it is http(s) (drops javascript:/data: schemes).
function isSafeHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}
function sanitizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.map(s => {
    if (s && typeof s === "object" && s.url != null && !isSafeHttpUrl(s.url)) {
      const { url, ...rest } = s;
      return rest;
    }
    return s;
  });
}

// Precomputed-artifact path. The caller (the review-meetings sweep skill) has
// already done the real thinking with the meeting-transcript-review engine, so we
// store its summary / prep / transcript / proposed actions VERBATIM and skip the
// naive server-side heuristics (summarizeTranscript / extractActionCandidates).
// This is what the bearer-authorized /api/dcc/meeting-artifacts endpoint calls,
// so automation can attach meeting docs without an interactive session. Idempotent:
// prep/summary/transcript upsert in place (newest-by-kind), proposed actions dedupe
// by text, and the recap merge replaces only its own notes region.
async function applyArtifacts(blockId, { workspaceId, userId, prep, summary, transcript, proposedActions = [], recapToNotes = true, dashboardRef = null }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const applied = { prep: false, summary: false, transcript: false, proposedActions: 0, recapToNotes: false, dashboardRef: false };

  if (prep && (prep.markdown || prep.html)) {
    const markdown = String(prep.markdown || "");
    await upsertArtifact({
      meeting, workspaceId, userId, kind: "meeting_prep", sortOrder: 100,
      properties: {
        title: prep.title || `Prep: ${titleOf(meeting)}`,
        status: prep.status || "ready",
        markdown,
        html: markdownToHtml(markdown),
        sources: sanitizeSources(prep.sources),
      },
    });
    applied.prep = true;
    // Sweep-filled the real brief: flip the block chip pending -> ready.
    await markPrepReady(meeting.id);
  }

  if (transcript && transcript.text) {
    const text = String(transcript.text);
    const storedText = text.length > 85000 ? text.slice(0, 85000) : text;
    const transcriptHash = crypto.createHash("sha1").update(meeting.id + "|" + text).digest("hex");
    await upsertArtifact({
      meeting, workspaceId, userId, kind: "meeting_transcript", sortOrder: 200,
      properties: {
        title: `Transcript: ${titleOf(meeting)}`,
        status: "ingested",
        transcriptHash,
        text: storedText,
        originalLength: text.length,
        truncated: storedText.length !== text.length,
        sources: sanitizeSources(transcript.sources),
      },
    });
    applied.transcript = true;
  }

  if (summary && (summary.markdown || summary.html)) {
    const markdown = String(summary.markdown || "");
    await upsertArtifact({
      meeting, workspaceId, userId, kind: "meeting_summary", sortOrder: 210,
      properties: {
        title: summary.title || `Summary: ${titleOf(meeting)}`,
        status: summary.status || "ready",
        markdown,
        html: markdownToHtml(markdown),
        sources: sanitizeSources(summary.sources),
      },
    });
    applied.summary = true;

    // Feature 1: the recap is also written onto the meeting task's OWN notes, so it
    // shows on the (already-closed) meeting card, not only in the automation panel.
    if (recapToNotes && markdown.trim()) {
      const mp = propsOf(meeting);
      const nextNotes = mergeRecapIntoNotes(mp.notes, markdown);
      if (nextNotes !== mp.notes) {
        await blockDB.updateBlock(meeting.id, { properties: { ...mp, notes: nextNotes } });
        applied.recapToNotes = true;
      }
    }
  }

  if (Array.isArray(proposedActions) && proposedActions.length) {
    const existing = await loadArtifacts(meeting.id, workspaceId);
    const seen = new Set(
      existing.filter(b => propsOf(b).kind === "proposed_action_item").map(b => String(propsOf(b).text || "").toLowerCase())
    );
    let idx = 0;
    for (const a of proposedActions) {
      const text = String((a && (a.text || a.title)) || "").trim();
      if (!text || seen.has(text.toLowerCase())) continue;
      await upsertArtifact({
        meeting, workspaceId, userId, kind: "proposed_action_item", sortOrder: 300 + idx,
        properties: {
          title: text,
          text,
          owner: (a.owner === "other" || a.owner === "others") ? "other" : "drake",
          priority: a.priority || "Medium",
          status: "proposed",
          done: false,
          sources: sanitizeSources(a.sources),
        },
      });
      seen.add(text.toLowerCase());
      applied.proposedActions += 1;
      idx += 1;
    }
  }

  if (dashboardRef) {
    // Store the vault slug on the meeting block itself so the itinerary chip and
    // the /meetings/:id/dashboard proxy can find it. Reload first so we don't
    // clobber the recap-to-notes write above.
    const fresh = await loadMeeting(blockId, workspaceId);
    const mp = propsOf(fresh);
    const ref = String(dashboardRef).trim();
    if (ref && ref !== mp.dashboard_ref) {
      await blockDB.updateBlock(fresh.id, { properties: { ...mp, dashboard_ref: ref } });
      applied.dashboardRef = true;
    }
  }

  return { ...(await getAutomation(meeting.id, workspaceId)), applied };
}

module.exports = {
  getAutomation,
  generatePrep,
  ingestTranscript,
  approveActions,
  placeApprovedAction,
  applyArtifacts,
  mergeRecapIntoNotes,
};
