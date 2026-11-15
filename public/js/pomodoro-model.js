// Pure focus-plan transitions. Elapsed countdowns never imply recorded work.
(function (root, factory) {
  if (typeof module === "object") module.exports = factory();
  else root.DCCPomodoroModel = factory();
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const DURATION = 20 * 60 * 1000;
  function valid(p) {
    return (
      p?.version === 1 &&
      typeof p.id === "string" &&
      typeof p.taskId === "string" &&
      typeof p.title === "string" &&
      Number.isInteger(p.revision) &&
      p.revision >= 0 &&
      Array.isArray(p.objectives) &&
      p.objectives.length === 4 &&
      p.objectives.every((x) => typeof x === "string" && x.length <= 500) &&
      Number.isInteger(p.section) &&
      p.section >= 0 &&
      p.section <= 4 &&
      ["ready", "running", "paused", "complete", "cancelled"].includes(p.status) &&
      Number.isFinite(p.remaining) &&
      p.remaining >= 0 &&
      p.remaining <= DURATION &&
      (p.status !== "running" || Number.isFinite(p.deadline)) &&
      (p.status !== "running" || !!p.objectives[p.section]?.trim()) &&
      (p.section === 4) === (p.status === "complete")
    );
  }
  function create(task, id) {
    return {
      version: 1,
      id,
      taskId: String(task.id),
      title: String(task.properties?.title || task.title || "Task"),
      revision: 0,
      objectives: ["", "", "", ""],
      section: 0,
      status: "ready",
      remaining: DURATION,
      deadline: null
    };
  }
  function remaining(p, now) {
    return p.status === "running" ? Math.max(0, Math.min(DURATION, p.deadline - now)) : p.remaining;
  }
  function elapsed(p, now) {
    return p.status === "running" && remaining(p, now) === 0;
  }
  function change(p, action, objectives, now) {
    if (!valid(p) || !Number.isFinite(now)) throw new Error("Invalid focus plan.");
    const n = { ...p, objectives: [...p.objectives], revision: p.revision + 1 };
    if (objectives) {
      if (objectives.length !== 4 || objectives.some((x) => typeof x !== "string" || x.length > 500))
        throw new Error("Objectives must be at most 500 characters.");
      n.objectives = objectives.map((x, i) => (i < p.section ? p.objectives[i] : x.trim()));
    }
    if (["complete", "cancelled"].includes(p.status)) throw new Error("This plan is complete.");
    if (p.status === "running" && !n.objectives[p.section])
      throw new Error("Keep an objective for the running section.");
    if (action === "end") {
      n.status = "cancelled";
      n.remaining = remaining(p, now);
      n.deadline = null;
    } else if (action === "start") {
      if (!["ready", "paused"].includes(p.status)) throw new Error("This section has already started.");
      if (!n.objectives[p.section]) throw new Error("Set an objective for this section first.");
      n.status = "running";
      n.deadline = now + p.remaining;
    } else if (action === "pause") {
      if (p.status !== "running" || elapsed(p, now)) throw new Error("This section is no longer running.");
      n.remaining = remaining(p, now);
      n.deadline = null;
      n.status = "paused";
    } else if (action === "next") {
      if (!elapsed(p, now)) throw new Error("Wait for this section to finish.");
      n.section++;
      n.remaining = DURATION;
      n.deadline = null;
      n.status = n.section === 4 ? "complete" : "ready";
    } else if (action !== "save") throw new Error("Unknown focus action.");
    return n;
  }
  return { DURATION, valid, create, remaining, elapsed, change };
});
