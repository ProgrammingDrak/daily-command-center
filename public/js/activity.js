/* Private activity UI. Drafts stay in memory; records never enter localStorage. */
(function () {
  "use strict";
  const D = window.DCC, M = window.ActivityModel, esc = D.esc;
  const state = { from: null, to: null, records: [], weight: "lb", distance: "mi", exercise: "", archived: false, request: 0 };
  const drafts = new Map();
  let lastRemoved = null;
  const uid = () => "a-" + crypto.randomUUID();
  const selectedDate = () => (typeof viewDate === "string" && viewDate) || D.dates.todayKey();
  const fmt = n => n == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
  const elapsed = seconds => seconds == null ? "-" : Math.floor(Math.round(seconds) / 3600) + ":" + String(Math.floor(Math.round(seconds) / 60) % 60).padStart(2, "0") + ":" + String(Math.round(seconds) % 60).padStart(2, "0");
  const pace = seconds => seconds == null ? "—" : Math.floor(Math.round(seconds) / 60) + ":" + String(Math.round(seconds) % 60).padStart(2, "0");
  const options = (values, value) => values.map(x => '<option value="' + esc(x) + '"' + (x === value ? " selected" : "") + '>' + esc(x) + '</option>').join("");
  function field(label, path, value, type = "text", attrs = "") {
    return '<label class="act-field"><span>' + esc(label) + '</span><input data-path="' + esc(path) + '" type="' + type + '" value="' + esc(value ?? "") + '" ' + attrs + (type === "number" ? ' min="0" step="any" inputmode="decimal" placeholder="Unknown"' : '') + '></label>';
  }
  function select(label, path, value, values) { return '<label class="act-field"><span>' + esc(label) + '</span><select data-path="' + esc(path) + '">' + options(values, value) + '</select></label>'; }
  function button(label, action, attrs = "") { return '<button type="button" data-act="' + action + '" ' + attrs + '>' + esc(label) + '</button>'; }
  function newSet() { return { id: uid(), reps: null, weight: null, unit: state.weight }; }
  function newRun() { return { id: uid(), name: "Run", distance: null, unit: state.distance, seconds: null }; }
  function newFood() { return { id: uid(), name: "", portion: null, portionUnit: "", calories: null, protein: null, carbs: null, fat: null, nutritionState: "unknown", source: "" }; }
  function setFields(s, path) { return field("Reps", path + ".reps", s.reps, "number") + field("Weight", path + ".weight", s.weight, "number") + select("Unit", path + ".unit", s.unit, ["lb", "kg"]); }
  function remove(path) { return button("Remove", "remove", 'data-path-remove="' + path + '" class="act-remove"'); }
  function runFields(r, path) { return field("Run", path + ".name", r.name) + field("Distance", path + ".distance", r.distance, "number") + select("Unit", path + ".unit", r.unit, ["mi", "km", "m"]) + field("Elapsed seconds", path + ".seconds", r.seconds, "number"); }
  function foodFields(f, path) {
    return field("Food", path + ".name", f.name, "text", 'maxlength="160"') + field("Portion", path + ".portion", f.portion, "number") + field("Portion unit", path + ".portionUnit", f.portionUnit, "text", 'placeholder="g, cup, serving…" maxlength="60"') +
      M.NUTRIENTS.map(k => field(k === "calories" ? "Calories (kcal)" : k[0].toUpperCase() + k.slice(1) + " (g)", path + "." + k, f[k], "number")).join("") +
      select("Nutrition", path + ".nutritionState", f.nutritionState, ["unknown", "estimated", "known"]) + field("Nutrition source", path + ".source", f.source, "text", 'placeholder="Package label, recipe, manual estimate…" maxlength="300"');
  }
  function workoutEditor(v) {
    return v.plan.exercises.map((e, i) => '<section class="act-exercise"><div class="act-row">' + field("Exercise name", `plan.exercises.${i}.name`, e.name) + remove(`plan.exercises.${i}`) + '</div><h4>Planned sets</h4>' +
      (e.sets.map((s, j) => '<div class="act-set"><strong>Plan ' + (j + 1) + '</strong>' + setFields(s, `plan.exercises.${i}.sets.${j}`) + remove(`plan.exercises.${i}.sets.${j}`) + button("Log actual set", "actual-set", `data-ex="${i}" data-set="${j}"`) + '</div>').join("") || '<p class="act-muted">No planned sets. You can still log actual sets.</p>') + button("+ Planned set", "plan-set", `data-ex="${i}"`) +
      '<h4>Actual sets</h4>' + (v.actual.sets.map((s, j) => s.exerciseId !== e.id ? "" : '<div class="act-set act-actual"><strong>' + (s.planSetId ? 'For plan ' + (e.sets.findIndex(p => p.id === s.planSetId) + 1) : "Unplanned") + '</strong>' + setFields(s, `actual.sets.${j}`) + remove(`actual.sets.${j}`) + '</div>').join("") || '<p class="act-muted">No results logged.</p>') + button("+ Unplanned actual set", "actual-set", `data-ex="${i}"`) + '</section>').join("") +
      button("+ Exercise", "exercise") + '<section class="act-exercise"><h3>Running</h3><h4>Planned runs</h4>' + v.plan.runs.map((r, i) => '<div class="act-run">' + runFields(r, `plan.runs.${i}`) + remove(`plan.runs.${i}`) + button("Log actual run", "actual-run", `data-run="${i}"`) + '</div>').join("") + button("+ Planned run", "plan-run") +
      '<h4>Actual runs</h4>' + v.actual.runs.map((r, i) => '<div class="act-run act-actual">' + runFields(r, `actual.runs.${i}`) + remove(`actual.runs.${i}`) + '</div>').join("") + button("+ Unplanned actual run", "actual-run") + '</section>';
  }
  function mealEditor(v) {
    return '<p class="act-muted">Enter nutrients for the whole portion shown in that row. Blank means unknown. Logging a food never copies planned nutrients into consumed totals.</p>' + ["plan", "actual"].map(phase => '<section class="act-exercise"><h3>' + (phase === "plan" ? "Planned food" : "Consumed food") + '</h3>' + v[phase].foods.map((f, i) => '<div class="act-food' + (phase === "actual" ? ' act-actual' : '') + '">' + foodFields(f, `${phase}.foods.${i}`) + remove(`${phase}.foods.${i}`) + (phase === "plan" ? button("Log consumed portion", "actual-food", `data-food="${i}"`) : '') + '</div>').join("") + button(phase === "plan" ? "+ Planned food" : "+ Unplanned consumed food", phase === "plan" ? "plan-food" : "actual-food") + '</section>').join("");
  }
  async function open(taskId, taskType, title) {
    try {
      let row;
      try { row = await D.api("/api/activity/tasks/" + encodeURIComponent(taskId)); }
      catch (e) {
        if (!taskType || !/Choose Workout or Meal/.test(e.message)) throw e;
        row = { taskId, title, revision: 0, record: M.empty(taskType) };
      }
      edit(row);
    } catch (e) { D.toast(e.message); }
  }
  function edit(row) {
    let v = structuredClone(drafts.get(row.taskId)?.record || row.record), dirty = drafts.has(row.taskId), saving = false;
    if (drafts.has(row.taskId)) row = { ...row, revision: drafts.get(row.taskId).revision };
    const body = document.createElement("div"); body.className = "act-editor";
    const readOnly = row.removed || row.archived;
    lastRemoved = null;
    const draw = () => {
      body.innerHTML = '<p class="act-private">Private to your DCC account · ' + esc(v.taskType === "workout" ? "Workout" : "Meal") + '</p>' +
        (row.removed ? '<p class="act-notice">Task removed from the schedule. Its history is retained. Restore the task using DCC’s task recovery before editing.</p>' : '') +
        (row.archived ? '<p class="act-notice">This record is archived and excluded from dashboards. Restore it to edit.</p>' : '') +
        '<div class="act-row">' + field("Results date", "occurredOn", v.occurredOn || selectedDate(), "date") + '<p class="act-muted">Actuals stay on this date when the task moves. Saving a log does not mark the task complete.</p></div><div class="act-error" role="alert"></div>' +
        '<fieldset class="act-fields"' + (readOnly ? " disabled" : "") + '>' + (v.taskType === "workout" ? workoutEditor(v) : mealEditor(v)) + '</fieldset>' +
        (lastRemoved ? button("Undo removal", "undo-remove") : '') + '<div class="act-record-tools">' +
        (!readOnly ? button("Reuse plan…", "reuse") + button("Make repeat…", "repeat") : '') +
        (row.canUndo && !readOnly ? button("Undo last saved edit", "undo") : '') +
        (row.revision ? button(row.archived ? "Restore record" : "Archive record", row.archived ? "restore" : "archive") : '') + '</div>';
      if (readOnly) body.querySelector('[data-path="occurredOn"]').disabled = true;
    };
    const overlay = D.overlay.open({ title: row.title, body, actions: readOnly ? [{ label: "Close" }] : [
      { label: "Cancel" }, { label: "Save record", kind: "primary", keepOpen: true, onClick: async () => {
        if (saving) return false;
        const alert = body.querySelector(".act-error"); alert.textContent = "";
        try {
          v.occurredOn = M.hasActual(v) ? body.querySelector('[data-path="occurredOn"]').value : (v.occurredOn || null);
          const valid = M.validate(v); saving = true; setBusy(true);
          const saved = await D.api("/api/activity/tasks/" + encodeURIComponent(row.taskId), { method: "PUT", body: { record: valid, expectedRevision: row.revision } });
          dirty = false; drafts.delete(row.taskId); overlay.close("saved"); D.toast("Record saved", "success"); refresh();
          return saved;
        } catch (e) { alert.textContent = e.message; alert.scrollIntoView({ block: "nearest" }); return false; }
        finally { saving = false; setBusy(false); }
      } }
    ], onClose: () => {
      if (dirty) { drafts.set(row.taskId, { record: v, revision: row.revision }); D.toast("Unsaved draft kept on this page. Reopen the record to continue.", "info"); }
    } });
    overlay.el.classList.add("act-dialog"); draw();
    function setBusy(busy) { overlay.el.querySelectorAll("button").forEach(b => { b.disabled = busy; }); }
    body.addEventListener("input", e => {
      const path = e.target.dataset.path;
      if (!path || readOnly) return;
      const keys = path.split("."), key = keys.pop(), target = keys.reduce((obj, k) => obj[k], v);
      target[key] = e.target.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value;
      dirty = true;
    });
    body.addEventListener("change", e => {
      if (e.target.tagName === "SELECT") e.target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    body.addEventListener("click", async e => {
      const b = e.target.closest("[data-act]"); if (!b || saving) return;
      const action = b.dataset.act, ex = v.plan.exercises?.[Number(b.dataset.ex)];
      try {
        if (["undo", "archive", "restore"].includes(action)) {
          if (dirty) { body.querySelector(".act-error").textContent = "Save your draft before changing the saved record."; return; }
          const changed = await D.api("/api/activity/tasks/" + encodeURIComponent(row.taskId) + "/" + action, { method: "POST", body: { expectedRevision: row.revision } });
          dirty = false; drafts.delete(row.taskId); overlay.close("replaced"); edit(changed); refresh(); return;
        }
        if (action === "reuse" || action === "repeat") {
          if (dirty || !row.revision) { body.querySelector(".act-error").textContent = "Save this record before reusing its plan."; return; }
          overlay.close("replaced");
          if (action === "reuse") create(v.taskType, row);
          else window.openRepeatResponsibilityFromTask({ id: row.taskId, _blockId: row.taskId, title: row.title, type: v.taskType, durMin: 30 });
          return;
        }
        if (readOnly) return;
        if (action === "remove") {
          lastRemoved = structuredClone(v);
          const keys = b.dataset.pathRemove.split("."), index = Number(keys.pop()), arr = keys.reduce((obj, k) => obj[k], v), removed = arr[index];
          if (b.dataset.pathRemove.startsWith("plan.exercises") && keys.length === 2 && v.actual.sets.some(s => s.exerciseId === removed.id)) {
            body.querySelector(".act-error").textContent = "Remove the exercise’s actual sets first, or rename the exercise to preserve them."; return;
          }
          arr.splice(index, 1);
          v.actual.sets?.forEach(s => { if (s.planSetId === removed.id) s.planSetId = null; });
          v.actual.runs?.forEach(r => { if (r.planRunId === removed.id) r.planRunId = null; });
          v.actual.foods?.forEach(f => { if (f.planFoodId === removed.id) f.planFoodId = null; });
        }
        if (action === "undo-remove") { v = lastRemoved; lastRemoved = null; }
        if (action === "exercise") v.plan.exercises.push({ id: uid(), name: "", sets: [] });
        if (action === "plan-set") ex.sets.push(newSet());
        if (action === "actual-set") v.actual.sets.push({ ...newSet(), exerciseId: ex.id, planSetId: b.dataset.set == null ? null : ex.sets[Number(b.dataset.set)].id });
        if (action === "plan-run") v.plan.runs.push(newRun());
        if (action === "actual-run") v.actual.runs.push({ ...newRun(), planRunId: b.dataset.run == null ? null : v.plan.runs[Number(b.dataset.run)].id });
        if (action === "plan-food") v.plan.foods.push(newFood());
        if (action === "actual-food") {
          const p = v.plan.foods[Number(b.dataset.food)];
          v.actual.foods.push({ ...newFood(), name: p?.name || "", planFoodId: p?.id || null });
        }
        if (M.hasActual(v) && !v.occurredOn) v.occurredOn = body.querySelector('[data-path="occurredOn"]').value;
        dirty = true; draw();
      } catch (err) { body.querySelector(".act-error").textContent = err.message; }
    });
  }
  function create(type, source = null, initialTitle = "") {
    const body = document.createElement("div"); body.className = "act-editor";
    body.innerHTML = '<p class="act-muted">' + (source ? 'Copy the saved plan into a new task. Actuals start empty.' : 'Start a ' + esc(type) + ' task, then enter a plan or log results.') + '</p>' + field("Task title", "title", source?.title || initialTitle, "text", 'maxlength="160"') + field("Task date", "date", selectedDate(), "date") + field("Scheduled duration (minutes)", "duration", 30, "number") + '<p class="act-muted">Creates an all-day task. Use the task’s date/time controls to schedule a time.</p><div class="act-error" role="alert"></div>';
    let busy = false;
    const overlay = D.modal({ title: source ? "Reuse plan" : "New " + type, body, actions: [{ label: "Cancel" }, { label: "Create task", kind: "primary", keepOpen: true, onClick: async () => {
      if (busy) return false;
      busy = true;
      try {
        const get = key => body.querySelector('[data-path="' + key + '"]').value;
        const row = await D.api("/api/activity/tasks", { method: "POST", body: { title: get("title"), date: get("date"), duration: Number(get("duration")), ...(source ? { sourceId: source.taskId } : { record: M.empty(type) }) } });
        overlay.close("replaced"); edit(row); refresh();
      } catch (e) { body.querySelector(".act-error").textContent = e.message; }
      finally { busy = false; }
      return false;
    } }] });
  }
  function nutrient(n) { return '<strong>' + fmt(n.value) + '</strong><small>' + n.known + '/' + n.total + ' foods known' + (n.estimated ? ' · ' + n.estimated + ' estimated' : '') + '</small>'; }
  function dashboard() {
    const mount = document.getElementById("activity-dashboard"); if (!mount) return;
    const rows = state.records.filter(r => !r.archived), days = M.summarize(rows, state.from, state.to, state);
    const total = key => days.reduce((s, d) => s + d[key], 0), keys = [...new Set(days.flatMap(d => Object.keys(d.exercises)))].sort();
    if (!keys.includes(state.exercise)) state.exercise = keys[0] || "";
    const planned = total("workoutTasks"), done = total("completedWorkouts"), loggedDays = days.filter(d => d.loggedWorkouts > 0).length;
    const peak = Math.max(1, ...days.map(d => d.exercises[state.exercise]?.volume || 0));
    mount.innerHTML = '<div class="act-metrics"><article><span>Workout completion</span><strong>' + done + ' / ' + planned + '</strong><small>' + (planned ? Math.round(done / planned * 100) + '% of scheduled workouts' : 'No scheduled workouts') + '</small></article><article><span>Workout consistency</span><strong>' + loggedDays + ' / ' + days.length + '</strong><small>days with logged results</small></article><article><span>Meals logged</span><strong>' + total("loggedMeals") + '</strong><small>' + total("mealTasks") + ' planned tasks in range</small></article></div>' +
      '<section class="act-card"><div class="act-heading"><h3>Exercise trends</h3><label>Exercise <select id="act-exercise">' + (keys.length ? options(keys, state.exercise) : '<option>No logged sets</option>') + '</select></label></div><p class="act-muted">Compare the same exercise over time. Volume = weight × reps for complete pairs only. Missing weights and reps stay unknown.</p><div class="act-table-wrap"><table><thead><tr><th>Date</th><th>Sets</th><th>Reps</th><th>Max load (' + state.weight + ')</th><th>Volume (' + state.weight + ' × reps)</th></tr></thead><tbody>' + days.filter(d => d.exercises[state.exercise]).map(d => { const a = d.exercises[state.exercise]; return '<tr><th>' + d.date + '</th><td>' + a.sets + '</td><td>' + fmt(a.reps) + '</td><td>' + fmt(a.maxLoad) + '</td><td><div class="act-bar" style="--bar:' + ((a.volume || 0) / peak * 100) + '%">' + fmt(a.volume) + '</div><small>' + a.volumeSets + '/' + a.sets + ' complete pairs</small></td></tr>'; }).join("") + '</tbody></table></div>' + (!keys.length ? '<p class="act-empty">Log actual sets to see exercise trends.</p>' : '') + '</section>' +
      '<section class="act-card"><h3>Running</h3><p class="act-muted">Pace uses only runs with both positive distance and elapsed time; no average of pace averages.</p><div class="act-table-wrap"><table><thead><tr><th>Date</th><th>Planned (' + state.distance + ')</th><th>Actual (' + state.distance + ')</th><th>Planned time</th><th>Actual time</th><th>Pace /' + state.distance + '</th></tr></thead><tbody>' + days.filter(d => d.plannedRuns.count || d.actualRuns.count).map(d => '<tr><th>' + d.date + '</th><td>' + fmt(d.plannedRuns.distance) + '</td><td>' + fmt(d.actualRuns.distance) + '<small>' + d.actualRuns.distanceKnown + '/' + d.actualRuns.count + ' distances logged</small></td><td>' + elapsed(d.plannedRuns.seconds) + '</td><td>' + elapsed(d.actualRuns.seconds) + '<small>' + d.actualRuns.timeKnown + '/' + d.actualRuns.count + ' times logged</small></td><td>' + pace(d.actualRuns.pace) + '<small>' + d.actualRuns.paired + '/' + d.actualRuns.count + ' runs with pace</small></td></tr>').join("") + '</tbody></table></div>' + (!days.some(d => d.plannedRuns.count || d.actualRuns.count) ? '<p class="act-empty">No runs in this range.</p>' : '') + '</section>' +
      '<section class="act-card"><h3>Daily meal log</h3><p class="act-muted">Logged totals only, not full-day intake. Each nutrient shows how many foods have a value. A dash means unknown; zero means explicitly logged zero.</p><div class="act-table-wrap"><table><thead><tr><th>Date / coverage</th><th>Phase</th><th>Calories (kcal)</th><th>Protein (g)</th><th>Carbs (g)</th><th>Fat (g)</th></tr></thead><tbody>' + days.map(d => ['planned', 'actual'].map((phase, i) => '<tr><th>' + (i ? '' : d.date + '<small>' + d.loggedMeals + ' logged meals / ' + d.mealTasks + ' planned tasks</small>') + '</th><td>' + (i ? 'Consumed' : 'Planned') + '</td>' + M.NUTRIENTS.map(k => '<td>' + nutrient(d[phase + 'Nutrition'][k]) + '</td>').join('') + '</tr>').join('')).join('') + '</tbody></table></div></section>' +
      '<section class="act-card"><h3>Records</h3><p class="act-muted">Removed tasks keep their logged history here. Archived records are excluded from totals.</p><div class="act-records">' + (state.records.map(r => '<article><div><span class="act-type">' + esc(r.record.taskType) + '</span><strong>' + esc(r.title) + '</strong><small>Planned ' + esc(r.date || 'unscheduled') + ' · Results ' + esc(r.record.occurredOn || 'not logged') + (r.removed ? ' · Task removed' : '') + (r.archived ? ' · Record archived' : '') + '</small></div>' + button(r.archived ? 'View / restore' : 'Open record', 'open', 'data-id="' + esc(r.taskId) + '"') + '</article>').join('') || '<p class="act-empty">No workout or meal records in this date range. Start with a plan or log what happened.</p>') + '</div></section>';
    mount.querySelector('#act-exercise').onchange = e => { state.exercise = e.target.value; dashboard(); };
  }
  function query() { return new URLSearchParams({ from: state.from, to: state.to, includeArchived: String(state.archived) }); }
  async function refresh() {
    if (!state.from) return;
    const request = ++state.request, error = document.getElementById("activity-error");
    try {
      M.dateRange(state.from, state.to);
      const data = await D.api("/api/activity?" + query());
      if (request !== state.request) return;
      state.records = data.records; if (error) error.textContent = ""; dashboard();
    } catch (e) {
      if (request !== state.request) return;
      state.records = [];
      document.getElementById("activity-dashboard").innerHTML = "";
      if (error) error.textContent = e.message;
    }
  }
  function activate() {
    const root = document.getElementById("tab-activity");
    state.to = selectedDate(); state.from = D.dates.addDays(state.to, -6);
    root.innerHTML = '<div class="activity-page"><header class="act-heading"><div><p class="act-private">Private · DCC records</p><h2>Workouts &amp; meals</h2><p class="act-muted">Plan the day. Log what happened. Learn from your own history.</p></div><div class="act-row">' + button('+ Workout', 'create-workout') + button('+ Meal', 'create-meal') + '</div></header><div class="act-toolbar"><div class="act-row">' + button('Today', 'today') + button('7 days', 'week') + button('30 days', 'month') + field('From', 'from', state.from, 'date') + field('To', 'to', state.to, 'date') + button('Apply dates', 'range') + '</div><div class="act-row">' + select('Weights', 'weight', state.weight, ['lb', 'kg']) + select('Distances', 'distance', state.distance, ['mi', 'km']) + '<label class="act-check"><input id="act-archived" type="checkbox"' + (state.archived ? ' checked' : '') + '> Show archived records</label>' + button('Export JSON', 'json') + button('Export CSV', 'csv') + '</div></div><p id="activity-error" class="act-error" role="alert"></p><div id="activity-dashboard" aria-live="polite">Loading private records…</div><p class="act-muted">Records live in DCC. No nutrition lookup or automatic Mycelium sync.</p></div>';
    root.onclick = async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const action = b.dataset.act;
      if (action.startsWith('create-')) return create(action.slice(7));
      if (action === 'open') return open(b.dataset.id);
      if (['today', 'week', 'month', 'range'].includes(action)) {
        state.to = action === 'range' ? root.querySelector('[data-path="to"]').value : (action === 'today' ? D.dates.todayKey() : selectedDate());
        state.from = action === 'range' ? root.querySelector('[data-path="from"]').value : D.dates.addDays(state.to, action === 'week' ? -6 : action === 'month' ? -29 : 0);
        for (const key of ['from', 'to']) {
          const input = root.querySelector('[data-path="' + key + '"]');
          input.value = state[key]; input.__twRender?.();
        }
        return refresh();
      }
      if (['json', 'csv'].includes(action)) {
        try {
          const url = '/api/activity/export?' + query() + '&format=' + action, response = await fetch(url);
          if (!response.ok) throw new Error((await response.json()).error || 'Export failed');
          const link = document.createElement('a'), href = URL.createObjectURL(await response.blob());
          link.href = href; link.download = 'dcc-activity.' + action; link.click(); URL.revokeObjectURL(href);
        } catch (err) { D.toast(err.message); }
      }
    };
    root.onchange = e => {
      const key = e.target.dataset.path;
      if (['weight', 'distance'].includes(key)) { state[key] = e.target.value; dashboard(); }
      if (e.target.id === 'act-archived') { state.archived = e.target.checked; refresh(); }
    };
    refresh();
  }
  function taskButton(taskId, task) {
    const host = document.getElementById('am-activity-entry'); if (!host) return;
    host.innerHTML = '';
    if (!task || !['task', 'focus', 'habit', ...M.TYPES].includes(task.type || 'task')) return;
    const type = M.TYPES.includes(task.type) ? task.type : null;
    host.innerHTML = '<div class="am-section-label">Private activity record</div><div class="act-row">' + (type ? button('Open ' + type + ' plan & log', type) : button('Use as Workout', 'workout') + button('Use as Meal', 'meal')) + '</div>';
    host.querySelectorAll('button').forEach(b => { b.onclick = () => { if (typeof closeAddModal === 'function') closeAddModal(); open(taskId, b.dataset.act, task.title); }; });
  }
  D.Activity = { activate, open, create, taskButton, refresh };
  window.addEventListener('dcc:view-date-changed', () => {
    if (document.getElementById('tab-activity')?.classList.contains('active')) activate();
  });
  D.tabs.register('activity', activate);
})();
