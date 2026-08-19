"use strict";

// Day Review items are authored outside the DCC and arrive with a generated id per
// session. The same low-value session can therefore receive a new id every night,
// which defeats the decision ledger's id-based dismissal. Loose Ends only walks a
// seven-day review window, so use the same window for exact-content suppression:
// a dismissal settles an identical title/tag signature for the rest of that window.
//
// This is a read overlay. Stored packets and their decisions remain untouched, so
// navigating to the original packet still exposes the decision and its audit trail.

const LOOKBACK_DAYS = 7;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function itemSignature(item) {
  if (!item || !normalize(item.title)) return "";
  const tags = asArray(item.tags).map(normalize).filter(Boolean).sort().join("|");
  return [normalize(item.title), normalize(item.type), tags].join("::");
}

function actionOf(value) {
  return typeof value === "string" ? value : (value && value.action) || "";
}

function reviewModel(state) {
  const root = state && (state.glymphatic_brief || state.glymphaticBrief);
  const current = root && (root.current || root);
  const pages = current && asArray(current.pages);
  const page = pages && pages.find((candidate) => candidate && candidate.id === "day-review");
  if (!root || !current || !page) return null;
  return { root, current, page, items: asArray(page.items).length ? page.items : asArray(current.did_today) };
}

function dismissedSignatures(state) {
  const model = reviewModel(state);
  const out = new Set();
  if (!model) return out;
  const decisions = model.root.decisions || {};
  for (const item of model.items) {
    if (actionOf(decisions[item && item.id]) === "dismiss") {
      const signature = itemSignature(item);
      if (signature) out.add(signature);
    }
    for (const followup of asArray(item && item.followups)) {
      if (actionOf(decisions[followup && followup.id]) === "dismiss") {
        const signature = itemSignature(followup);
        if (signature) out.add(signature);
      }
    }
  }
  return out;
}

function mergeFollowups(target, incoming) {
  const merged = asArray(target).slice();
  const seen = new Set(merged.map(itemSignature).filter(Boolean));
  for (const followup of asArray(incoming)) {
    const signature = itemSignature(followup);
    if (signature && seen.has(signature)) continue;
    if (signature) seen.add(signature);
    merged.push(followup);
  }
  return merged;
}

function applyDayReviewRepeatOverlay(state, recentRows) {
  const model = reviewModel(state);
  if (!model) return state;

  const dismissed = new Set();
  for (const row of asArray(recentRows)) {
    const priorState = row && (row.state_json || row.stateJson || row);
    for (const signature of dismissedSignatures(priorState)) dismissed.add(signature);
  }
  for (const signature of dismissedSignatures(state)) dismissed.add(signature);

  const kept = [];
  const bySignature = new Map();
  const suppressed = [];
  const currentDecisions = model.root.decisions || {};
  for (const original of model.items) {
    if (!original) continue;
    const item = { ...original, followups: asArray(original.followups).slice() };
    const signature = itemSignature(item);
    // Keep the item that OWNS this packet's decision. The full Day Review renders
    // that crossed-out card with Undo; only separately keyed repeats are hidden.
    const ownsDismissal = actionOf(currentDecisions[item.id]) === "dismiss";
    if (signature && dismissed.has(signature) && !ownsDismissal) {
      suppressed.push({ id: item.id || "", signature, reason: "dismissed-repeat" });
      continue;
    }
    if (signature && bySignature.has(signature)) {
      const prior = bySignature.get(signature);
      prior.followups = mergeFollowups(prior.followups, item.followups);
      suppressed.push({ id: item.id || "", signature, reason: "duplicate" });
      continue;
    }
    kept.push(item);
    if (signature) bySignature.set(signature, item);
  }

  const pages = asArray(model.current.pages).map((page) => page === model.page
    ? { ...page, items: kept, repeat_suppressed_items: suppressed }
    : page);
  const current = { ...model.current, pages };
  if (Array.isArray(model.current.did_today)) current.did_today = kept;
  const brief = { ...model.root, current };
  return { ...state, glymphatic_brief: brief };
}

module.exports = {
  LOOKBACK_DAYS,
  actionOf,
  applyDayReviewRepeatOverlay,
  dismissedSignatures,
  itemSignature,
  normalize,
  reviewModel,
};
