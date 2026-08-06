"use strict";

const MIN_TITLE_WORDS = 5;
const MAX_TITLE_WORDS = 10;
const MAX_THREAD_CHARS = 24000;

function flatText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fallbackTitle(text) {
  const flat = flatText(text);
  if (!flat) return "Slack task";
  const words = flat.split(" ");
  if (words.length <= MIN_TITLE_WORDS) return flat;

  let count = Math.min(MAX_TITLE_WORDS, words.length);
  for (let i = MIN_TITLE_WORDS - 1; i < count; i += 1) {
    if (/[.!?][\])}'"]*$/.test(words[i])) {
      count = i + 1;
      break;
    }
  }
  const title = words.slice(0, count).join(" ");
  return count < words.length && !/[.!?][\])}'"]*$/.test(words[count - 1])
    ? `${title}...`
    : title;
}

function slackPermalink(host, channel, ts, threadTs) {
  const cleanHost = String(host || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const cleanChannel = encodeURIComponent(channel);
  const messageTs = String(ts || "");
  const base = `https://${cleanHost}/archives/${cleanChannel}/p${messageTs.replace(".", "")}`;
  const rootTs = String(threadTs || "");
  if (!rootTs || rootTs === messageTs) return base;
  return `${base}?thread_ts=${encodeURIComponent(rootTs)}&cid=${cleanChannel}`;
}

function addCalendarDays(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) throw new Error("Expected YYYY-MM-DD date");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(days || 0), 12));
  return d.toISOString().slice(0, 10);
}

function normalizeSlackMessage(message, fallback) {
  message = message || {};
  fallback = fallback || {};
  const channelObj = message.channel && typeof message.channel === "object" ? message.channel : {};
  const fallbackChannel = fallback.channel && typeof fallback.channel === "object" ? fallback.channel : {};
  const files = Array.isArray(message.files) ? message.files : [];
  const fallbackFiles = Array.isArray(fallback.files) ? fallback.files : [];
  const fileText = files.concat(fallbackFiles)
    .map((file) => flatText(file && (file.title || file.name)))
    .filter(Boolean)
    .join("; ");
  const text = String(message.text || fallback.text || fileText || "");
  const ts = String(message.ts || fallback.ts || "");
  return {
    text,
    ts,
    threadTs: String(message.thread_ts || fallback.thread_ts || ts),
    user: String(message.user || message.username || fallback.user || fallback.username || "unknown"),
    channelName: String(channelObj.name || fallbackChannel.name || fallback.channel_name || "slack"),
    permalink: String(message.permalink || fallback.permalink || ""),
  };
}

function sourceNotes(kind, capture) {
  const marker = kind === "delegate" ? "Delegated from Slack" : "Bookmarked from Slack";
  const preview = String(capture.text || "").trim().slice(0, 1000);
  return `${marker}\n${capture.permalink || ""}\n\nFrom ${capture.user || "unknown"} in #${capture.channelName || "slack"}:\n${preview}`.trim();
}

function selectThreadForPrompt(messages, reactedTs, maxChars = MAX_THREAD_CHARS) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map((m) => ({ ts: String(m && m.ts || ""), user: String(m && (m.user || m.username) || "unknown"), text: flatText(m && m.text) }))
    .filter((m) => m.text);
  if (!normalized.length) return [];

  const reactedIndex = normalized.findIndex((m) => m.ts === String(reactedTs || ""));
  const picked = [];
  let used = 0;
  const priority = [0];
  if (reactedIndex >= 0) priority.push(reactedIndex);
  for (let i = normalized.length - 1; i >= Math.max(0, normalized.length - 12); i -= 1) priority.push(i);
  const seen = new Set(priority);
  const order = Array.from(new Set(priority))
    .concat(normalized.map((_m, i) => i).filter((i) => !seen.has(i)).reverse());
  for (const index of order) {
    const m = normalized[index];
    const cost = m.text.length + m.user.length + 40;
    if (used + cost > maxChars && picked.length) continue;
    picked.push({ ...m, index });
    used += cost;
    if (used >= maxChars) break;
  }
  return picked.sort((a, b) => a.index - b.index).map(({ index: _index, ...m }) => m);
}

function parseEnrichmentText(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(raw);
  const title = flatText(parsed && parsed.title).replace(/^['"]|['"]$/g, "").replace(/[.]$/, "");
  const summary = flatText(parsed && parsed.summary);
  if (!title || title.length > 80) throw new Error("Haiku title must be 1-80 characters");
  if (!summary || summary.length > 600) throw new Error("Haiku summary must be 1-600 characters");
  return { title, summary };
}

function nextRetryIso(attempt, nowMs = Date.now()) {
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  const delayMs = Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * (2 ** exponent));
  return new Date(nowMs + delayMs).toISOString();
}

module.exports = {
  MAX_THREAD_CHARS,
  addCalendarDays,
  fallbackTitle,
  flatText,
  nextRetryIso,
  normalizeSlackMessage,
  parseEnrichmentText,
  selectThreadForPrompt,
  slackPermalink,
  sourceNotes,
};
