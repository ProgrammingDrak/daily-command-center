const crypto = require("crypto");
const { google } = require("googleapis");
const blockDB = require("./db");
const gcalAuth = require("./gcal-auth");
const meetingAudioStore = require("./meeting-audio-store");
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
      dashboardRef: propsOf(meeting).dashboard_ref || null,
      recordingArtifact: propsOf(meeting).recording_artifact || null,
      recordingSource: propsOf(meeting).recording_source || null,
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

// When (re)generating a prep/summary that the user has hand-edited, don't clobber
// their content: append it under a stable "User Notes" section beneath the fresh
// output. indexOf on the marker means exactly ONE User Notes tail survives across
// repeated regenerates (never nests the old template, never double-wraps). Called
// from every generate path (generatePrep, ingestTranscript, applyArtifacts) so the
// no-clobber guarantee holds for the button AND the nightly sweep.
// Marker detection is tolerant to heading level: we inject the section as <h4> /
// "### ", but the block editor round-trips headings as <h3> (it has no h4), so a
// literal match would double-wrap after the user edits a regenerated doc. Matching
// any <h1-6>User Notes</h*> keeps it to exactly one section across regenerates.
const USER_NOTES_HTML_RE = /<h[1-6][^>]*>\s*User Notes\s*<\/h[1-6]>/i;
const USER_NOTES_MD_RE = /(^|\n)#{1,6}\s+User Notes[^\n]*/i;
function preserveUserNotes(freshHtml, freshMarkdown, existingProps) {
  const ex = existingProps || {};
  if (!ex.userEdited) return { html: freshHtml, markdown: freshMarkdown };
  const priorHtml = String(ex.html || markdownToHtml(ex.markdown || ""));
  const mH = priorHtml.match(USER_NOTES_HTML_RE);
  const tailHtml = mH ? priorHtml.slice(mH.index) : ("<h4>User Notes</h4>" + priorHtml);
  const priorMd = String(ex.markdown || "");
  const mM = priorMd.match(USER_NOTES_MD_RE);
  const tailMd = mM ? priorMd.slice(mM.index).replace(/^\n/, "") : ("### User Notes\n\n" + priorMd);
  return {
    html: String(freshHtml || "") + tailHtml,
    markdown: String(freshMarkdown || "") + "\n\n" + tailMd,
  };
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

// Flip the meeting BLOCK's own recap_status to "ready" once a summary lands, so
// the itinerary Recap chip (persistence.js -> ev.recapStatus) appears — even on a
// meeting that's already been marked done. Mirror of markPrepReady; there is no
// "pending" half (the materializer never pre-stamps recap), so this is the only
// writer. Reloads first so we never clobber a concurrent prep/notes write.
// Returns true only when it actually flips pending/absent -> ready, so callers can
// fire a "recap landed" toast once and stay quiet on idempotent re-posts.
async function markRecapReady(meetingId) {
  try {
    const fresh = await blockDB.getBlock(meetingId);
    if (!fresh) return false;
    const fp = propsOf(fresh);
    if (fp.recap_status === "ready") return false;
    await blockDB.updateBlock(meetingId, { properties: { ...fp, recap_status: "ready" } });
    return true;
  } catch (e) {
    console.error("[meeting-automation] markRecapReady failed (non-fatal):", e.message);
    return false;
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
  const existingPrep = newestByKind(await loadArtifacts(meeting.id, workspaceId), "meeting_prep");
  const merged = preserveUserNotes(markdownToHtml(markdown), markdown, propsOf(existingPrep));
  await upsertArtifact({
    meeting,
    workspaceId,
    userId,
    kind: "meeting_prep",
    sortOrder: 100,
    properties: {
      title: `Prep: ${titleOf(meeting)}`,
      status: "draft",
      markdown: merged.markdown,
      html: merged.html,
      sources,
      // Clear any stale editor blocks + userEdited so the client re-seeds from the
      // regenerated html/markdown (with prior edits preserved under User Notes).
      blocks: null,
      userEdited: false,
    },
  });
  // Fallback fill: a template prep now exists, so the chip should read "ready".
  await markPrepReady(meeting.id);
  return getAutomation(blockId, workspaceId);
}

// Persist a user's in-place edit to a prep/summary doc. Stores the block-editor
// output verbatim ({html, blocks, markdown}) — exactly like the notes fields — and
// flags userEdited so a later (re)generate preserves it under "User Notes".
// upsertArtifact merges over the existing properties, so kind/meetingBlockId/
// sources/title/status all survive; a first edit lazily CREATES the artifact.
async function updateArtifactContent(blockId, kind, { html, blocks, markdown }, { workspaceId, userId }) {
  if (kind !== "meeting_prep" && kind !== "meeting_summary") {
    const err = new Error("Unsupported artifact kind"); err.statusCode = 400; throw err;
  }
  const meeting = await loadMeeting(blockId, workspaceId);
  const existing = newestByKind(await loadArtifacts(meeting.id, workspaceId), kind);
  const defaults = existing ? {} : {
    title: kind === "meeting_prep" ? `Prep: ${titleOf(meeting)}` : `Summary: ${titleOf(meeting)}`,
    status: "draft",
  };
  await upsertArtifact({
    meeting, workspaceId, userId, kind,
    sortOrder: kind === "meeting_prep" ? 100 : 210,
    properties: {
      ...defaults,
      html: String(html || ""),
      blocks: Array.isArray(blocks) ? blocks : null,
      markdown: String(markdown || ""),
      userEdited: true,
    },
  });
  // First-time prep create should light the itinerary chip, same as generatePrep.
  if (kind === "meeting_prep" && !existing) await markPrepReady(meeting.id);
  return getAutomation(meeting.id, workspaceId);
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

function normalizedActionText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?;:]+$/g, "");
}

