// One catalog for consent, management, discovery and execution. Legacy scopes
// keep their original meaning; new grants never inherit them implicitly.
const categories = [
  ["tasks", "Tasks and scheduling", "Create, edit, schedule, complete and restore tasks and subtasks."],
  [
    "cleanup",
    "Task deletion",
    "Preview and remove selected open tasks. Review the cleanup manifest before applying it."
  ],
  [
    "activity",
    "Activity controls",
    "Read current activity. Start and pause foreground work and change DCC background bookkeeping."
  ],
  ["itinerary", "Itinerary", "Read and schedule activities with timezones, locations and travel details."],
  [
    "calendar",
    "Connected calendar",
    "Read connected calendar events. Manage provider events in their source calendar."
  ],
  ["repeats", "Repeat tasks", "Manage definitions, schedules, occurrences, routine steps and recurring workouts."],
  [
    "queue",
    "Working Queue and delegation",
    "Manage priorities, timers, foreground/background state and delegated work."
  ],
  ["time", "Time records", "Inspect and correct recorded sessions and actual time."],
  ["organization", "Projects and organization", "Manage projects, categories, saved views and imports."],
  ["files", "Task files", "List, upload, download, remove and restore task attachments."]
].map(([id, label, description]) => ({
  id,
  label,
  description,
  read: `dcc.${id}.read`,
  write: id === "calendar" ? null : `dcc.${id}.write`
}));
const legacyDescriptions = {
  "dcc.events":
    "Subscribe this chat to check-back deadlines for explicitly selected tasks. DCC stores a verified callback and encrypted signing key and delivers task IDs and deadlines until expiry or cancellation. Requires read access; never completes tasks.",
  "dcc.wishlist.read": "Read private Wishlists and their structured research.",
  "dcc.wishlist.write": "Create and edit private Wishlists and their structured research.",
  "dcc.capture": "Save explicitly requested, undated Someday ideas.",
  "dcc.read": "Find current, completed, and recurring tasks; read timing and audit history.",
  "dcc.work":
    "Manage Working Queue membership (add or remove without deleting tasks), order, priority, context, blockers and check-back reminders, including Return to Priority. Start and pause foreground timers and change DCC background bookkeeping. Does not start or stop external workers.",
  "dcc.correct": "Correct time allocation, including existing calendar meetings and unknown intervals.",
  "dcc.reconcile":
    "Review explicit task outcomes, reversibly drop one occurrence, undo a review choice, and close a work iteration with a linked next-action task. Does not complete an entire recurring series.",
  "dcc.complete": "Mark an explicitly selected task complete.",
  "dcc.delegate":
    "Link or create explicitly delegated tasks and report background progress or human review needs; never start focus or send external messages."
};
const legacy = [
  "dcc.events",
  "dcc.read",
  "dcc.work",
  "dcc.correct",
  "dcc.complete",
  "dcc.delegate",
  "dcc.reconcile",
  "dcc.capture",
  "dcc.wishlist.read",
  "dcc.wishlist.write"
];
const scopes = [...legacy, ...categories.flatMap((c) => [c.read, c.write].filter(Boolean))];
function level(granted, id) {
  const c = categories.find((c) => c.id === id);
  if (!c) return "off";
  if (c.write && granted.includes(c.write)) return "write";
  return granted.includes(c.read) ? "read" : "off";
}
function selected(body, allowed = scopes) {
  const chosen = [];
  for (const c of categories) {
    const value = body[c.id] || "off";
    if (!["off", "read", "write"].includes(value)) throw new Error("Invalid permission choice");
    if (value !== "off") chosen.push(c.read);
    if (value === "write") {
      if (!c.write) throw new Error("This category supports read access only");
      chosen.push(c.write);
    }
  }
  const old = Array.isArray(body.legacy) ? body.legacy : body.legacy ? [body.legacy] : [];
  chosen.push(...old.filter((s) => legacy.includes(s)));
  if (chosen.some((s) => !allowed.includes(s)))
    throw new Error("Requested access is not available in this authorization. Reconnect with the additional scopes.");
  return [...new Set(chosen)];
}
function defaults() {
  return [categories[0].read, categories[0].write];
}
module.exports = { categories, legacy, legacyDescriptions, scopes, level, selected, defaults };
