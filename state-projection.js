"use strict";

const ACTIVE_TOP_LEVEL = [
  "date",
  "last_updated_at",
  "last_updated_by",
  "sweep",
  "glymphatic_brief",
  "notifications",
];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pendingReviews(completions) {
  const tasks = Array.isArray(object(completions).tasks) ? completions.tasks : [];
  return tasks.filter((task) => task && task.needs_review === true && task.reviewed !== true);
}

function compactActiveState(value) {
  const state = object(value);
  const result = {};
  for (const key of ACTIVE_TOP_LEVEL) {
    if (state[key] !== undefined) result[key] = state[key];
  }

  const triage = object(state.triage);
  result.triage = {
    open_items: Array.isArray(triage.open_items) ? triage.open_items : [],
    metrics: object(triage.metrics),
    cycle_count: Number(triage.cycle_count || 0),
  };

  const schedule = object(state.schedule);
  result.schedule = {};
  for (const key of ["working_hours", "tasks_couldnt_fit", "end_time", "day_start"]) {
    if (schedule[key] !== undefined) result.schedule[key] = schedule[key];
  }

  const reviews = pendingReviews(state.completions);
  result.completions = { tasks: reviews };
  return result;
}

function compactArchiveState(value) {
  const state = compactActiveState(value);
  const source = object(value);
  const schedule = object(source.schedule);
  state.schedule.timeline = Array.isArray(schedule.timeline) ? schedule.timeline : [];
  state.meetings = Array.isArray(source.meetings) ? source.meetings : [];
  return state;
}

function compactState(value, options = {}) {
  return options.archive ? compactArchiveState(value) : compactActiveState(value);
}

module.exports = { compactState, compactActiveState, compactArchiveState, pendingReviews };
