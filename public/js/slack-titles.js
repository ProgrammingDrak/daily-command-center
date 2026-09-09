// Pure, shared naming rules for Slack capture, Triage, and existing task rows.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) (root.DCC = root.DCC || {}).SlackTitles = api;
})(typeof self !== "undefined" ? self : this, function () {
  const VERSION = "slack-rules-v1";
  const ACTIONS = "review|check|send|share|approve|confirm|update|schedule|fix|investigate|resolve|prepare|draft|complete|add|remove|ask|follow up|take a look|look into";
  const request = new RegExp("^(?:(?:can|could|would|will) you (?:please )?|please )(?=(?:" + ACTIONS + ")\\b)", "i");
  function decode(text) {
    return String(text || "").slice(0, 24000).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function label(text) {
    return String(text || "").replace(/\s*\((?:[A-Z]{2,5}|UTC[+-]?\d*)\)\s*$/, "").trim();
  }
  function cleanText(text) {
    return decode(text)
      .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, _id, name) => "@" + (label(name) || "someone"))
      .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, _id, name) => name ? "#" + name : "a Slack channel")
      .replace(/<!subteam\^[^>|]+(?:\|([^>]+))?>/g, (_m, name) => name || "the group")
      .replace(/<!(here|channel|everyone)>/g, "@$1")
      .replace(/<https?:\/\/[^>|]+\|([^>]+)>/g, "$1")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/[*`~]/g, "").replace(/\s+/g, " ").trim();
  }
  function sourceContext(title) {
    const match = /^(#[\w-]+|DM|Slack):\s*/i.exec(decode(title).trim());
    return match ? match[1] : "";
  }
  function titleFromText(text) {
    let raw = decode(text).trim().replace(/^(?:#[\w-]+|DM|Slack):\s*/i, "");
    // Remove addressees before decoding; names inside the request still matter.
    for (let i = 0; i < 5; i += 1) {
      const previous = raw;
      raw = raw.replace(/^(?:hi|hey|hello)(?:\s+(?:team|all|everyone))?[,!:\s]+/i, "")
        .replace(/^(?:<@[A-Z0-9]+(?:\|[^>]+)?>|<!(?:here|channel|everyone)>|<!subteam\^[^>]+>)[\s,/:;&-]*/, "");
      if (raw === previous) break;
    }
    let textLine = raw.split(/\r?\n/).map(cleanText).find(Boolean) || "";
    textLine = textLine.replace(request, "");
    // Prefer an existing sentence. Do not reinterpret vague or negative requests.
    const sentence = /^(.{12,}?[.!?])(?:\s+|$)/.exec(textLine);
    if (sentence) textLine = sentence[1];
    const words = textLine.split(/\s+/).filter(Boolean);
    let result = words.slice(0, 12).join(" ");
    let shortened = words.length > 12;
    if (result.length > (shortened ? 77 : 80)) {
      result = result.slice(0, 77).replace(/\s+\S*$/, "");
      shortened = true;
    }
    result = result.replace(/[.!?]+$/, "").trim();
    if (!result) return "Review Slack message";
    return result[0].toUpperCase() + result.slice(1) + (shortened ? "..." : "");
  }
  function isSlack(item) {
    return [item.source, item.type, item.triageType].some(value => /slack/i.test(String(value || ""))) ||
      /^slack:/.test(String(item.id || item.triageId || "")) || item.triageType === "slack";
  }
  function normalizeTriageItem(item) {
    if (!item || !isSlack(item)) return item;
    // A user correction wins over subsequent automatic normalization.
    if (item.generatedTitle && item.title !== item.generatedTitle) return item;
    const original = item.originalTitle || item.title || "";
    const title = titleFromText(item.source_text || item.source_message_preview || (item.triageContext && item.triageContext.source_text) || original);
    return { ...item, title, generatedTitle: title, originalTitle: original,
      titleNamingVersion: VERSION, sourceContext: item.sourceContext || sourceContext(original) };
  }
  function displayTitle(props) {
    const title = props.title;
    if (!isSlack(props) && !(props.source === "triage" && /slack/i.test(props.triageType || props.triageId || ""))) return title;
    if (props.generatedTitle) return title;
    if (props.captureTitle && title !== props.captureTitle) return title;
    if (props.triageTitle && title !== props.triageTitle) return title;
    if (props.captureTitle || props.triageTitle || sourceContext(title) || /<[@#!]/.test(decode(title))) {
      return titleFromText(props.source_message_preview || title);
    }
    return title;
  }
  return { VERSION, cleanText, titleFromText, sourceContext, normalizeTriageItem, displayTitle };
});