function citationStart(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const offset = Number(value);
  return Number.isFinite(offset) && offset >= 0 ? offset : null;
}

// Transcript evidence and itinerary timing used to share top-level `start`.
// A proposal's value is a transcript character/segment offset, never a clock time,
// so keep it under an explicit citation namespace. Legacy reads stay until the
// one-time migration has rewritten every stored proposal.
function citationOf(value) {
  value = value && typeof value === "object" ? value : {};
  const nested = value.citation && typeof value.citation === "object" && !Array.isArray(value.citation)
    ? value.citation : {};
  const rawOffset = nested.startOffset !== undefined
    ? nested.startOffset
    : (value.transcriptStartOffset !== undefined ? value.transcriptStartOffset : value.start);
  const rawQuote = nested.quote !== undefined ? nested.quote : value.quote;
  return {
    startOffset: citationStart(rawOffset),
    quote: String(rawQuote || "").trim().slice(0, 2000),
  };
}

function sanitizeRecordingArtifact(value, workspaceId, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Invalid recording artifact"), { statusCode: 400 });
  }
  const status = String(value.status || "");
  if (!["hot", "compacted", "source_only", "transcript_only"].includes(status)) {
    throw Object.assign(new Error("Invalid recording artifact status"), { statusCode: 400 });
  }
  const hot = value.hot_audio;
  if (status === "hot" && (!hot || typeof hot !== "object")) {
    throw Object.assign(new Error("Hot recording artifact is missing its private audio reference"), { statusCode: 400 });
  }
  if (!["hot", "compacted"].includes(status) && hot) {
    throw Object.assign(new Error("Non-hot recording artifact cannot carry private audio"), { statusCode: 400 });
  }

  let cleanHot = null;
  let expiresAt = null;
  if (hot) {
    const prefix = `meetings/hot/${meetingAudioStore.safeSlug(workspaceId)}/`;
    const key = String(hot.key || "");
    const bucket = String(hot.bucket || "");
    const config = meetingAudioStore.configFromEnv(process.env);
    if (hot.provider !== "r2" || !key.startsWith(prefix) || !bucket || (config && bucket !== config.bucket)) {
      throw Object.assign(new Error("Recording artifact is outside this workspace or bucket"), { statusCode: 400 });
    }
    if (status === "hot") {
      expiresAt = meetingAudioStore.normalizeExpiry(hot.expires_at, now);
      const created = Date.parse(String(value.created_at || ""));
      const expires = Date.parse(expiresAt);
      if (!Number.isFinite(created) || created > now + (5 * 60 * 1000) ||
          expires > created + (14 * 24 * 60 * 60 * 1000) + (5 * 60 * 1000)) {
        throw Object.assign(new Error("Recording artifact exceeds its 14-day holding period"), { statusCode: 400 });
      }
    } else {
      const parsed = Date.parse(String(hot.expires_at || ""));
      if (!Number.isFinite(parsed) || parsed > now + (5 * 60 * 1000)) {
        throw Object.assign(new Error("Compacted recording artifact has an invalid hot-audio expiry"), { statusCode: 400 });
      }
      expiresAt = new Date(parsed).toISOString();
    }
    cleanHot = {
      ...hot,
      provider: "r2",
      bucket: config ? config.bucket : bucket,
      key,
      expires_at: expiresAt,
    };
  }
  return {
    ...value,
    status,
    holding_days: 14,
    expires_at: status === "hot" ? expiresAt : (value.expires_at || null),
    hot_audio: cleanHot,
  };
}

