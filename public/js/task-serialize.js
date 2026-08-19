// ======== TASK SERIALIZER ========
// One place that decides how a task's shared fields are shaped and defaulted,
// killing the ~half-dozen hand-built property bags that had quietly drifted
// (commute directions handled in some copies but not others; delegated/linked
// dropped on a couple of move paths). Browser: loaded after core.js/task-types.js
// and before its consumers (state.js/schedule.js/unfinished-tasks.js), exposing
// window.DCC.taskCommonProps / taskBlockProps. Node: require()d by tests. UMD
// wrapper matches task-types.js.
//
//   taskCommonProps(ev, overrides) -> the 14 shared value fields, canonical
//     defaults, commute reconciled both directions. Key names are the shared
//     ones (delegatedItemId/linkedBlockId/commuteMinutes/…). Used directly by
//     the in-memory/clone shapes (id/type/start/end added by the caller).
//   taskBlockProps(ev, overrides) -> taskCommonProps + the persistence keys a
//     blockStore.createBlock("block", …) call wants (local_id/duration/start/
//     end). Context keys (_pinnedStart, added_at, …) stay the
//     caller's job via a follow-on Object.assign so this output stays defined.
//
// `overrides` win over `ev` for any field before defaulting, so a caller can
// force source:"delegated" or priority:"Medium" without the "High" fallback ever
// firing. NOTE: taskCommonProps emits a `title`; callers that merge it as the
// SOURCE over a base carrying the positional title (e.g. schedulePickerFields)
// must drop title first, or the "" default clobbers the real one.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    const DCC = (root.DCC = root.DCC || {});
    DCC.taskCommonProps = api.taskCommonProps;
    DCC.taskBlockProps = api.taskBlockProps;
    DCC.taskSourceUrl = api.taskSourceUrl;
    DCC.taskSourceUrlBlocked = api.taskSourceUrlBlocked;
    DCC.taskSourceLabel = api.taskSourceLabel;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Source-backed triage items arrive with several field names depending on the
  // reader that produced them. Resolve that vocabulary once so scheduling, row
  // rendering and the one-time backfill cannot disagree about the deeplink.
  const SOURCE_URL_FIELDS = ["source_id", "link", "source_ref", "source_url", "url", "action_url", "actionUrl", "evidence_link"];
  // Schemes that must never reach an href. Hitting one ABORTS the walk rather
  // than skipping it: a hostile value in the highest-priority field is a signal
  // about the whole record, so falling through to a sibling field would launder it.
  //
  // Test the value the way a BROWSER reads it, not the way it is stored. Browsers
  // drop leading C0 controls and any whitespace sitting INSIDE a scheme before
  // parsing it, so href="jav&#9;ascript:alert(1)" still executes. Matching only
  // /^\s*javascript\s*:/ let those through, which mattered twice: the exported
  // predicate below is consumed as a safety gate, and a bypassed abort in one field
  // silently fell through to a sibling. Stripping is safe because the normalized
  // string is only ever tested, never returned.
  const SCHEME_NOISE = /[\u0000-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;
  const HOSTILE_SCHEME = /^(javascript|data|vbscript):/i;
  function schemeSafe(value) {
    return String(value == null ? "" : value).replace(SCHEME_NOISE, "");
  }

  // Two different non-URL cases live in these fields and they need opposite
  // handling, which a single first-truthy read cannot give them:
  //   HOSTILE  ("javascript:alert(1)") -> stop, resolve to "".
  //   OPAQUE   (a Waiting cycle key, "waiting:<id>:<date>") -> skip, keep looking.
  // Treating opaque as hostile is what hid the Slack permalink on Waiting
  // check-ins: waiting-items.js puts the cycle key in source_id while the real
  // deeplink sits one field over in link/source_ref, so the walk stopped on an
  // identity string and never reached it.
  function taskSourceUrl(value) {
    const src = value && typeof value === "object" ? value : null;
    if (!src) {
      const bare = String(value == null ? "" : value).trim();
      return /^https?:\/\//i.test(bare) ? bare : "";
    }
    for (const field of SOURCE_URL_FIELDS) {
      const raw = String(src[field] == null ? "" : src[field]).trim();
      if (!raw) continue;
      if (HOSTILE_SCHEME.test(schemeSafe(raw))) return "";
      if (/^https?:\/\//i.test(raw)) return raw;
    }
    return "";
  }

  // "This value is hostile" as opposed to "this value is not a link", so a caller
  // resolving across TWO records can honour the same abort taskSourceUrl applies
  // within one. Waiting check-ins need it: an empty source_id should fall through to
  // the Waiting item's deeplink, but a `javascript:` one must not -- otherwise the
  // fall-through launders exactly what the abort exists to stop.
  function taskSourceUrlBlocked(value) {
    return HOSTILE_SCHEME.test(schemeSafe(value));
  }

  function taskSourceLabel(value) {
    const url = taskSourceUrl(value).toLowerCase();
    if (!url) return "";
    if (url.includes("slack.com/")) return "Slack";
    if (url.includes("mail.google.com/")) return "Email";
    return "Source";
  }

  function taskCommonProps(ev, overrides) {
    const src = Object.assign({}, ev || {}, overrides || {});
    const commuteMinutes = src.commuteMinutes || src.commute_minutes || null;
    return {
      title: src.title || "",
      priority: src.priority || "High",
      meta: src.meta || "",
      detail: src.detail || "",
      notionUrl: src.notionUrl || "",
      source: src.source || "manual",
      // Preserve the original identity verbatim. Some task sources use a
      // non-URL identifier here; the renderer separately decides whether the
      // value is a safe jump link.
      source_id: src.source_id || "",
      tags: Array.isArray(src.tags) ? src.tags : [],
      delegatedItemId: src.delegatedItemId || null,
      // The triage item this task came from. Its absence here was a silent link
      // break: every picker-based create path serializes through this function, so
      // a scheduled triage row landed with triageId null and the strip's
      // ev.triageId === triageId dedupe could never match.
      triageId: src.triageId || null,
      linkedBlockId: src.linkedBlockId || null,
      linkedTagId: src.linkedTagId || null,
      commuteMinutes: commuteMinutes,
      commuteToMinutes: src.commuteToMinutes || src.commute_to_minutes || commuteMinutes || null,
      commuteBackMinutes: src.commuteBackMinutes || src.commute_back_minutes || src.commuteReturnMinutes || src.commute_return_minutes || null
    };
  }

  function taskBlockProps(ev, overrides) {
    const o = Object.assign({}, ev || {}, overrides || {});
    // Duration can legitimately be 0 (e.g. a checklist subtask), so null-check
    // rather than ||; prefer an explicit `duration`, fall back to `durMin`.
    const duration = o.duration != null ? o.duration : (o.durMin != null ? o.durMin : null);
    return Object.assign(taskCommonProps(ev, overrides), {
      local_id: o.local_id || o.id || null,
      duration: duration,
      start: o.start,
      end: o.end
    });
  }

  return {
    taskCommonProps: taskCommonProps,
    taskBlockProps: taskBlockProps,
    taskSourceUrl: taskSourceUrl,
    taskSourceUrlBlocked: taskSourceUrlBlocked,
    taskSourceLabel: taskSourceLabel
  };
});
