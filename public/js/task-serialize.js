// ======== TASK SERIALIZER ========
// One place that decides how a task's shared fields are shaped and defaulted,
// killing the ~half-dozen hand-built property bags that had quietly drifted
// (commute directions handled in some copies but not others; delegated/linked
// dropped on a couple of move paths). Browser: loaded after core.js/task-types.js
// and before its consumers (state.js/schedule.js/unfinished-tasks.js), exposing
// window.DCC.taskCommonProps / taskBlockProps. Node: require()d by tests. UMD
// wrapper matches task-types.js.
//
//   taskCommonProps(ev, overrides) -> the 13 shared value fields, canonical
//     defaults, commute reconciled both directions. Key names are the shared
//     ones (delegatedItemId/linkedBlockId/commuteMinutes/…). Used directly by
//     the in-memory/clone shapes (id/type/start/end added by the caller).
//   taskBlockProps(ev, overrides) -> taskCommonProps + the persistence keys a
//     blockStore.createBlock("block", …) call wants (local_id/duration/start/
//     end). Context keys (_pinnedStart, added_at, pushed_from, …) stay the
//     caller's job via a follow-on Object.assign so this output stays defined.
//
// `overrides` win over `ev` for any field before defaulting, so a caller can
// force source:"pushed" or priority:"Medium" without the "High" fallback ever
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
  }
})(typeof self !== "undefined" ? self : this, function () {
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
      tags: Array.isArray(src.tags) ? src.tags : [],
      delegatedItemId: src.delegatedItemId || null,
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

  return { taskCommonProps: taskCommonProps, taskBlockProps: taskBlockProps };
});