function sanitizeSignal(signal) {
  if (!signal || typeof signal !== "object") return null;
  const source = ["google_chat", "meet_chat_file", "transcript"].includes(signal.source)
    ? signal.source : "transcript";
  const clean = {
    source,
    phrase: String(signal.phrase || "").trim().slice(0, 100),
    at: String(signal.at || "").trim().slice(0, 80),
    excerpt: String(signal.excerpt || "").trim().slice(0, 1000),
  };
  const context = Array.isArray(signal.context) ? signal.context.slice(0, 12).map(item => ({
    at: String(item?.at || "").trim().slice(0, 80),
    speaker: item?.speaker === "drake" ? "drake" : "participant",
    excerpt: String(item?.excerpt || "").trim().slice(0, 500),
  })).filter(item => item.at || item.excerpt) : [];
  if (context.length) clean.context = context;
  return clean.phrase || clean.at || clean.excerpt || context.length ? clean : null;
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
  const summaryMd = `### Meeting Summary\n${summaryText}`;
  const existingSummary = newestByKind(await loadArtifacts(meeting.id, workspaceId), "meeting_summary");
  const mergedSummary = preserveUserNotes(markdownToHtml(summaryMd), summaryMd, propsOf(existingSummary));
  await upsertArtifact({
    meeting,
    workspaceId,
    userId,
    kind: "meeting_summary",
    sortOrder: 210,
    properties: {
      title: `Summary: ${titleOf(meeting)}`,
      status: "draft",
      markdown: mergedSummary.markdown,
      html: mergedSummary.html,
      sources,
      blocks: null,
      userEdited: false,
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
        origin: "automated",
        status: "proposed",
        done: false,
        sources,
      },
    }));
  }
  return { ...(await getAutomation(blockId, workspaceId)), createdActionCount: createdActions.length };
}

function approvedActionMatches(action, proposal, workspaceId) {
  if (!action || action.deleted_at || String(action.workspace_id || "") !== String(workspaceId || "")) return false;
  const provenance = propsOf(action).meetingAutomation || {};
  return String(provenance.meetingBlockId || "") === String(proposal.parent_id || "") &&
    String(provenance.proposedActionId || "") === String(proposal.id || "");
}

