"use strict";

// Review-only deterministic fixtures. Production code never imports this file.
const commonStates = Object.freeze([
  "empty",
  "loading",
  "error",
  "long-text",
  "dense",
  "permission-limited",
]);

const onboarding = Object.freeze([
  { id: "welcome", target: null, state: "dense" },
  { id: "date-controls", target: "#date-nav", state: "dense" },
  { id: "day-progress", target: ".progress-wrap", state: "dense" },
  { id: "itinerary", target: "#tab-schedule", state: "long-text" },
  { id: "task-manager", target: "#sidecar-tabs", state: "dense" },
  { id: "notes", target: "#sn-open-btn", state: "long-text" },
  { id: "active-work", target: "#active-work-dock", state: "loading" },
  { id: "supporting-tabs", target: "#tab-bar", state: "permission-limited" },
  { id: "power-ups", target: null, state: "empty" },
  { id: "replay", target: "#dcc-settings-button", state: "error" },
]);

const surfaces = Object.freeze({
  schedule: commonStates,
  looseEnds: commonStates,
  taskDetails: commonStates,
  taskManager: commonStates,
  repeat: commonStates,
  calendar: commonStates,
  actual: commonStates,
  settings: commonStates,
  brief: commonStates,
  mycelium: commonStates,
  notes: commonStates,
  budget: commonStates,
  social: commonStates,
  petHome: commonStates,
  sharing: commonStates,
  publicTodo: commonStates,
  publicPet: commonStates,
  admin: commonStates,
  authentication: commonStates,
});

const records = Object.freeze({
  empty: Object.freeze([]),
  loading: Object.freeze([{ id: "loading-1", status: "loading", title: "Loading review data" }]),
  error: Object.freeze([{ id: "error-1", status: "error", title: "The request could not finish" }]),
  longText: Object.freeze([{ id: "long-1", status: "open", title: "A long title that tests wrapping without hiding the primary action or task state", detail: "Deterministic detail for layout review." }]),
  dense: Object.freeze(Array.from({ length: 24 }, (_, index) => Object.freeze({
    id: `dense-${index + 1}`,
    title: `Review task ${String(index + 1).padStart(2, "0")}`,
    status: index % 3 === 0 ? "done" : "open",
    priority: ["Low", "Medium", "High", "Critical"][index % 4],
    durationMinutes: 15 + (index % 6) * 15,
  }))),
  permissionLimited: Object.freeze([{ id: "limited-1", title: "Delegated review task", status: "open", capability: "read" }]),
});

module.exports = Object.freeze({ commonStates, onboarding, surfaces, records });
