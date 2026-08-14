const { google } = require("googleapis");
const gcalAuth = require("./gcal-auth");

const DEFAULT_PREFIXES = ["action item", "sweep task"];
const BEFORE_MS = 10 * 60 * 1000;
const AFTER_MS = 30 * 60 * 1000;
const MARKER_CONTEXT_BEFORE_MS = 90 * 1000;
const MARKER_CONTEXT_AFTER_MS = 30 * 1000;

function normalizePrefix(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitPrefixes(values) {
  const input = Array.isArray(values) && values.length ? values : DEFAULT_PREFIXES;
  return [...new Set(input.map(normalizePrefix).filter(Boolean))].slice(0, 20);
}

function parseExplicitSignal(text, prefixes = DEFAULT_PREFIXES) {
  const source = String(text || "").trim();
  for (const phrase of explicitPrefixes(prefixes)) {
    const match = source.match(new RegExp(`^${escapeRegExp(phrase)}\\b(?:\\s*[:\\-]\\s*|\\s+)?(.*)$`, "i"));
    if (!match) continue;
    return {
      phrase,
      taskText: String(match[1] || "").trim(),
      excerpt: source.slice(0, 1000),
    };
  }
  return null;
}

function asTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function titleTokens(value) {
  return new Set(String(value || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !["the", "and", "with", "meeting", "weekly", "sync"].includes(token)));
}

function titleScore(spaceTitle, meetingTitle) {
  const space = titleTokens(spaceTitle);
  const meeting = titleTokens(meetingTitle);
  if (!space.size || !meeting.size) return 0;
  let overlap = 0;
  for (const token of meeting) if (space.has(token)) overlap += 1;
  return overlap / Math.max(space.size, meeting.size);
}

async function paged(callPage, key) {
  const rows = [];
  let pageToken;
  do {
    const response = await callPage(pageToken);
    const body = response && response.data ? response.data : {};
    rows.push(...(Array.isArray(body[key]) ? body[key] : []));
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return rows;
}

function createMeetingSignalReader({ googleApi = google, authModule = gcalAuth } = {}) {
  async function readSignals({ userId, meeting = {}, prefixes } = {}) {
    const diagnostics = [];
    const start = asTime(meeting.start);
    const end = asTime(meeting.end);
    if (!userId || start === null || end === null || end < start || end - start > 24 * 60 * 60 * 1000) {
      return { signals: [], diagnostics: [{ code: "invalid_meeting_window" }] };
    }

    const accountKey = authModule.normalizeAccountKey
      ? authModule.normalizeAccountKey(meeting.account_key)
      : (meeting.account_key || "default");
    const configuredEmail = String(
      (typeof authModule.accountEmailFor === "function" ? authModule.accountEmailFor(accountKey) : "") ||
      (accountKey === authModule.WORK_ACCOUNT_KEY ? authModule.WORK_ACCOUNT_EMAIL : "") || ""
    ).trim();
    const suppliedEmail = String(meeting.account_email || "").trim();
    if (configuredEmail && suppliedEmail && configuredEmail.toLowerCase() !== suppliedEmail.toLowerCase()) {
      return { signals: [], diagnostics: [{ code: "account_email_mismatch", accountKey }] };
    }
    const accountEmail = configuredEmail || suppliedEmail;
    if (!accountEmail) {
      return { signals: [], diagnostics: [{ code: "account_email_missing", accountKey }] };
    }

    let auth;
    try {
      if (typeof authModule.loadAccountTokens === "function" && typeof authModule.hasAllScopes === "function") {
        const tokens = await authModule.loadAccountTokens(userId, accountKey);
        if (tokens && !authModule.hasAllScopes(tokens)) {
          return { signals: [], diagnostics: [{ code: "google_reconnect_required", accountKey }] };
        }
      }
      auth = await authModule.getAuthClient(userId, accountKey);
    } catch (error) {
      return { signals: [], diagnostics: [{ code: "google_auth_failed", message: error.message }] };
    }
    if (!auth) return { signals: [], diagnostics: [{ code: "google_reconnect_required", accountKey }] };

    const chat = googleApi.chat({ version: "v1", auth });
    const windowStart = new Date(start - BEFORE_MS);
    const windowEnd = new Date(end + AFTER_MS);
    let spaces;
    try {
      spaces = await paged(pageToken => chat.spaces.list({
        filter: 'spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      }), "spaces");
    } catch (error) {
      return { signals: [], diagnostics: [{ code: "chat_spaces_unavailable", message: error.message }] };
    }

    const candidates = spaces.filter(space => {
      if (space.spaceThreadingState && space.spaceThreadingState !== "UNTHREADED_MESSAGES") return false;
      const active = asTime(space.lastActiveTime);
      return active === null || active >= windowStart.getTime();
    });
    const signalSpaces = [];

    for (const space of candidates) {
      if (!space.name) continue;
      try {
        const membership = await chat.spaces.members.get({ name: `${space.name}/members/${accountEmail}` });
        const selfName = membership?.data?.member?.name;
        if (!selfName) continue;
        const messages = await paged(pageToken => chat.spaces.messages.list({
          parent: space.name,
          pageSize: 1000,
          orderBy: "createTime asc",
          filter: `createTime > "${windowStart.toISOString()}" AND createTime < "${windowEnd.toISOString()}"`,
          ...(pageToken ? { pageToken } : {}),
        }), "messages");
        const matches = messages.flatMap(message => {
          if (message?.sender?.name !== selfName) return [];
          const parsed = parseExplicitSignal(message.text || message.formattedText, prefixes);
          if (!parsed) return [];
          const markerTime = asTime(message.createTime);
          const context = markerTime === null ? [] : messages.flatMap(candidate => {
            if (candidate === message) return [];
            const candidateTime = asTime(candidate?.createTime);
            const excerpt = String(candidate?.text || candidate?.formattedText || "").trim();
            if (candidateTime === null || !excerpt || candidateTime < markerTime - MARKER_CONTEXT_BEFORE_MS ||
                candidateTime > markerTime + MARKER_CONTEXT_AFTER_MS) return [];
            return [{
              at: candidate.createTime || null,
              speaker: candidate?.sender?.name === selfName ? "drake" : "participant",
              excerpt: excerpt.slice(0, 500),
            }];
          }).slice(0, 12);
          return [{
            id: message.name || `${space.name}:${message.createTime}:${parsed.excerpt}`,
            source: "google_chat",
            at: message.createTime || null,
            phrase: parsed.phrase,
            taskText: parsed.taskText,
            excerpt: parsed.excerpt,
            context,
            spaceName: space.name,
            spaceTitle: space.displayName || "",
          }];
        });
        if (matches.length) signalSpaces.push({ space, matches, score: titleScore(space.displayName, meeting.title) });
      } catch (error) {
        diagnostics.push({ code: "chat_space_read_failed", space: space.name, message: error.message });
      }
    }

    let selected = signalSpaces;
    if (signalSpaces.length > 1) {
      const ranked = signalSpaces.slice().sort((a, b) => b.score - a.score);
      if (ranked[0].score > 0 && ranked[0].score > ranked[1].score) selected = [ranked[0]];
      else {
        diagnostics.push({ code: "ambiguous_chat_space", spaces: signalSpaces.map(item => item.space.name) });
        selected = [];
      }
    }
    const seen = new Set();
    const signals = selected.flatMap(item => item.matches).filter(signal => {
      const key = `${String(signal.at || "").slice(0, 19)}|${signal.excerpt.toLowerCase().replace(/\s+/g, " ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { signals, diagnostics };
  }

  return { readSignals };
}

module.exports = {
  DEFAULT_PREFIXES,
  explicitPrefixes,
  parseExplicitSignal,
  titleScore,
  createMeetingSignalReader,
  ...createMeetingSignalReader(),
};