async function approveActions(blockId, { workspaceId, userId, actionIds = [] }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const artifacts = await loadArtifacts(blockId, workspaceId);
  // Exclude both "approved" and "placed": placement is terminal, so a placed
  // proposal must not be re-approvable (that would mint a duplicate task and wipe
  // its placedDate/placedStart — the durable "Scheduled ✓" signal).
  const proposals = artifacts.filter(b => {
    const p = propsOf(b);
    return p.kind === "proposed_action_item" &&
      (p.status === "proposed" || (actionIds.length > 0 && p.status === "approved"));
  });
  const selected = actionIds.length ? proposals.filter(b => actionIds.includes(b.id)) : proposals;
  const created = [];
  let approvedCount = 0;
  for (const proposal of selected) {
    const p = propsOf(proposal);
    if (p.status === "approved" && p.approvedBlockId) {
      const existing = await blockDB.getBlock(p.approvedBlockId);
      if (approvedActionMatches(existing, proposal, workspaceId)) {
        created.push(existing);
        continue;
      }
    }
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
        meetingSource: {
          meetingBlockId: meeting.id,
          dashboardRef: propsOf(meeting).dashboard_ref || null,
          citation: citationOf(p),
        },
        meetingAutomation: {
          meetingBlockId: meeting.id,
          proposedActionId: proposal.id,
          approvedAt: new Date().toISOString(),
          origin: p.origin === "signaled" ? "signaled" : "automated",
          signal: p.signal || null,
        },
      },
      sort_order: 500 + created.length,
      user_id: userId,
      workspace_id: workspaceId,
    });
    created.push(action);
    approvedCount += 1;
    const approvedProposalProps = {
      ...p,
      citation: citationOf(p),
      status: "approved",
      approvedAt: new Date().toISOString(),
      approvedBlockId: action.id,
    };
    delete approvedProposalProps.start;
    delete approvedProposalProps.quote;
    await blockDB.updateBlock(proposal.id, {
      properties: approvedProposalProps,
    });
  }
  return { ...(await getAutomation(blockId, workspaceId)), approvedCount, approvedBlocks: created };
}

