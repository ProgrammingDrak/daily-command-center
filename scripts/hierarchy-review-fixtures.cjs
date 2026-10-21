// Disposable hierarchy fixtures. No copied user records or external services.
module.exports = function seedHierarchyReview(store, date) {
  const at = new Date().toISOString();
  const add = (id, properties, parent_id = null) =>
    store.set(id, {
      id,
      type: "block",
      date,
      parent_id,
      sort_order: store.size * 1000,
      properties: { local_id: id, type: "task", priority: "High", ...properties },
      created_at: at,
      updated_at: at,
      deleted_at: null
    });
  add("review-parent", { title: "Hierarchy QA parent", start: "09:00", end: "09:30", duration: 30 });
  add(
    "review-parent-step",
    { title: "Hierarchy QA nested destination", subtaskOf: "review-parent", start: "09:00", end: "09:00", duration: 0 },
    "review-parent"
  );
  add("review-wrap", {
    title: "Hierarchy QA wrap to reparent",
    isWrap: true,
    start: "10:00",
    end: "10:30",
    duration: 30,
    notes: "Keep root notes"
  });
  for (let i = 1; i <= 80; i++)
    add(
      "review-deep-" + i,
      {
        title: "Hierarchy QA level " + i,
        subtaskOf: i === 1 ? "review-wrap" : "review-deep-" + (i - 1),
        start: "10:00",
        end: "10:00",
        duration: 0,
        notes: "Keep level " + i + " notes"
      },
      i === 1 ? "review-wrap" : "review-deep-" + (i - 1)
    );
  add(
    "review-own-time",
    { title: "Hierarchy QA independent time", wrapId: "review-deep-45", start: "10:00", end: "10:15", duration: 15 },
    "review-deep-45"
  );
  add("review-unplanned", { title: "Hierarchy QA untimed task", start: null, end: null, duration: 30, untimed: true });
};
