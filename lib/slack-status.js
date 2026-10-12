"use strict";

// Only explicit Slack source metadata is a reaction target. Never infer a target
// from arbitrary links in task text, nor accept another workspace's permalink.
function slackTarget(properties, host = "cleverrealestate.slack.com") {
  const p = properties || {};
  if (/^[CDG][A-Z0-9]+$/.test(p.slack_channel || "") && /^\d+\.\d+$/.test(p.slack_ts || "")) {
    return { channel: p.slack_channel, ts: p.slack_ts };
  }
  for (const value of [p.contact && p.contact.sourceRef, p.source_id, p.sourceRef, p.source_url, p.slack_url, p.permalink]) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password) continue;
      const match = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/.exec(url.pathname);
      if (match) return { channel: match[1], ts: `${match[2]}.${match[3]}` };
    } catch { /* Non-Slack and malformed source references are not targets. */ }
  }
  return null;
}
function sameTarget(a, b) { return !!a && !!b && a.channel === b.channel && a.ts === b.ts; }
module.exports = { slackTarget, sameTarget };