// One cross-meeting read model for the morning elevation modal. Proposals remain
// children of their meeting until Drake schedules them, so the ordinary task
// queries intentionally cannot see them.
async function listProposedActions({ workspaceId, limit = 50 } = {}) {
  if (!workspaceId || typeof blockDB.getBlocksByKind !== "function") return [];
  const proposals = await blockDB.getBlocksByKind("proposed_action_item", workspaceId);
  const rows = [];
  for (const proposal of proposals) {
    const p = propsOf(proposal);
    if (!["proposed", "approved"].includes(p.status) || p.done === true || !proposal.parent_id) continue;
    let approvedBlockId = null;
    if (p.status === "approved" && p.approvedBlockId) {
      const approved = await blockDB.getBlock(p.approvedBlockId);
      if (approvedActionMatches(approved, proposal, workspaceId)) {
        approvedBlockId = approved.id;
        const ap = propsOf(approved);
        if (ap.status === "done" || ap.done === true || !!ap.completedAt) continue;
      }
    }
    let meeting;
    try { meeting = await loadMeeting(proposal.parent_id, workspaceId); }
    catch { continue; }
    const mp = propsOf(meeting);
    rows.push({
      id: proposal.id,
      meetingId: meeting.id,
      meetingTitle: titleOf(meeting),
      meetingDate: meeting.date || null,
      meetingStart: mp.start || null,
      meetingEnd: mp.end || null,
      title: p.text || p.title || "Meeting follow-up",
      owner: p.owner === "other" || p.owner === "others" ? "other" : "drake",
      priority: p.priority || "Medium",
      origin: p.origin === "signaled" ? "signaled" : "automated",
      signal: p.signal || null,
      citation: citationOf(p),
      dashboardRef: mp.dashboard_ref || null,
      approvedBlockId,
      createdAt: proposal.created_at || null,
    });
  }
  rows.sort((a, b) => String(b.meetingDate || b.createdAt || "").localeCompare(String(a.meetingDate || a.createdAt || "")));
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

async function dismissProposedAction(blockId, actionId, { workspaceId } = {}) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const artifacts = await loadArtifacts(meeting.id, workspaceId);
  const proposal = artifacts.find(b => b.id === actionId && propsOf(b).kind === "proposed_action_item");
  if (!proposal) throw Object.assign(new Error("Proposed action not found for this meeting"), { statusCode: 404 });
  const p = propsOf(proposal);
  if (p.status === "dismissed") return getAutomation(meeting.id, workspaceId);
  if (!["proposed", "approved"].includes(p.status)) throw Object.assign(new Error("Only an unplaced action can be dismissed"), { statusCode: 409 });
  if (p.status === "approved" && p.approvedBlockId && typeof blockDB.deleteBlock === "function") {
    const approved = await blockDB.getBlock(p.approvedBlockId);
    if (approvedActionMatches(approved, proposal, workspaceId)) await blockDB.deleteBlock(approved.id);
  }
  await blockDB.updateBlock(proposal.id, {
    properties: { ...p, status: "dismissed", dismissedAt: new Date().toISOString() },
  });
  return getAutomation(meeting.id, workspaceId);
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
  // Stamp the originating proposal so the Recap tab shows "Scheduled ✓" durably
  // (a re-fetch can't otherwise tell placed from merely approved — the placed task
  // detaches and drops out of the meeting's children). Non-fatal if it fails.
  const proposedActionId = (p.meetingAutomation || {}).proposedActionId;
  if (proposedActionId) {
    try {
      const proposal = await blockDB.getBlock(proposedActionId);
      const proposalProps = propsOf(proposal);
      const scopedProposal = proposal && !proposal.deleted_at &&
        String(proposal.workspace_id || "") === String(workspaceId || "") &&
        String(proposal.parent_id || "") === String(meeting.id) &&
        proposalProps.kind === "proposed_action_item" &&
        String(proposalProps.approvedBlockId || "") === String(action.id) &&
        approvedActionMatches(action, proposal, workspaceId);
      if (scopedProposal) {
        const pp = propsOf(proposal);
        await blockDB.updateBlock(proposal.id, {
          properties: { ...pp, status: "placed", placedDate: date, placedStart: nextProps.start || null },
        });
      }
    } catch (e) {
      console.error("[meeting-automation] placed-stamp failed (non-fatal):", e.message);
    }
  }
  return { ok: true, actionBlockId: action.id, date, start: nextProps.start || null };
}

