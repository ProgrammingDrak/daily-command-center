"use strict";

// One Slack message can be either of two things in the DCC, and it can change
// its mind:
//
//   🔖 :bookmark:              -> an itinerary TASK          (source "slack-bookmark")
//   👥 :busts_in_silhouette:   -> a Waiting/delegated ITEM   (source "slack-delegate")
//
// Everything that used to be duplicated per kind — the reaction name, the
// `source` discriminator, the idempotency key prefix — lives in SLACK_KINDS, so
// widening a behaviour to both kinds is a table read rather than a second code
// path. `routes/slack-events.js` owns the Slack I/O; this file is pure.
//
// WHY THE KEYS STAY WHAT THEY ARE. `slackKeyFor` reproduces the exact strings the
// two inline closures in slack-events.js used to build. The local poller
// (claude-brain/scripts/slack-bookmark-to-dcc.py) mints the same
// `slack-bookmark:<channel>:<ts>` independently, and its ledger in
// ~/.claude/dcc/slack-bookmark-processed.json is keyed on it. Change the shape
// and every already-captured message looks new to one side or the other.

const SLACK_KINDS = {
  bookmark: {
    kind: "bookmark",
    reaction: "bookmark",
    source: "slack-bookmark",
    keyPrefix: "slack-bookmark",
    // Which property holds the human-facing name. A Waiting item keeps `title`
    // for the thing it is blocked ON and puts the work in `myTask`, so a
    // conversion has to move the text between fields, not just copy it.
    displayField: "title",
  },
  delegate: {
    kind: "delegate",
    reaction: "busts_in_silhouette",
    source: "slack-delegate",
    keyPrefix: "slack-delegate",
    displayField: "myTask",
  },
};

const KIND_BY_SOURCE = new Map(Object.values(SLACK_KINDS).map((k) => [k.source, k.kind]));
const KIND_BY_REACTION = new Map(Object.values(SLACK_KINDS).map((k) => [k.reaction, k.kind]));

// The suffix a retired key carries. A retired key is deliberately still a
// readable audit trail rather than a delete: it says "this row used to own that
// message", which is the only breadcrumb explaining why a converted row exists.
const RETIRED_MARKER = ":retired:";

function kindMeta(kind) {
  const meta = SLACK_KINDS[String(kind || "")];
  if (!meta) throw new Error(`Unknown Slack kind: ${kind}`);
  return meta;
}

function otherKind(kind) {
  return kindMeta(kind).kind === "bookmark" ? "delegate" : "bookmark";
}

function slackKeyFor(kind, channel, ts) {
  return `${kindMeta(kind).keyPrefix}:${channel}:${ts}`;
}

// Both keys for one message, in a fixed order, for the two-key lookup that
// resolves a reaction without knowing which kind currently owns the message.
function slackKeysFor(channel, ts) {
  return [slackKeyFor("bookmark", channel, ts), slackKeyFor("delegate", channel, ts)];
}

// Which kind a stored row is, read back off `source`. Null for anything that did
// not come from a Slack reaction — the gate every projection needs.
function slackKindOf(props) {
  return KIND_BY_SOURCE.get(String((props || {}).source || "")) || null;
}

function kindForReaction(reaction) {
  return KIND_BY_REACTION.get(String(reaction || "")) || null;
}

function reactionFor(kind) {
  return kindMeta(kind).reaction;
}

// The Slack coordinates a projection needs, or null when the row is not
// addressable. `channel` and `ts` are the only two that are load-bearing;
// projectTaskToSlack cannot post without both.
function slackCoordsOf(props) {
  props = props || {};
  const channel = String(props.slack_channel || "");
  const ts = String(props.slack_ts || "");
  if (!channel || !ts) return null;
  return {
    channel,
    ts,
    threadTs: String(props.slack_thread_ts || ts),
    permalink: String(props.source_id || ""),
  };
}

function isRetiredKey(key) {
  return String(key || "").includes(RETIRED_MARKER);
}

// Rotate a row's idempotency key so no reaction can ever resolve to it again.
//
// This is the whole reason a conversion is not just "write the new row". Leave
// the losing key in place and handleBookmark's undelete branch finds the deleted
// task on the next 🔖 and RESURRECTS it beside the Waiting item; handleDelegate
// finds the closed Waiting item on the next 👥 and mints nothing at all. Both
// are silent.
function retireSlackKey(props, atIso) {
  const next = { ...(props || {}) };
  const key = String(next.idempotency_key || "");
  if (!key || isRetiredKey(key)) return next;
  next.idempotency_key = `${key}${RETIRED_MARKER}${atIso || new Date().toISOString()}`;
  return next;
}

// Everything about the message itself, as opposed to what the user has since
// done with it. A conversion carries this across and leaves the rest behind:
// scheduling, status, points and check-in cadence all belong to the row, not to
// the Slack message.
//
// `source_id` is carried, never rotated. It is the permalink, and
// triage-suppressions.js builds its key as `source + "|" + source_id`, so
// rotating it would invalidate every stored suppression. PR #327 declined that
// for the same reason.
const PROVENANCE_KEYS = [
  "slack_channel", "slack_ts", "slack_thread_ts", "slack_author", "slack_channel_name",
  "source_id", "source_message_preview", "contact",
  "captureTitle", "captureNotes",
  "captured_at", "capture_status",
  "enrichment_status", "enrichment_attempts", "enrichment_next_attempt_at",
  "enrichment_last_error", "enrichment_model", "enriched_at",
  "aiTitle", "aiSummary",
];

function slackProvenanceOf(props) {
  const out = {};
  for (const key of PROVENANCE_KEYS) {
    if ((props || {})[key] !== undefined) out[key] = props[key];
  }
  return out;
}

// The provenance the winning row of a conversion inherits: the message fields,
// plus the `source` and idempotency key of the kind it is BECOMING.
function adoptProvenance(fromProps, toKind, channel, ts) {
  const coords = slackCoordsOf(fromProps) || {};
  const ch = channel || coords.channel;
  const stamp = ts || coords.ts;
  if (!ch || !stamp) return null;
  return {
    ...slackProvenanceOf(fromProps),
    source: kindMeta(toKind).source,
    idempotency_key: slackKeyFor(toKind, ch, stamp),
  };
}

// Move the human-facing text between the two kinds' display fields. A 👥 item
// stores the work in `myTask` and keeps `title` for the blocker; a 🔖 task uses
// `title`. Getting this wrong renders a blank row, which is how the bug shows up.
function displayTextFor(fromProps, toKind) {
  const props = fromProps || {};
  const text = String(props.myTask || props.title || props.captureTitle || "").trim();
  const target = kindMeta(toKind).displayField;
  return target === "myTask"
    ? { myTask: text, title: "" }
    : { title: text, myTask: "" };
}

module.exports = {
  PROVENANCE_KEYS,
  RETIRED_MARKER,
  SLACK_KINDS,
  adoptProvenance,
  displayTextFor,
  isRetiredKey,
  kindForReaction,
  kindMeta,
  otherKind,
  reactionFor,
  retireSlackKey,
  slackCoordsOf,
  slackKeyFor,
  slackKeysFor,
  slackKindOf,
  slackProvenanceOf,
};