// Catch Up schedules a proposal in one retry-safe server operation. Approval and
// placement are separate durable writes, so a placement failure must be able to
// resume from the approvedBlockId instead of minting another child or stranding
// the proposal outside the elevation read model.
async function placeProposedAction(blockId, proposalId, { workspaceId, userId, date, start = null }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  let artifacts = await loadArtifacts(meeting.id, workspaceId);
  let proposal = artifacts.find(b => b.id === proposalId && propsOf(b).kind === "proposed_action_item");
  if (!proposal) throw Object.assign(new Error("Proposed action not found for this meeting"), { statusCode: 404 });
  let p = propsOf(proposal);
  if (p.status === "placed") {
    const placed = p.approvedBlockId ? await blockDB.getBlock(p.approvedBlockId) : null;
    return {
      ok: true,
      actionBlockId: approvedActionMatches(placed, proposal, workspaceId) ? placed.id : null,
      date: p.placedDate || date,
      start: p.placedStart || null,
      duplicate: true,
    };
  }
  if (p.status === "dismissed") throw Object.assign(new Error("Dismissed action cannot be scheduled"), { statusCode: 409 });

  let action = p.approvedBlockId ? await blockDB.getBlock(p.approvedBlockId) : null;
  if (!approvedActionMatches(action, proposal, workspaceId)) {
    const approved = await approveActions(meeting.id, { workspaceId, userId, actionIds: [proposal.id] });
    action = (approved.approvedBlocks || [])[0] || null;
    if (!action) {
      artifacts = await loadArtifacts(meeting.id, workspaceId);
      proposal = artifacts.find(b => b.id === proposalId && propsOf(b).kind === "proposed_action_item");
      p = propsOf(proposal);
      action = p.approvedBlockId ? await blockDB.getBlock(p.approvedBlockId) : null;
    }
  }
  if (!approvedActionMatches(action, proposal, workspaceId)) {
    throw Object.assign(new Error("Could not approve meeting action"), { statusCode: 409 });
  }
  return placeApprovedAction(meeting.id, action.id, { workspaceId, userId, date, start });
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
async function applyArtifacts(blockId, { workspaceId, userId, prep, summary, transcript, proposedActions = [], recapToNotes = true, dashboardRef = null, recordingArtifact = null, recordingSource = null }) {
  const meeting = await loadMeeting(blockId, workspaceId);
  const applied = { prep: false, summary: false, transcript: false, proposedActions: 0, recapToNotes: false, recapReady: false, dashboardRef: false };

  if (prep && (prep.markdown || prep.html)) {
    const markdown = String(prep.markdown || "");
    const existingPrep = newestByKind(await loadArtifacts(meeting.id, workspaceId), "meeting_prep");
    const merged = preserveUserNotes(markdownToHtml(markdown), markdown, propsOf(existingPrep));
    await upsertArtifact({
      meeting, workspaceId, userId, kind: "meeting_prep", sortOrder: 100,
      properties: {
        title: prep.title || `Prep: ${titleOf(meeting)}`,
        status: prep.status || "ready",
        markdown: merged.markdown,
        html: merged.html,
        sources: sanitizeSources(prep.sources),
        blocks: null,
        userEdited: false,
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
    const existingSummary = newestByKind(await loadArtifacts(meeting.id, workspaceId), "meeting_summary");
    const merged = preserveUserNotes(markdownToHtml(markdown), markdown, propsOf(existingSummary));
    await upsertArtifact({
      meeting, workspaceId, userId, kind: "meeting_summary", sortOrder: 210,
      properties: {
        title: summary.title || `Summary: ${titleOf(meeting)}`,
        status: summary.status || "ready",
        markdown: merged.markdown,
        html: merged.html,
        sources: sanitizeSources(summary.sources),
        blocks: null,
        userEdited: false,
      },
    });
    applied.summary = true;
    // The recap now lives ONLY as the meeting_summary artifact, surfaced in the
    // modal's Recap tab (openPrepModal). We no longer mirror it into the meeting's
    // own notes — that dumped the recap as unstructured text in the notes box and
    // it landed after the meeting was already closed. recapToNotes is retained in
    // the signature for endpoint/payload compatibility but is now inert.
    void recapToNotes;
    // Light the itinerary Recap chip so the recap is findable even after the
    // meeting has been marked done. recapReady is true only on the first landing,
    // so the client toasts once and stays quiet on re-delivery.
    applied.recapReady = await markRecapReady(meeting.id);
  }

  if (Array.isArray(proposedActions) && proposedActions.length) {
    const existing = await loadArtifacts(meeting.id, workspaceId);
    const existingByText = new Map(
      existing.filter(b => propsOf(b).kind === "proposed_action_item")
        .map(b => [normalizedActionText(propsOf(b).text), b])
        .filter(([key]) => key)
    );
    let idx = 0;
    for (const a of proposedActions) {
      const text = String((a && (a.text || a.title)) || "").trim();
      const textKey = normalizedActionText(text);
      if (!textKey) continue;
      const origin = a && a.origin === "signaled" ? "signaled" : "automated";
      const signal = origin === "signaled" ? sanitizeSignal(a.signal) : null;
      const duplicate = existingByText.get(textKey);
      if (duplicate) {
        const prior = propsOf(duplicate);
        const priorCitation = citationOf(prior);
        const incomingCitation = citationOf(a);
        const nextCitation = {
          startOffset: incomingCitation.startOffset !== null
            ? incomingCitation.startOffset : priorCitation.startOffset,
          quote: incomingCitation.quote || priorCitation.quote,
        };
        const updated = {
          ...prior,
          origin: origin === "signaled" ? "signaled" : prior.origin,
          signal: origin === "signaled" ? signal : prior.signal,
          citation: nextCitation,
          sources: origin === "signaled" ? sanitizeSources([
            ...(Array.isArray(prior.sources) ? prior.sources : []),
            ...(Array.isArray(a && a.sources) ? a.sources : []),
          ]) : prior.sources,
        };
        delete updated.start;
        delete updated.quote;
        // A later explicit marker upgrades the same extracted task in place. Do
        // not resurrect a dismissed/placed proposal or mint a duplicate task.
        if ((origin === "signaled" && prior.origin !== "signaled") ||
            (incomingCitation.startOffset !== null && incomingCitation.startOffset !== priorCitation.startOffset) ||
            (incomingCitation.quote && incomingCitation.quote !== priorCitation.quote) ||
            Object.prototype.hasOwnProperty.call(prior, "start") ||
            Object.prototype.hasOwnProperty.call(prior, "quote")) {
          await blockDB.updateBlock(duplicate.id, {
            properties: updated,
          });

          // The proposal is the dedupe anchor, but the approved task is the
          // durable object Drake works from. Keep its source citation current
          // even after the task has been placed on the itinerary.
          if (prior.approvedBlockId) {
            const approved = await blockDB.getBlock(prior.approvedBlockId);
            if (approvedActionMatches(approved, duplicate, workspaceId)) {
              const approvedProps = propsOf(approved);
              const meetingSource = {
                ...(approvedProps.meetingSource || {}),
                meetingBlockId: meeting.id,
                dashboardRef: String(dashboardRef || "").trim() || propsOf(meeting).dashboard_ref || null,
                citation: nextCitation,
              };
              delete meetingSource.start;
              delete meetingSource.quote;
              await blockDB.updateBlock(approved.id, {
                properties: {
                  ...approvedProps,
                  meetingSource,
                  meetingAutomation: {
                    ...(approvedProps.meetingAutomation || {}),
                    origin: updated.origin,
                    signal: updated.signal || null,
                  },
                },
              });
            }
          }
        }
        continue;
      }
      const created = await upsertArtifact({
        meeting, workspaceId, userId, kind: "proposed_action_item", sortOrder: 300 + idx,
        properties: {
          title: text,
          text,
          owner: (a.owner === "other" || a.owner === "others") ? "other" : "drake",
          priority: a.priority || "Medium",
          origin,
          signal,
          status: "proposed",
          done: false,
          sources: sanitizeSources(a.sources),
          citation: citationOf(a),
        },
      });
      existingByText.set(textKey, created);
      applied.proposedActions += 1;
      idx += 1;
    }
  }

  if (dashboardRef || recordingArtifact || recordingSource) {
    // Store the vault slug on the meeting block itself so the itinerary chip and
    // the /meetings/:id/dashboard proxy can find it. Reload first so we don't
    // clobber the recap-to-notes write above.
    const fresh = await loadMeeting(blockId, workspaceId);
    const mp = propsOf(fresh);
    const ref = String(dashboardRef || "").trim();
    const next = { ...mp };
    if (ref && ref !== mp.dashboard_ref) { next.dashboard_ref = ref; applied.dashboardRef = true; }
    if (recordingArtifact) next.recording_artifact = sanitizeRecordingArtifact(recordingArtifact, workspaceId);
    if (recordingSource) {
      const safeSource = { ...recordingSource };
      if (!isSafeHttpUrl(safeSource.url)) delete safeSource.url;
      next.recording_source = safeSource;
    }
    if (applied.dashboardRef || recordingArtifact || recordingSource) {
      await blockDB.updateBlock(fresh.id, { properties: next });
    }
  }

  return { ...(await getAutomation(meeting.id, workspaceId)), applied };
}

module.exports = {
  getAutomation,
  generatePrep,
  updateArtifactContent,
  ingestTranscript,
  listProposedActions,
  approveActions,
  dismissProposedAction,
  placeApprovedAction,
  placeProposedAction,
  applyArtifacts,
};
