(function () {
"use strict";

const app = document.getElementById("app");
const dialog = document.getElementById("dialog");
const notice = document.getElementById("notice");
const escapeHtml = window.DCC.esc;
const categories = ["Outdoors", "Culture", "Food & drink", "Transport", "Stay", "City or region", "Event", "Shop", "Other"];
const lifecycle = ["Idea", "Researching", "Planning", "Ready to Schedule", "Confirmed", "In Progress", "Completed", "Archived"];
const periods = ["Morning", "Afternoon", "Evening"];
const transport = ["Walking", "Cycling", "Driving", "Public transit"];
const defaultViewport = { center: [0, 15], scale: 2.7 };
const zoneList = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") :
  ["UTC", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "America/Bogota", "Europe/London"];
const account = window.DCC_ACCOUNT_CONTEXT;
const owner = account ? account.userId + ":" + account.workspaceId : "";

function uid() {
  return crypto.randomUUID();
}

function makeStop(placeId, period = "Morning") {
  return { id: uid(), placeId, period, time: "", notes: "", locked: false, optional: false };
}

function makeTrip(name, count, zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", season = "") {
  const id = uid();
  return {
    id, family: id, name, version: "Original", mode: "Hypothetical", status: "Planning", start: "",
    zone, season, notes: "", transport: "Walking", buffer: 30, budget: null, currency: zone === "Asia/Tokyo" ? "JPY" : "USD",
    days: Array.from({ length: count }, () => ({ id: uid(), stops: [], notes: "" }))
  };
}

let data = { places: [], trips: [], active: null };
let saved = structuredClone(data);
let section = new URLSearchParams(location.search).has("trip") ? "trips" : "places";
let libraryView = "gallery";
let search = "";
let category = "";
let locationFilter = "";
let collection = "All saved";
let sort = "recent";
let selected = new Set();
let activeDay = 0;
let editorView = "timeline";
let viewport = { ...defaultViewport };
let dragging;
let notificationTimer;
let nearby;
let placingPin = false;
let routePreview;
let pending = null;
let busy = false;

async function api(path = "", init = {}) {
  const response = await fetch("/api/places" + path, { ...init,
    headers: { "X-DCC-Places-Owner": owner, ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "Places request failed."), { status: response.status });
  return body;
}

async function refresh() {
  const active = data.active || new URLSearchParams(location.search).get("trip");
  data = await api();
  data.active = data.trips.some(trip => trip.id === active) ? active : data.trips[0]?.id;
  saved = structuredClone(data);
}

async function runCommand(command, message, { activateResult = false, after } = {}) {
  if (busy || pending) return;
  pending = { command, message, activateResult, after, requestId: uid() };
  await commitPending();
}

async function commitPending() {
  if (busy || !pending) return;
  busy = true;
  app.inert = true;
  dialog.inert = true;
  try {
    pending.result ??= await api("/mutations/" + pending.requestId, {
      method: "PUT", headers: { "Content-Type": "application/json", "X-DCC-Places": "1" }, body: JSON.stringify(pending.command)
    });
    const { result, activateResult, message, after } = pending;
    if (activateResult) activate(result.id);
    await refresh();
    pending = null;
    closeDialog();
    render();
    if (message) say(message);
    if (after) await after(result);
  } catch (error) {
    if (pending && !pending.result && error.status >= 400 && error.status < 500) {
      pending = null;
      data = structuredClone(saved);
      render();
      const reload = error.status === 409 ? button("Reload records", "reload", "", "small") : "";
      const message = escapeHtml(error.message);
      if (dialog.open) {
        let warning = dialog.querySelector(".error-text");
        if (!warning) {
          warning = document.createElement("p");
          warning.className = "error-text";
          warning.setAttribute("role", "alert");
          dialog.querySelector(".dialog-content").prepend(warning);
        }
        warning.innerHTML = message + " " + reload;
      } else showDialog("Change not saved", '<p class="error-text">' + message + '</p>' + reload);
    } else if (pending) {
      render();
      showDialog("Connection interrupted", '<p class="error-text">' + escapeHtml(error.message) +
        '</p><p>Retry the same request to recover the result safely.</p>' + button("Retry save", "retry-save", "", "primary"));
    } else say(error.message);
  } finally {
    busy = false;
    app.inert = false;
    dialog.inert = false;
  }
}

function say(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { notice.hidden = true; }, 4200);
}

function updated(message) {
  for (const [field, action] of [["places", "place"], ["trips", "trip"]]) {
    const previous = new Map(saved[field].map(record => [record.id, record]));
    const item = data[field].find(record => JSON.stringify(record) !== JSON.stringify(previous.get(record.id)));
    if (item) {
      const original = previous.get(item.id);
      return runCommand({
        action: action + (original ? "-save" : "-create"), id: item.id, value: item, revision: original?.revision
      }, message);
    }
  }
  render();
}

function webUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function pointOf(place) {
  const shape = place?.geometries?.[0]?.shape;
  if (shape?.type === "Point") return shape.coordinates;
  return shape?.type === "Polygon" ? shape.coordinates[0][0] : shape?.coordinates[0];
}
function geoLabel(place) {
  const kind = place.geometries?.[0]?.kind;
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Unresolved";
}
function attachmentPath(id) { return "/api/places/records/" + id + "/attachments"; }
const covers = new Map();
function photoOf(place) { return covers.get(place.id); }

function getPlace(id) { return data.places.find(place => place.id === id || place.mergedPlaceIds.includes(id)); }
function getTrip() { return data.trips.find(trip => trip.id === data.active); }
function label(stop) { return stop.title || getPlace(stop.placeId)?.name || "Activity"; }
function findStop(trip, id) {
  for (const day of trip.days) {
    const stop = day.stops.find(item => item.id === id);
    if (stop) return { day, stop };
  }
  return null;
}

function datePlus(date, offset) {
  const day = new Date(date + "T00:00:00Z");
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

function prettyDate(date) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric"
  }).format(new Date(date + "T00:00:00Z"));
}

function opts(values, current) {
  return values.map(item => {
    const [value, text] = Array.isArray(item) ? item : [item, item];
    return '<option value="' + escapeHtml(value) + '"' + (value === current ? " selected" : "") + '>' + escapeHtml(text) + "</option>";
  }).join("");
}

function budgetLabel(trip) {
  if (trip.budget == null) return "Cost inputs needed";
  return new Intl.NumberFormat("en", { style: "currency", currency: trip.currency, currencyDisplay: "code" }).format(trip.budget) + " · entered estimate";
}

function badge(label, kind = "") {
  return '<span class="badge ' + kind + '">' + escapeHtml(label) + "</span>";
}

function button(text, action, id = "", css = "", extra = "") {
  return '<button type="button" class="' + css + '" data-action="' + action + '" data-id="' + escapeHtml(id) + '" ' + extra + '>' + escapeHtml(text) + "</button>";
}

function field(name, title, control, wide = false) {
  return '<div class="field' + (wide ? ' field-wide' : '') + '"><label for="' + name + '">' + title + "</label>" + control + "</div>";
}

function link(url, text) {
  const safe = webUrl(url);
  return safe ? '<a target="_blank" rel="noopener noreferrer" href="' + escapeHtml(safe) + '">' + escapeHtml(text) + "</a>" : "";
}

function shownPlaces() {
  const term = search.trim().toLowerCase();
  const results = data.places.filter(place => (
    (collection === "Archived" ? place.archived : !place.archived) &&
    (!term || [place.name, place.region, place.group, place.notes, place.address, ...place.tags].join(" ").toLowerCase().includes(term)) &&
    (!category || place.category === category) && (!locationFilter || place.region === locationFilter) &&
    (["All saved", "Archived"].includes(collection) || place.collections.includes(collection) ||
      (collection === "Favorites" && place.favorite) || (collection === "Visited" && place.visits.length) ||
      (collection === "Needs location" && !pointOf(place)))
  ));
  if (!nearby) {
    if (sort === "name") return results.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "priority") {
      const rank = { High: 0, Normal: 1, Low: 2 };
      return results.sort((a, b) => rank[a.priority] - rank[b.priority]);
    }
    return results;
  }
  return results.filter(place => pointOf(place)).map(place => ({ ...place, nearbyKm: distance(nearby, pointOf(place)) }))
    .filter(place => place.nearbyKm <= 25).sort((a, b) => a.nearbyKm - b.nearbyKm);
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = Math.sin((b[1] - a[1]) * rad / 2);
  const dLon = Math.sin((b[0] - a[0]) * rad / 2);
  return 12742 * Math.asin(Math.sqrt(Math.min(1, dLat * dLat + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * dLon * dLon)));
}

function row(place, purpose = "library") {
  const chosen = selected.has(place.id);
  const control = purpose === "pool"
    ? button("Add", "add-stop", place.id, "small", 'aria-label="Add ' + escapeHtml(place.name) + ' to day"')
    : button(chosen ? "Selected" : "Select", "select-place", place.id, "small", 'aria-label="Select ' + escapeHtml(place.name) + '" aria-pressed="' + chosen + '"');
  return '<div class="list-row"><div>' + button(place.name, "details", place.id, "card-title") +
    '<p class="marker-label">' + escapeHtml([place.region || "Location unresolved", geoLabel(place), place.nearbyKm == null ? "" : place.nearbyKm.toFixed(1) + " km straight-line"].filter(Boolean).join(" · ")) + '</p></div>' + control + "</div>";
}

function card(place) {
  const photo = photoOf(place);
  const icon = { "Food & drink": "♨", "Transport": "↔", "Stay": "⌂" }[place.category] || "◇";
  const chosen = selected.has(place.id);
  return '<article class="card">' +
    (photo ? '<img class="card-photo" src="' + escapeHtml(photo) + '" alt="">' : '<div class="card-photo placeholder" aria-hidden="true">' + icon + '</div>') +
    '<div class="card-body"><div class="row spread">' + badge(place.category) + badge(geoLabel(place), geoLabel(place) === "Unresolved" ? "warn" : "neutral") +
    "</div><h3>" + button(place.name, "details", place.id, "card-title") + '</h3><p class="muted small-text">' + escapeHtml(place.region || "Location unresolved") +
    '</p><div class="row">' + button(chosen ? "Selected" : "Select", "select-place", place.id, "small",
      'aria-label="Select ' + escapeHtml(place.name) + '" aria-pressed="' + chosen + '"') + "</div></div></article>";
}

function captureBar() {
  return '<form id="quick-capture" class="inline-capture quick-capture">' +
    '<input id="quick-value" name="value" aria-label="Place name or link" placeholder="Place name or discovery link" maxlength="280" required>' +
    '<button class="primary" type="submit">Save place</button>' + button("Add source or screenshot", "capture", "", "quiet more") + button("Import existing record", "import-record", "", "small") + '</form>';
}

function filters() {
  const groups = [...new Set(data.places.map(place => place.region).filter(Boolean))].sort();
  return '<div class="filters">' +
    '<input type="search" id="search-places" aria-label="Find saved places" placeholder="Find saved places" value="' + escapeHtml(search) + '">' +
    '<select id="category-filter" aria-label="Category">' + opts([["", "All categories"], ...categories], category) + "</select>" +
    '<select id="location-filter" aria-label="Location">' + opts([["", "All locations"], ...groups], locationFilter) + "</select>" +
    '<select id="sort-places" aria-label="Sort places">' + opts([["recent", "Recently updated"], ["name", "Name"], ["priority", "Priority"]], sort) + '</select>' +
    '<div class="row" aria-label="Library view">' +
      [["gallery", "Gallery"], ["list", "List"], ["map", "Map"]].map(([key, text]) =>
        button(text, "library-view", key, "small", 'aria-pressed="' + (libraryView === key) + '"')).join("") + "</div></div>";
}

function mapMarkup() {
  return '<div class="map-surface" id="map-surface" aria-label="Map of approximate saved locations">' +
    '<canvas aria-hidden="true"></canvas><div class="markers"></div><div class="map-tools" aria-label="Map controls">' +
    button("+", "zoom-in", "", "", 'aria-label="Zoom in"') + button("−", "zoom-out", "", "", 'aria-label="Zoom out"') +
    button("←", "map-west", "", "", 'aria-label="Pan west"') + button("→", "map-east", "", "", 'aria-label="Pan east"') +
    button("↑", "map-north", "", "", 'aria-label="Pan north"') + button("↓", "map-south", "", "", 'aria-label="Pan south"') +
    button("Fit", "map-fit") + '</div><small class="map-caption">Natural Earth · Straight-line stop order</small></div>';
}

function placePage() {
  const places = shownPlaces();
  const blank = '<p class="empty">No saved places match these filters.</p>';
  const tray = selected.size
    ? '<div class="tray row spread"><span>' + selected.size + ' selected</span><div class="row">' +
      button("Clear", "clear-selection", "", "small") + button("Add to collection", "collect", "", "small") + button("Plan undated trip", "new-trip-selection", "", "primary") + '</div></div>'
    : "";
  const collectionList = [...new Set(["All saved", "Favorites", "Visited", "Needs location", "Someday",
    ...data.places.flatMap(place => place.collections), "Archived"])];
  const library = '<section class="stack">' + filters() + tray +
    '<div class="row spread"><h2>' + escapeHtml(collection === "All saved" ? "Saved places" : collection) + '</h2><span class="muted">' +
    places.length + ' ' + (places.length === 1 ? "place" : "places") + '</span></div>' +
    (libraryView === "map" ? '<div class="layout map-layout"><div class="pane stack"><div class="map-actions">' +
      button(nearby ? "Clear nearby filter" : "Near me", nearby ? "nearby-clear" : "nearby") +
      button("Set origin", "nearby-manual") + button(placingPin ? "Cancel pin" : "Drop a pin", "pin-mode") + '</div>' + mapMarkup() +
      '<p class="muted small-text">' + (placingPin ? "Tap the map or enter coordinates in the capture form." : nearby ?
        "Saved places within 25 km straight-line. Feasibility needs travel times and opening hours." :
        "Select marker clusters or results to build a trip. Places without geometry appear in the list.") + '</p></div>' +
      '<div class="pane"><h3>Map results</h3><div class="location-results">' + (places.map(place => row(place)).join("") || blank) + '</div></div></div>'
      : libraryView === "list" ? '<div class="pane cards-list">' + (places.map(place => row(place)).join("") || blank) + '</div>'
        : '<div class="gallery">' + (places.map(card).join("") || blank) + '</div>') + '</section>';
  return '<div class="page-head"><div><h1>Places &amp; Experiences</h1><p class="muted">Save discoveries and turn them into trips.</p></div>' +
    '<div class="row">' + button("New trip", "new-trip") + button("Mobile shares", "share-settings") +
    '</div></div><div class="stack">' + captureBar() +
    '<div class="layout library-layout"><aside class="pane"><p class="sidebar-title">Collections</p><div class="collections">' +
    collectionList.map(name => button(name, "collection", name, "collection", 'aria-current="' + (collection === name) + '"')).join("") +
    '</div></aside>' + library + '</div></div>';
}

function stopMarkup(stop, index, day) {
  const details = [stop.period, stop.time, stop.optional ? "Optional" : "", stop.locked ? "Locked" : ""].filter(Boolean);
  return '<div class="stop' + (stop.locked ? '' : ' draggable') + '" data-stop="' + stop.id + '" draggable="' + !stop.locked + '">' +
    '<span class="stop-index" aria-hidden="true"' + (stop.locked ? '' : ' title="Drag to move activity"') + '>' + (index + 1) + '</span><div><span class="stop-title">' + escapeHtml(label(stop)) +
    '</span><small class="muted">' + escapeHtml(details.join(" · ")) + '</small></div><div class="row">' +
    button("↑", "move-up", stop.id, "small", 'aria-label="Move ' + escapeHtml(label(stop)) + ' up"' + (index === 0 || stop.locked || day.stops[index - 1]?.locked ? " disabled" : "")) +
    button("↓", "move-down", stop.id, "small", 'aria-label="Move ' + escapeHtml(label(stop)) + ' down"' + (index === day.stops.length - 1 || stop.locked || day.stops[index + 1]?.locked ? " disabled" : "")) +
    button("Edit", "edit-stop", stop.id, "small", 'aria-label="Edit ' + escapeHtml(label(stop)) + '"') + '</div></div>';
}

function editor(trip) {
  const dated = trip.mode === "Scheduled";
  const stops = trip.days.flatMap(day => day.stops);
  const mapped = stops.filter(stop => pointOf(getPlace(stop.placeId))).length;
  const pool = data.places.filter(place => !place.archived && !stops.some(stop => stop.placeId === place.id));
  const maxDays = trip.days.length;
  const options = trip.days.map((_, index) => [String(index), "Day " + (index + 1)]);

  return '<section class="stack"><section class="pane editor-header stack"><div class="row spread"><div class="row">' +
    badge(trip.mode) + badge(trip.status, "neutral") + badge(trip.version, "neutral") +
    '</div>' + button("Trip settings", "trip-settings", "", "small") + '</div><div><h2>' + escapeHtml(trip.name) + '</h2><p class="muted sub">' +
    maxDays + (maxDays === 1 ? " day" : " days") + (dated ? " · Starts " + prettyDate(trip.start) : " · No dates") +
    (trip.season ? " · " + escapeHtml(trip.season) : "") + ' · ' + escapeHtml(trip.zone) + '</p>' +
    (trip.notes ? '<p>' + escapeHtml(trip.notes) + '</p>' : '') + '</div><div class="row">' +
    button("Compare versions", "compare") + button("Duplicate", "duplicate") + button("Add prep task", "prep-task", trip.id) +
    button("Link existing record", "related", "trip|" + trip.id) +
    (dated ? button("DCC scheduling preview", "dated-preview", "", "primary") + button("Change dates", "schedule") : button("Schedule this trip", "schedule", "", "primary")) +
    '</div>' + (trip.links?.length ? '<div>' + linksMarkup(trip.links, 'trip') + '</div>' : '') + '</section>' +
    '<div class="layout editor-layout"><section class="stack"><div class="row spread"><h2>' + (editorView === "map" ? "Trip map" : "Trip timeline") + '</h2><div class="row">' +
    button("Timeline", "editor-view", "timeline", "small", 'aria-pressed="' + (editorView === "timeline") + '"') +
    button("Route map", "editor-view", "map", "small", 'aria-pressed="' + (editorView === "map") + '"') +
    '</div></div>' + (editorView === "map" ? '<div class="pane stack">' + routePanel(trip) + mapMarkup() +
      '<p class="muted small-text">' + mapped + ' of ' + stops.length + ' stops mapped. Pins follow trip order. Dashed lines show straight-line sequence.</p></div>'
      : trip.days.map((day, index) => '<section class="day" data-day="' + index + '"><div class="day-header row spread"><div><h3>Day ' + (index + 1) +
        '</h3>' + (dated ? '<small class="muted">' + prettyDate(datePlus(trip.start, index)) + '</small>' : '') +
        '</div><div class="row">' + button("Notes", "day-notes", index, "small", 'aria-label="Edit Day ' + (index + 1) + ' notes"') +
        button("Add activity", "new-activity", index, "small", 'aria-label="Add activity to Day ' + (index + 1) + '"') + '</div></div>' +
        (day.notes ? '<p class="muted">' + escapeHtml(day.notes) + '</p>' : "") +
        (day.stops.length ? day.stops.map((stop, order) => stopMarkup(stop, order, day)).join("") : '<p class="empty">Open day</p>') + "</section>").join("")) +
    '</section><aside class="stack"><div class="pane stack"><div class="row spread"><h2>Unscheduled places</h2>' + button("Save a place", "capture", "", "small") +
    '</div>' + field("active-day", "Add to", '<select id="active-day">' + opts(options, String(activeDay)) + '</select>') +
    '<div class="pool-list">' + (pool.map(place => row(place, "pool")).join("") || '<p class="muted">All saved places are on this trip.</p>') + '</div></div>' +
    '<div class="pane stack"><h3>Planning assumptions</h3><p class="muted">' + escapeHtml(trip.transport) + ' · ' + trip.buffer +
    '% transfer buffer</p><p class="muted small-text">' + escapeHtml(budgetLabel(trip)) + '</p><p class="muted small-text">' + (dated ? "Review opening hours, access and transport for the selected dates." : "Opening hours, seasonal access and transport schedules depend on dates.") +
    '</p></div></aside></div></section>';
}

function routePanel(trip) {
  const routed = routePreview?.tripId === trip.id && routePreview.revision === trip.revision ? routePreview : null;
  const day = routed?.day ?? activeDay;
  const modes = ["Walking", "Cycling", "Driving"];
  const activityMinutes = trip.days[day].stops.map(stop => stop.duration ?? getPlace(stop.placeId)?.duration);
  const usable = activityMinutes.every(Number.isFinite);
  const transfer = routed?.segments.reduce((sum, leg) => sum + Math.ceil(Math.ceil(leg.duration / 60) * (1 + trip.buffer / 100)), 0);
  const total = usable && routed ? activityMinutes.reduce((sum, n) => sum + n, 0) + transfer : null;
  return '<section class="stack"><h3>Travel between stops</h3>' +
    (data.routingAvailable ? '<form id="route-form" class="form-grid">' +
      field("travel-day", "Day", '<select id="travel-day" name="day">' + opts(trip.days.map((_, i) => [String(i), "Day " + (i + 1)]), String(day)) + '</select>') +
      field("travel-mode", "Travel mode", '<select id="travel-mode" name="mode">' + opts(modes, routed?.mode || trip.transport) + '</select>') +
      field("travel-window", "Time available (minutes, optional)", '<input id="travel-window" name="window" type="number" min="1" max="1440" value="' + escapeHtml(routed?.window) + '">') +
      '<button type="submit">Check travel</button></form>' :
      '<p class="muted">Live routing is unavailable. Enter known transfer times in the timeline.</p>') +
    (routed ? '<div class="callout stack"><p>' + escapeHtml(routed.mode) + ' · ' + (routed.summary.distance / 1000).toFixed(1) +
      ' km · ' + Math.ceil(routed.summary.duration / 60) + ' min routed · Day ' + (routed.day + 1) + '</p>' +
      '<p class="muted small-text">openrouteservice · ' + escapeHtml(routed.observedAt.slice(0, 10)) + ' · ' +
      transfer +
      ' min with transfer buffer. Check conditions for your travel dates.</p>' +
      (total == null ? '<p>Enter all visit durations to check this time window.</p>' :
        '<p>' + total + ' min of routed transfers and entered activities' +
        (routed.window ? (total <= routed.window ? ' fits the ' : ' exceeds the ') + routed.window + ' min window' : "") +
        '. Venue hours and access still need verification.</p>') +
      button("Use these transfer times", "apply-route", "", "small") + '</div>' : '') +
    '<p class="muted small-text">Confirm public transit with its operator.</p></section>';
}

function tripPage() {
  const trip = getTrip();
  return '<div class="page-head"><div><h1>Trip planner</h1><p class="muted">Build an undated plan, compare versions and schedule when you’re ready.</p></div>' +
    button("New undated trip", "new-trip", "", "primary") + '</div><div class="layout trip-layout"><aside class="pane">' +
    '<p class="sidebar-title">Your trips</p><div class="collections">' +
    data.trips.map(item => button(item.name + " · " + item.version + (item.mode === "Scheduled" ? " · Dated" : ""), "activate-trip", item.id, "trip-select",
      'aria-current="' + (item.id === trip?.id) + '"')).join("") +
    '</div></aside>' + (trip ? editor(trip) : '<p class="empty">Create a trip to begin planning.</p>') + '</div>';
}

function render() {
  const before = document.activeElement;
  const restore = before?.id === "search-places" ? { start: before.selectionStart, end: before.selectionEnd } : null;
  app.innerHTML = '<nav class="nav-tabs" aria-label="Places workspace">' +
    button("Places library", "section", "places", "", 'aria-current="' + (section === "places") + '"') +
    button("Trip planner", "section", "trips", "", 'aria-current="' + (section === "trips") + '"') +
    '</nav>' + (section === "places" ? placePage() : tripPage());
  if (pending) {
    app.insertAdjacentHTML("afterbegin", '<div class="callout warning row spread"><p>A change is waiting for confirmation.</p>' +
      button("Retry save", "retry-save", "", "small") + '</div>');
  }
  if (restore) {
    const input = document.getElementById("search-places");
    if (input) {
      input.focus();
      input.setSelectionRange(restore.start, restore.end);
    }
  }
  const map = document.getElementById("map-surface");
  if (map) paintMap(map);
  if (section === "places" && libraryView === "gallery") loadCovers();
}

function fitMap() {
  const places = section === "places" ? shownPlaces() :
    getTrip()?.days.flatMap(day => day.stops).map(stop => getPlace(stop.placeId)).filter(Boolean) || [];
  const points = places.map(pointOf).filter(Boolean);
  if (!points.length) {
    say("No mapped locations to fit.");
    return;
  }
  const lon = points.map(point => point[0]);
  const lat = points.map(point => point[1]);
  const spreadLat = Math.max(...lat) - Math.min(...lat);
  const spreadLon = Math.max(...lon) - Math.min(...lon);
  const map = document.getElementById("map-surface");
  viewport = {
    center: [(Math.min(...lon) + Math.max(...lon)) / 2, (Math.min(...lat) + Math.max(...lat)) / 2],
    scale: Math.min(4200, (map.clientHeight - 90) / Math.max(spreadLat, .025), (map.clientWidth - 90) / Math.max(spreadLon * .78, .025))
  };
  paintMap(map);
}

function paintMap(map) {
  const canvas = map.querySelector("canvas");
  const width = map.clientWidth;
  const height = map.clientHeight;
  const res = window.devicePixelRatio || 1;
  canvas.width = width * res;
  canvas.height = height * res;
  const ctx = canvas.getContext("2d");
  ctx.scale(res, res);
  const [x0, y0] = viewport.center;
  const scale = viewport.scale * Math.min(1, width / 310);
  const project = ([lon, lat]) => [width / 2 + (lon - x0) * scale * .78, height / 2 - (lat - y0) * scale];
  const colors = getComputedStyle(map);
  ctx.fillStyle = colors.getPropertyValue("--surface-map").trim();
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#254059";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 35) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 35) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#508380";
  ctx.fillStyle = colors.getPropertyValue("--map-ground").trim();
  const japan = x0 >= 130 && x0 <= 147 && y0 >= 30 && y0 <= 46 && viewport.scale > 120;
  const rings = japan ? window.DCCPlacesJapan : window.DCCPlacesCoastline;
  for (const ring of rings) {
    ctx.beginPath();
    ring.forEach((point, i) => {
      const [x, y] = project(point);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  const planning = section === "trips";
  const trip = getTrip();
  const entries = planning ? trip.days.flatMap(day => day.stops).map((stop, index) => ({ place: getPlace(stop.placeId), i: index + 1 })) :
    shownPlaces().map(place => ({ place }));
  const positions = entries.map(entry => pointOf(entry.place) ? { ...entry, xy: project(pointOf(entry.place)) } : null);
  for (const { place } of entries) {
    for (const feature of place?.geometries || []) {
      if (feature.shape.type === "Point") continue;
      const lines = feature.shape.type === "Polygon" ? feature.shape.coordinates : [feature.shape.coordinates];
      ctx.setLineDash([]);
      ctx.strokeStyle = "#86c8bd";
      ctx.fillStyle = "#79c5bb33";
      for (const line of lines) {
        ctx.beginPath();
        for (const [i, point] of line.entries()) {
          const coords = project(point);
          if (!i || feature.shape.type === "MultiPoint") ctx.moveTo(...coords);
          else ctx.lineTo(...coords);
          if (feature.shape.type === "MultiPoint") ctx.arc(...coords, 4, 0, 2 * Math.PI);
        }
        if (feature.shape.type !== "LineString") ctx.fill();
        ctx.stroke();
      }
    }
  }
  if (nearby) {
    ctx.beginPath();
    ctx.arc(...project(nearby), 5, 0, 2 * Math.PI);
    ctx.fillStyle = "#91bfef";
    ctx.fill();
  }
  map.classList.toggle("pin-mode", placingPin);
  map.onclick = event => {
    if (!placingPin || event.target.closest("button")) return;
    const rect = map.getBoundingClientRect();
    const lon = x0 + (event.clientX - rect.left - width / 2) / (scale * .78);
    const lat = y0 - (event.clientY - rect.top - height / 2) / scale;
    placingPin = false;
    paintMap(map);
    if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) captureForm(null, { point: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] });
    else say("Choose a location within the world map.");
  };
  if (planning && routePreview?.tripId === trip.id && routePreview.revision === trip.revision) {
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#8abaff";
    ctx.lineWidth = 3;
    routePreview.geometry.coordinates.forEach((point, i) => {
      const coords = project(point);
      if (i) ctx.lineTo(...coords);
      else ctx.moveTo(...coords);
    });
    ctx.stroke();
  }
  const path = planning ? positions : positions.filter(item => item && selected.has(item.place.id))
    .sort((a, b) => [...selected].indexOf(a.place.id) - [...selected].indexOf(b.place.id));
  if (path.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = "#78e4c9";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    let hasPrevious = false;
    for (const item of path) {
      if (!item) { hasPrevious = false; continue; }
      if (hasPrevious) ctx.lineTo(...item.xy);
      else ctx.moveTo(...item.xy);
      hasPrevious = true;
    }
    ctx.stroke();
  }
  const layers = [];
  for (const item of positions) {
    if (!item) continue;
    const [x, y] = item.xy;
    if (x < 12 || x > width - 12 || y < 12 || y > height - 12) continue;
    const near = layers.find(layer => Math.hypot(layer.x - x, layer.y - y) < 39);
    if (near) near.items.push(item);
    else layers.push({ x, y, items: [item] });
  }
  const container = map.querySelector(".markers");
  container.replaceChildren();
  for (const layer of layers) {
    const { items, x, y } = layer;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.style.left = x + "px";
    marker.style.top = y + "px";
    marker.className = "map-pin";
    if (items.length > 1) {
      marker.classList.add("cluster");
      marker.textContent = items.length;
      marker.setAttribute("aria-label", "Explore cluster of " + items.length + " stops");
      marker.onclick = () => openCluster(items);
    } else {
      const { place, i } = items[0];
      marker.textContent = i || (selected.has(place.id) ? "✓" : "•");
      marker.classList.toggle("selected", selected.has(place.id) || planning);
      marker.setAttribute("aria-label", (planning ? "Show " : "Select map marker " ) + place.name);
      marker.title = place.name;
      marker.onclick = () => planning ? openDetails(place) : toggleSelection(place.id);
    }
    container.append(marker);
  }
}

function openCluster(items) {
  const results = section === "places" ? items.map(({ place }) => row(place)) :
    items.map(({ place, i }) => '<div class="list-row"><div><span class="marker-label">Stop ' + i + '</span> ' +
      button(place.name, "details", place.id, "card-title") + '</div></div>');
  showDialog("Nearby saved places", results.join(""));
}

function showDialog(title, body) {
  dialog.innerHTML = '<header class="dialog-head row spread"><h2 id="dialog-title">' + escapeHtml(title) + '</h2>' +
    button("Close", "close-dialog", "", "small") + '</header><div class="dialog-content stack">' + body + '</div>';
  if (!dialog.open) dialog.showModal();
  else dialog.querySelector(".dialog-head button").focus();
}

function closeDialog() { if (dialog.open) dialog.close(); }

async function fileRequest(path, init) {
  const response = await fetch(path, { ...init, headers: { "X-DCC-Places-Owner": owner, ...init?.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Place files are unavailable.");
  return result;
}

async function uploadImage(placeId, file, uploadId) {
  const body = new FormData();
  body.append("file", file);
  await fileRequest(attachmentPath(placeId), { method: "POST", headers: { "X-DCC-Attachment": "1", "X-Upload-Id": uploadId }, body });
  covers.delete(placeId);
  await refresh();
  render();
}

async function showFiles(place, container) {
  try {
    const files = await Promise.all([place.id, ...place.attachmentSources].map(async id => {
      const { files, textRecognition } = await fileRequest(attachmentPath(id));
      return files.filter(file => !file.removed && !file.pending).map(file => ({ ...file, parent: id, textRecognition }));
    }));
    container.innerHTML = files.flat().map(file => {
      const path = attachmentPath(file.parent) + "/" + file.id;
      return '<div class="row">' + (file.mime.startsWith("image/") ? '<img class="attachment-thumb" src="' + path + '/preview" alt="">' : "") +
        '<a href="' + path + '/download">' + escapeHtml(file.filename) + '</a>' +
        (file.textRecognition && file.mime.startsWith("image/") ? button("Read screenshot text", "read-screenshot", file.parent + "|" + file.id, "small") : "") + '</div>';
    }).join("") || '<p class="muted">No attached files.</p>';
  } catch (error) { container.textContent = error.message; }
}

async function readScreenshot(id) {
  const [parent, fileId] = id.split("|");
  const place = getPlace(relatedTarget.id);
  try {
    const result = await fileRequest(attachmentPath(parent) + "/" + fileId + "/extract", { method: "POST",
      headers: { "X-DCC-Attachment": "1" } });
    showDialog("Review screenshot text", '<p class="callout">Inferred from the screenshot. Verify the place name and any details before saving.</p>' +
      '<p class="source-break">' + escapeHtml(result.text).replaceAll("\n", "<br>") + '</p>' +
      button("Use suggested name", "ocr-name", "", "primary"));
    dialog.querySelector('[data-action="ocr-name"]').onclick = () => captureForm(place, { detectedName: result.suggestion });
  } catch (error) { say(error.message); }
}

function loadCovers() {
  const candidates = shownPlaces().filter(place => (place.hasAttachments || place.attachmentSources.length) && !covers.has(place.id)).slice(0, 12);
  for (const place of candidates) {
    covers.set(place.id, "");
    const id = place.hasAttachments ? place.id : place.attachmentSources[0];
    fileRequest(attachmentPath(id)).then(({ files }) => {
      const cover = files.find(file => !file.removed && !file.pending && file.mime.startsWith("image/"));
      if (cover) {
        covers.set(place.id, attachmentPath(id) + "/" + cover.id + "/preview");
        if (section === "places" && libraryView === "gallery") render();
      }
    }).catch(() => {});
  }
}

function linksMarkup(links, context = "place") {
  if (!links?.length) return "";
  return '<ul class="place-sources">' + links.map(item => {
    const target = item.type === "task" ? "/?researchTask=" : item.type === "research" ? "/research?id=" : "/wishlists?id=";
    return '<li><a href="' + target + encodeURIComponent(item.id) + '">Open ' + escapeHtml(item.type) + '</a> ' +
      button("Unlink", "unlink", context + "|" + item.type + "|" + item.id, "small") + '</li>';
  }).join("") + '</ul>';
}

function openDetails(place) {
  const trips = data.trips.filter(trip => trip.days.some(day => day.stops.some(stop => stop.placeId === place.id)));
  const parents = place.parents.map(getPlace).filter(Boolean);
  const duplicate = data.places.find(other => other.id !== place.id &&
    (other.name.toLowerCase() === place.name.toLowerCase() || other.sources.some(source => place.sources.some(saved => source.url === saved.url))));
  const directions = pointOf(place) || place.address;
  const destination = Array.isArray(directions) ? [directions[1], directions[0]].join(",") : directions;
  const details = [place.region, place.address, place.season && "Season: " + place.season,
    place.hours && "Hours: " + place.hours, place.duration && place.duration + " min estimated",
    place.cost != null && new Intl.NumberFormat("en", { style: "currency", currency: place.currency }).format(place.cost) + " estimated",
    place.accessibility && "Accessibility: " + place.accessibility].filter(Boolean);
  relatedTarget = { kind: "place", id: place.id };
  showDialog(place.name, '<div class="row">' + badge(place.category) + badge(geoLabel(place), pointOf(place) ? "neutral" : "warn") +
    badge(place.priority + " priority", "neutral") + (place.archived ? badge("Archived", "neutral") : "") +
    '</div><p class="muted">' + escapeHtml(details.join(" · ") || "Location unresolved") + '</p>' +
    (place.description ? '<p>' + escapeHtml(place.description) + '</p>' : '') +
    (place.notes ? '<p>' + escapeHtml(place.notes) + '</p>' : '') +
    (place.originalText ? '<p class="callout">' + escapeHtml(place.originalText) + '</p>' : '') +
    '<p class="muted">Saved ' + escapeHtml(new Date(place.createdAt).toLocaleDateString()) +
    (place.tags.length ? ' · ' + escapeHtml(place.tags.join(", ")) : '') +
    (place.companions.length ? ' · With ' + escapeHtml(place.companions.join(", ")) : '') + '</p>' +
    (destination ? '<p>' + link("https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(destination), "Open directions") + '</p>' : '') +
    (parents.length ? '<div class="row"><span>Within</span>' + parents.map(parent => button(parent.name, "details", parent.id, "small")).join("") + '</div>' : '') +
    (place.sources.length ? '<section><h3>Sources</h3><ul class="place-sources">' + place.sources.map(source =>
      '<li>' + link(source.url, source.label || source.url) + ' · ' + escapeHtml(source.kind) +
      (source.observedAt ? ' · ' + escapeHtml(source.observedAt) : '') + '</li>').join("") + '</ul></section>' : '') +
    (place.evidence.length ? '<section><h3>Evidence</h3><ul class="place-sources">' + place.evidence.map(entry =>
      '<li>' + escapeHtml(entry.field + " · " + entry.status + (entry.observedAt ? " · " + entry.observedAt : "")) +
      (entry.source ? ' · ' + link(entry.source, "Source") : '') + '</li>').join("") + '</ul></section>' : '') +
    (place.visits.length ? '<section><h3>Visits</h3><ul class="place-sources">' + place.visits.map(visit =>
      '<li>' + escapeHtml(visit.date + (visit.notes ? " · " + visit.notes : "")) + '</li>').join("") + '</ul></section>' : '') +
    (trips.length ? '<div class="row"><span>Used in</span>' + trips.map(trip => button(trip.name + " · " + trip.version, "open-linked-trip", trip.id, "small")).join("") + '</div>' : '') +
    '<section><h3>Related records</h3>' + linksMarkup(place.links) + button("Link existing record", "related", "place|" + place.id, "small") + '</section>' +
    '<section><h3>Files</h3><div id="place-attachments" class="stack"><p class="muted">Loading files…</p></div></section>' +
    (duplicate ? '<div class="callout warning">Possible duplicate · ' + escapeHtml(duplicate.name) + ' ' +
      button("Review merge", "merge", place.id + "|" + duplicate.id, "small") + '</div>' : '') +
    '<div class="row">' + button("Edit place", "edit-place", place.id, "primary") + button("Plan from this place", "new-trip-place", place.id) +
    (getTrip() ? button("Add to current trip", "add-detail-stop", place.id) : '') +
    button("Record visit", "visit", place.id) + button("Add task", "prep-task", "place|" + place.id) + '</div>');
  showFiles(place, dialog.querySelector("#place-attachments"));
}

function captureForm(place = null, values = {}) {
  const point = values.point || place?.geometries.find(item => item.shape.type === "Point")?.shape.coordinates;
  const record = place || values;
  const options = data.places.filter(candidate => candidate.id !== place?.id)
    .map(candidate => [candidate.id, candidate.name]);
  showDialog(place ? "Edit place" : "Save a place", '<form id="capture-form" class="stack"><div class="form-grid">' +
    field("name", "Place name", '<input id="name" name="name" required maxlength="160" value="' + escapeHtml(values.detectedName || record.name) + '">', true) +
    field("url", place ? "Add a source URL" : "Original link", '<input id="url" name="url" type="url" maxlength="2048" value="' + escapeHtml(values.url) + '">', true) +
    field("source-kind", "Source type", '<select id="source-kind" name="sourceKind">' + opts([["discovery", "Discovery"], ["official", "Official"], ["evidence", "Evidence"]], "discovery") + '</select>') +
    field("source-observed", "Source observation date", '<input id="source-observed" type="date" name="observedAt">') +
    field("capture-region", "Location text", '<input id="capture-region" name="region" maxlength="160" value="' + escapeHtml(record.region) + '">') +
    field("capture-category", "Category", '<select id="capture-category" name="category">' + opts(categories, record.category || "Other") + '</select>') +
    field("capture-notes", "Personal notes", '<textarea id="capture-notes" name="notes" rows="2" maxlength="3000">' + escapeHtml(record.notes) + '</textarea>', true) +
    field("capture-image", "Screenshot or photo", '<input type="file" id="capture-image" accept="image/png,image/jpeg,image/webp">', true) +
    '</div><details' + (point ? ' open' : '') + '><summary>Location, collections and details</summary><div class="form-grid">' +
    field("place-address", "Address", '<input id="place-address" name="address" maxlength="240" value="' + escapeHtml(record.address) + '">', true) +
    field("longitude", "Longitude", '<input id="longitude" name="lon" type="number" min="-180" max="180" step="any" value="' + escapeHtml(point?.[0]) + '">') +
    field("latitude", "Latitude", '<input id="latitude" name="lat" type="number" min="-90" max="90" step="any" value="' + escapeHtml(point?.[1]) + '">') +
    field("exactness", "Coordinate accuracy", '<select id="exactness" name="accuracy">' + opts([["approximate", "Approximate"], ["exact", "Exact"]], place?.geometries.find(item => item.shape.type === "Point")?.kind || "approximate") + '</select>') +
    field("parent-place", "Add parent place", '<select id="parent-place" name="parent">' + opts([["", "No additional parent"], ...options], "") + '</select>') +
    field("geometry", "Additional GeoJSON geometry", '<textarea id="geometry" name="geojson" rows="2" maxlength="60000" placeholder="LineString, Polygon or MultiPoint"></textarea>', true) +
    field("collections", "Collections, separated by commas", '<input id="collections" name="collections" value="' + escapeHtml(record.collections?.join(", ")) + '">') +
    field("place-tags", "Tags, separated by commas", '<input id="place-tags" name="tags" value="' + escapeHtml(record.tags?.join(", ")) + '">') +
    field("place-companions", "Companions, separated by commas", '<input id="place-companions" name="companions" value="' + escapeHtml(record.companions?.join(", ")) + '">') +
    field("place-priority", "Priority", '<select id="place-priority" name="priority">' + opts(["Low", "Normal", "High"], record.priority || "Normal") + '</select>') +
    field("place-duration", "Estimated visit duration (minutes)", '<input id="place-duration" name="duration" type="number" min="1" max="1440" value="' + escapeHtml(record.duration) + '">') +
    field("place-hours", "Hours", '<input id="place-hours" name="hours" maxlength="300" value="' + escapeHtml(record.hours) + '">') +
    field("place-availability", "Date-specific availability", '<textarea id="place-availability" name="availability" rows="3" maxlength="5000" placeholder="2027-10-04 closed&#10;2027-10-05 09:00–17:00">' +
      escapeHtml((record.availability || []).map(item => item.date + (item.kind === "closed" ? " closed" : " " + item.open + "–" + item.close)).join("\n")) + '</textarea>', true) +
    field("place-season", "Seasonal availability", '<input id="place-season" name="season" maxlength="160" value="' + escapeHtml(record.season) + '">') +
    field("place-access", "Accessibility", '<input id="place-access" name="accessibility" maxlength="300" value="' + escapeHtml(record.accessibility) + '">') +
    field("place-cost", "Estimated cost", '<input id="place-cost" name="cost" type="number" min="0" max="100000000" step="any" value="' + escapeHtml(record.cost) + '">') +
    field("place-currency", "Currency", '<select id="place-currency" name="currency">' + opts(["JPY", "USD", "COP", "EUR", "GBP", "CAD", "AUD", "MXN", "KRW", "NZD", "THB"], record.currency || "USD") + '</select>') +
    field("place-description", "Description", '<textarea id="place-description" name="description" maxlength="3000">' + escapeHtml(record.description) + '</textarea>', true) +
    field("place-original", "Original text", '<textarea id="place-original" name="originalText" maxlength="5000">' + escapeHtml(record.originalText) + '</textarea>', true) +
    '<div class="row field-wide"><label><input type="checkbox" name="favorite"' + (record.favorite ? " checked" : "") + '> Favorite</label>' +
    '<label><input type="checkbox" name="archived"' + (record.archived ? " checked" : "") + '> Archived</label></div></div></details>' +
    '<input type="hidden" name="placeId" value="' + escapeHtml(place?.id) + '"><input type="hidden" name="detectedName" value="' +
    escapeHtml(values.detectedName) + '"><p class="muted small-text">Save now and confirm the location later. Added details are user-supplied.</p>' +
    '<p class="form-error error-text" role="alert"></p><div class="row"><button type="submit" class="primary">' + (place ? "Save changes" : "Save discovery") +
    '</button></div></form>');
}

function availabilityValues(raw) {
  return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const match = /^(\d{4}-\d{2}-\d{2}) (?:closed|(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2}))$/i.exec(line);
    if (!match) throw new Error("Enter one line per date, for example 2027-10-04 closed or 2027-10-05 09:00–17:00.");
    const [, date, open, close] = match;
    return open ? { date, kind: "window", open, close } : { date, kind: "closed" };
  });
}

function listValues(value) {
  return [...new Set(String(value || "").split(",").map(item => item.trim()).filter(Boolean))];
}

function coordsFromUrl(value) {
  const url = new URL(value);
  if (!/^(?:www\.|maps\.)?google\.[a-z.]+$/i.test(url.hostname) && !/^(www\.)?openstreetmap\.org$/i.test(url.hostname)) return;
  const match = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname) ||
    /#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(url.hash);
  if (!match) return;
  const [, lat, lon] = match.map(Number);
  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lon, lat];
}

function sourceOnly(value) {
  const parsed = new URL(value);
  const point = coordsFromUrl(value);
  return {
    name: "Discovery from " + parsed.hostname.slice(0, 120), sources: [{ url: value, kind: "discovery" }],
    ...(point ? { geometries: [{ kind: "approximate", shape: { type: "Point", coordinates: point }, source: value }] } : {})
  };
}

function ensureFile(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024)
    throw new Error("Choose a PNG, JPEG or WebP up to 10 MiB.");
}

function persistPlace(value, place = null, file) {
  const id = place?.id || uid();
  if (!place) {
    search = "";
    category = "";
    locationFilter = "";
    collection = "All saved";
  }
  const command = { action: place ? "place-save" : "place-create", id, revision: place?.revision, value };
  return runCommand(command, "Saved " + value.name + ".", {
    after: file ? async () => {
      const uploadId = uid();
      async function send() {
        try {
          await uploadImage(id, file, uploadId);
          closeDialog();
          say("Screenshot saved.");
        } catch (error) {
          showDialog("Place saved", '<p class="error-text">' + escapeHtml(error.message) + '</p>' +
            button("Retry screenshot upload", "retry-upload", "", "primary"));
          dialog.querySelector('[data-action="retry-upload"]').onclick = send;
        }
      }
      await send();
    } : undefined
  });
}

function newTripForm(ids = []) {
  showDialog("New undated trip", '<form id="new-trip-form" class="stack"><div class="form-grid">' +
    field("trip-name", "Trip name", '<input id="trip-name" name="name" required maxlength="120" placeholder="Northern Japan in autumn">', true) +
    field("trip-days", "Days", '<input id="trip-days" name="days" type="number" min="1" max="62" value="3" required>') +
    field("trip-zone", "Destination timezone", '<select id="trip-zone" name="zone">' +
      opts([...new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, ...zoneList])], Intl.DateTimeFormat().resolvedOptions().timeZone) + '</select>') +
    field("trip-season", "Preferred season or month", '<input id="trip-season" name="season" maxlength="50" placeholder="Optional">', true) +
    field("trip-destination", "Destination", '<input id="trip-destination" name="destination" maxlength="160" placeholder="Optional">', true) +
    '</div>' + (ids.length ? '<p class="callout">Day 1 starts with ' + escapeHtml(ids.map(id => getPlace(id)?.name).filter(Boolean).join(", ")) + '.</p>' : '') +
    '<input type="hidden" name="places" value="' + escapeHtml(ids.join(",")) + '"><div class="row"><button class="primary" type="submit">Create undated trip</button></div></form>');
}

function activate(id, view = "timeline") {
  data.active = id;
  activeDay = 0;
  section = "trips";
  editorView = view;
  viewport = { ...defaultViewport };
}

function tripSettings(trip) {
  showDialog("Trip settings", '<form id="trip-settings-form" class="stack"><div class="form-grid">' +
    field("edit-trip-name", "Trip name", '<input id="edit-trip-name" name="name" required maxlength="120" value="' + escapeHtml(trip.name) + '">', true) +
    field("trip-status", "Lifecycle status", '<select id="trip-status" name="status">' + opts(lifecycle, trip.status) + '</select>') +
    field("edit-season", "Preferred season", '<input id="edit-season" name="season" maxlength="50" value="' + escapeHtml(trip.season) + '">') +
    field("transport-mode", "Transport mode", '<select id="transport-mode" name="transport">' + opts(transport, trip.transport) + '</select>') +
    field("buffer", "Transfer buffer (%)", '<input id="buffer" name="buffer" type="number" min="0" max="100" required value="' + trip.buffer + '">') +
    field("trip-budget", "Estimated trip cost (optional)", '<input id="trip-budget" name="budget" type="number" min="0" max="100000000" step="any" value="' + escapeHtml(trip.budget) + '">') +
    field("trip-currency", "Currency", '<select id="trip-currency" name="currency">' + opts(["JPY", "USD", "COP", "EUR", "GBP", "CAD", "AUD"], trip.currency) + '</select>') +
    field("trip-days-edit", "Number of days", '<input id="trip-days-edit" name="dayCount" type="number" required min="1" max="62" value="' + trip.days.length + '">') +
    field("trip-companions", "Companions, separated by commas", '<input id="trip-companions" name="companions" value="' + escapeHtml(trip.companions.join(", ")) + '">') +
    field("trip-notes", "Trip notes", '<textarea id="trip-notes" name="notes" rows="3" maxlength="1800">' + escapeHtml(trip.notes) + '</textarea>', true) +
    '</div><div class="row"><button type="submit" class="primary">Save settings</button></div></form>');
}

function editStop(trip, id, targetDay) {
  const item = id ? findStop(trip, id) : null;
  const stop = item?.stop;
  const dayIndex = stop ? trip.days.indexOf(item.day) : targetDay;
  const options = trip.days.map((_, index) => [String(index), "Day " + (index + 1)]);
  showDialog(stop ? label(stop) : "Add activity", '<form id="edit-stop-form" class="stack"><div class="form-grid">' +
    (stop?.placeId ? "" : field("activity-title", "Activity", '<input id="activity-title" name="title" required maxlength="120" value="' + escapeHtml(stop?.title) + '" placeholder="Lunch, train transfer or place to stay">', true)) +
    field("stop-day", "Relative day", '<select id="stop-day" name="day"' + (stop?.locked ? " disabled" : "") + '>' + opts(options, String(dayIndex)) + '</select>') +
    field("stop-period", "Part of day", '<select id="stop-period" name="period">' + opts(periods, stop?.period || "Morning") + '</select>') +
    field("stop-time", "Local start (optional)", '<input id="stop-time" name="time" type="time" value="' + escapeHtml(stop?.time) + '">') +
    field("stop-duration", "Duration in minutes", '<input id="stop-duration" name="duration" type="number" min="1" max="1440" value="' + escapeHtml(stop?.duration) + '">') +
    field("stop-transfer", "Transfer from previous stop (minutes)", '<input id="stop-transfer" name="transfer" type="number" min="0" max="1440" value="' + escapeHtml(stop?.transferMinutes) + '">') +
    field("stop-cost", "Estimated cost in " + trip.currency, '<input id="stop-cost" name="cost" type="number" min="0" step="any" value="' + escapeHtml(stop?.cost) + '">') +
    field("stop-zone", "Stop timezone override", '<select id="stop-zone" name="zone">' + opts([["", "Use trip timezone"], ...zoneList], stop?.zone || "") + '</select>') +
    '<details class="field-wide"><summary>DST offsets for a repeated hour</summary><div class="form-grid">' +
    field("stop-start-offset", "Start UTC offset", '<input id="stop-start-offset" name="startOffset" placeholder="+09:00" value="' + escapeHtml(stop?.startOffset) + '">') +
    field("stop-end-offset", "End UTC offset", '<input id="stop-end-offset" name="endOffset" placeholder="+09:00" value="' + escapeHtml(stop?.endOffset) + '">') + '</div></details>' +
    field("stop-notes", "Notes", '<textarea id="stop-notes" name="notes" rows="2" maxlength="1000">' + escapeHtml(stop?.notes) + '</textarea>', true) +
    '</div><div class="row"><label><input type="checkbox" name="optional"' + (stop?.optional ? " checked" : "") + '> Optional stop</label>' +
    '<label><input type="checkbox" name="locked"' + (stop?.locked ? " checked" : "") + '> Lock order</label></div>' +
    '<input type="hidden" name="stopId" value="' + escapeHtml(id) + '"><div class="row"><button type="submit" class="primary">Save activity</button>' +
    (stop ? button("Remove", "remove-stop", id) : '') + '</div></form>');
}

function addPlaceStop(id, trip) {
  const place = getPlace(id);
  if (!place) return;
  const stop = makeStop(id, place.category === "Food & drink" ? "Evening" : "Morning");
  trip.days[activeDay].stops.push(stop);
  updated("Added " + place.name + " to Day " + (activeDay + 1) + ".");
}

function moveStop(trip, id, nextDay, beforeId) {
  const item = findStop(trip, id);
  if (!item || item.stop.locked || id === beforeId) return false;
  const { day, stop } = item;
  const destination = trip.days[nextDay];
  const before = beforeId && destination.stops.find(row => row.id === beforeId);
  if (before?.locked) return false;
  const from = day.stops.indexOf(stop);
  const destinationIndex = before ? destination.stops.indexOf(before) : destination.stops.length;
  const crossesLock = day === destination && day.stops.slice(Math.min(from, destinationIndex), Math.max(from, destinationIndex))
    .some(row => row.locked);
  if (crossesLock) return false;
  day.stops.splice(from, 1);
  const to = before ? destination.stops.indexOf(before) : destination.stops.length;
  destination.stops.splice(to, 0, stop);
  return true;
}

let relatedTarget;

function summarizeTrip(item) {
  const stops = item.days.flatMap(day => day.stops);
  const legs = stops.slice(1).filter((stop, i) => pointOf(getPlace(stop.placeId)) && pointOf(getPlace(stops[i].placeId))).length;
  const durations = stops.map(stop => stop.duration ?? getPlace(stop.placeId)?.duration).filter(Number.isFinite);
  const transfers = stops.map(stop => stop.transferMinutes).filter(Number.isFinite);
  const travel = transfers.reduce((sum, minutes) => sum + Math.ceil(minutes * (1 + item.buffer / 100)), 0);
  const costs = stops.map(stop => stop.cost ?? (getPlace(stop.placeId)?.currency === item.currency ? getPlace(stop.placeId)?.cost : null)).filter(Number.isFinite);
  return '<div class="pane stack"><h3>' + escapeHtml(item.version) + '</h3><dl><div><dt>Duration</dt><dd>' + item.days.length + ' days' +
    (durations.length ? ' · ' + durations.reduce((sum, minutes) => sum + minutes, 0) + ' min of entered activities' : '') + '</dd></div>' +
    '<div><dt>Budget estimate</dt><dd>' + escapeHtml(budgetLabel(item)) + (costs.length ? ' · ' + costs.reduce((sum, cost) => sum + cost, 0) + ' ' + item.currency + ' in entered stops' : '') +
    '</dd></div><div><dt>Travel burden</dt><dd>' + (transfers.length ? travel + ' min entered transfers with buffer · ' : '') +
    legs + ' mapped connections · live route time unavailable</dd></div><div><dt>Stops</dt><dd>' +
    (stops.map(label).map(escapeHtml).join(", ") || "No stops") +
    '</dd></div><div><dt>Transfer buffer</dt><dd>' + item.buffer + '%</dd></div></dl></div>';
}

async function comparison(trip, candidate = "relaxed") {
  const siblings = data.trips.filter(item => item !== trip && item.family === trip.family);
  let proposal = siblings.find(item => item.id === candidate);
  const strategy = proposal ? "" : candidate;
  let error = "";
  if (strategy) {
    try { proposal = await api("/trips/" + trip.id + "/proposal?strategy=" + encodeURIComponent(strategy)); }
    catch (failure) { error = failure.message; }
  }
  const description = {
    relaxed: "Removes unlocked optional stops and frees unlocked start times.",
    shorter: "Removes the last day only when it has no notes, required stops or locked stops.",
    nearby: "Groups nearby saved places by straight-line distance. Keeps locked and timed stops in place.",
    budget: "Drops unlocked optional stops with an entered positive cost. Keeps costs that need research visible.",
    outdoors: "Keeps outdoors activities and required stops. Removes other unlocked optional places.",
    food: "Keeps food stops and required stops. Removes other unlocked optional places."
  };
  showDialog("Compare itinerary versions", field("compare-version", "Compare against", '<select id="compare-version">' +
    opts([["relaxed", "New relaxed proposal"], ["shorter", "New shorter proposal"], ["nearby", "New nearby-stops proposal"], ["budget", "New budget proposal"], ["outdoors", "New outdoors proposal"], ["food", "New food proposal"],
      ...siblings.map(item => [item.id, item.version])], candidate) + '</select>') +
    '<form id="refine-form" class="row"><input name="request" aria-label="Describe an alternative" placeholder="Make it shorter or more relaxed" required maxlength="240">' +
    '<button type="submit">Preview suggestion</button></form>' +
    (strategy ? '<p class="muted">' + escapeHtml(description[strategy]) + '</p>' : '') +
    (error ? '<p class="error-text" role="alert">' + escapeHtml(error) + '</p>' : '') +
    '<div class="compare-grid">' + summarizeTrip(trip) + (proposal ? summarizeTrip(proposal) : '') + '</div>' +
    (strategy && proposal ? '<div class="row">' + button("Save as separate version", "save-alternative", "", "primary") + '</div>' : ''));
  if (strategy && proposal) dialog.querySelector('[data-action="save-alternative"]').onclick = () => runCommand({
    action: "trip-copy", id: trip.id, revision: proposal.originalRevision, version: proposal.version, strategy
  }, "Saved a separate itinerary version.", { activateResult: true });
}

function scheduleForm(trip) {
  showDialog("Schedule this trip", '<form id="schedule-form" class="stack">' +
    field("start-date", "Day 1 start date", '<input id="start-date" name="date" type="date" min="1900-01-01" max="9998-12-01" required value="' + escapeHtml(trip.start) + '">') +
    '<div class="stack"><label><input type="radio" name="mode" value="copy" checked> Create scheduled copy</label>' +
    '<label><input type="radio" name="mode" value="original"> Convert original</label></div><p class="muted">Stop order, notes and place links carry over. Dates use ' +
    escapeHtml(trip.zone) + '.</p><div class="row"><button class="primary" type="submit">Preview dated itinerary</button></div></form>');
}

async function schedulePreview(trip, date, mode) {
  let result;
  try { result = await api("/trips/" + trip.id + "/preview?date=" + encodeURIComponent(date)); }
  catch (error) { say(error.message); return; }
  if (trip.revision !== result.originalRevision) {
    say("The trip changed. Reload Places before scheduling.");
    return;
  }
  const dated = mode === "publish";
  showDialog(dated ? "DCC scheduling preview" : "Review your dated itinerary", '<div class="row">' +
    badge(result.tripZone) + badge("DCC calendar: " + result.appZone, "neutral") +
    '</div><p class="muted">' + (dated ? "Choose the activities you want to publish to DCC Itinerary and Calendar." :
      "Saving dates preserves the stop order, notes and linked places.") + '</p>' +
    '<form id="publish-form" class="stack">' + result.days.map((day, index) => '<div class="pane stack"><h3>Day ' + (index + 1) + ' · ' +
      prettyDate(day.date) + '</h3>' + (day.stops.map(stop => '<div>' +
        (dated && stop.plan && !stop.issues.length
          ? '<label><input type="checkbox" name="stops" value="' + stop.id + '"> ' + escapeHtml(stop.title) + '</label>'
          : '<strong>' + escapeHtml(stop.title) + '</strong>') +
        (stop.time ? '<span class="muted"> · ' + escapeHtml(stop.time + " " + (stop.zone || result.tripZone)) + '</span>' : '') +
        (stop.plan ? '<p class="muted small-text">DCC · ' + stop.plan.date + ' ' + stop.plan.properties.start + '–' + stop.plan.properties.end + '</p>' : '') +
        (stop.issues.length ? '<ul class="schedule-list error-text">' + stop.issues.map(issue => '<li>' + escapeHtml(issue) + '</li>').join("") + '</ul>' : '') +
        (stop.checks.length ? '<p class="muted small-text">' + escapeHtml(stop.checks.join(" · ")) + '</p>' : '') + '</div>').join("") ||
        '<p class="muted">Open day</p>') + '</div>').join("") +
    (dated && result.orphaned.length ? '<section class="callout stack"><h3>Activities removed from this trip</h3>' +
      result.orphaned.map(item => item.canRemove ? '<label><input type="checkbox" name="removed" value="' + item.id + '"> ' + escapeHtml(item.title) + '</label>' :
        '<p>' + escapeHtml(item.title) + ' · Review in DCC</p>').join("") +
      button("Remove selected from DCC", "unpublish") + '</section>' : '') +
    '<div class="row">' + (dated ? '<button type="submit" class="primary">Publish selected activities</button>' +
      button("Download calendar file", "export-calendar") + button("Add prep task", "prep-task", trip.id) :
      button(mode === "copy" ? "Save scheduled copy" : "Confirm conversion", "confirm-schedule", "", "primary") +
      button("Change dates or copy choice", "schedule")) + '</div></form>');
  if (dated) {
    dialog.querySelector("#publish-form").onsubmit = event => {
      event.preventDefault();
      const ids = new FormData(event.currentTarget).getAll("stops");
      if (!ids.length) return say("Select at least one eligible activity.");
      runCommand({ action: "trip-publish", id: trip.id, revision: trip.revision, approval: result.approval, stopIds: ids },
        "Published the selected activities to DCC.");
    };
    const remove = dialog.querySelector('[data-action="unpublish"]');
    if (remove) remove.onclick = () => {
      const ids = new FormData(dialog.querySelector("#publish-form")).getAll("removed");
      if (!ids.length) return say("Select at least one unchanged activity to remove.");
      showDialog("Remove activities from DCC", '<p>Remove the selected activities from DCC Itinerary and Calendar?</p>' +
        button("Confirm removal", "confirm-unpublish", "", "primary"));
      dialog.querySelector('[data-action="confirm-unpublish"]').onclick = () => runCommand({
        action: "trip-unpublish", id: trip.id, revision: trip.revision, approval: result.approval, stopIds: ids
      }, "Removed the selected DCC activities.");
    };
    dialog.querySelector('[data-action="export-calendar"]').onclick = () => exportCalendar(trip, result);
  } else {
    dialog.querySelector('[data-action="confirm-schedule"]').onclick = () => runCommand({
      action: "trip-date", id: trip.id, revision: result.originalRevision, date, asCopy: mode === "copy"
    }, mode === "copy" ? "Saved a dated copy. The original is still undated." : "Saved the dated trip.", { activateResult: true });
  }
}

function exportCalendar(trip, result) {
  const selected = new Set(new FormData(dialog.querySelector("#publish-form")).getAll("stops"));
  const events = result.days.flatMap(day => day.stops).filter(stop => stop.plan && !stop.issues.length && selected.has(stop.id));
  if (!events.length) { say("Select activities to include in the calendar file."); return; }
  const icsText = text => text.replace(/[\\;,\r\n]/g, char => char === "\r" ? "" : char === "\n" ? "\\n" : "\\" + char);
  const timestamp = date => date.replace(/[:-]|\.\d{3}/g, "");
  const stamp = timestamp(new Date().toISOString());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Daily Command Center//Places//EN", "CALSCALE:GREGORIAN"];
  for (const stop of events) {
    lines.push("BEGIN:VEVENT", "UID:" + trip.id + "-" + stop.id + "@daily-command-center", "DTSTAMP:" + stamp,
      "DTSTART:" + timestamp(stop.plan.properties.scheduleInstant.startAt),
      "DTEND:" + timestamp(stop.plan.properties.scheduleInstant.endAt),
      "SUMMARY:" + icsText(stop.title), "DESCRIPTION:" + icsText(stop.notes || ""), "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
  const download = document.createElement("a");
  download.href = url;
  download.download = "dcc-trip.ics";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function pointForm() {
  const [lon, lat] = nearby || [];
  showDialog("Set an origin", '<form id="nearby-form" class="stack"><div class="form-grid">' +
    field("origin-lon", "Longitude", '<input id="origin-lon" name="longitude" type="number" min="-180" max="180" step="any" required value="' + escapeHtml(lon) + '">') +
    field("origin-lat", "Latitude", '<input id="origin-lat" name="latitude" type="number" min="-90" max="90" step="any" required value="' + escapeHtml(lat) + '">') +
    '</div><button type="submit" class="primary">Find nearby places</button></form>');
}

function setNearby(coords) {
  nearby = coords;
  viewport = { center: coords, scale: 800 };
  closeDialog();
  render();
}

function visitForm(id) {
  showDialog("Record a visit", '<form id="visit-form" class="stack">' +
    field("visit-date", "Visit date", '<input id="visit-date" name="date" type="date" required value="' + new Date().toLocaleDateString("sv-SE") + '">') +
    field("visit-notes", "Visit notes", '<textarea id="visit-notes" name="notes" maxlength="3000"></textarea>') +
    '<input type="hidden" name="placeId" value="' + id + '"><button type="submit" class="primary">Save visit</button></form>');
}

function prepTaskForm(rawId) {
  const [kind, id] = rawId.includes("|") ? rawId.split("|") : ["trip", rawId];
  showDialog("Create linked task", '<form id="prep-task-form" class="stack">' +
    field("task-title", "Task title", '<input id="task-title" name="title" required maxlength="160" placeholder="Confirm opening hours">') +
    field("task-date", "DCC date (optional)", '<input id="task-date" name="date" type="date">') +
    '<input type="hidden" name="recordId" value="' + id + '"><input type="hidden" name="kind" value="' + kind + '">' +
    '<p class="muted">A task with a date will appear as unplanned time.</p><button type="submit" class="primary">Create task</button></form>');
}

function collectForm() {
  showDialog("Add selected places to a collection", '<form class="stack" id="collect-form">' +
    field("collection-name", "Collection name", '<input id="collection-name" name="name" required maxlength="80" list="known-collections"><datalist id="known-collections">' +
      opts([...new Set(data.places.flatMap(place => place.collections))], "") + '</datalist>') +
    '<button type="submit" class="primary">Add to collection</button></form>');
}

function relatedForm(kind, id) {
  relatedTarget = { kind, id };
  showDialog(kind === "import" ? "Import a DCC discovery" : "Link existing DCC record", '<form id="related-form" class="row">' +
    '<input name="query" aria-label="Search tasks, Research and Wishlists" required maxlength="120"><button class="primary" type="submit">Search</button></form>' +
    '<div class="stack" id="related-results"></div>');
}

function mergeForm(id, sourceId) {
  const place = getPlace(id), source = getPlace(sourceId);
  showDialog("Merge duplicate places", '<p>Keep <strong>' + escapeHtml(place.name) + '</strong> and move the sources, files, notes and trip references from <strong>' +
    escapeHtml(source.name) + '</strong>.</p>' + button("Merge places", "confirm-merge", "", "primary"));
  dialog.querySelector('[data-action="confirm-merge"]').onclick = () => runCommand({
    action: "place-merge", id, revision: place.revision, sourceId, sourceRevision: source.revision
  }, "Merged the saved places.");
}

async function reloadRecords() {
  if (busy) return;
  try { await refresh(); closeDialog(); render(); }
  catch (error) { showDialog("Places unavailable", '<p class="error-text">' + escapeHtml(error.message) + '</p>' + button("Retry", "reload", "", "primary")); }
}

function toggleSelection(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
  say(selected.size ? selected.size + " places selected." : "Selection cleared.");
}

function openDayNotes(index) {
  showDialog("Day " + (index + 1) + " notes", '<form id="day-notes-form" class="stack">' +
    field("day-note", "Notes", '<textarea id="day-note" name="notes" rows="3" maxlength="1000">' + escapeHtml(getTrip().days[index].notes) + '</textarea>') +
    '<input type="hidden" name="day" value="' + index + '"><div class="row"><button class="primary" type="submit">Save day notes</button></div></form>');
}

function mapAction(action) {
  const map = document.getElementById("map-surface");
  if (!map) return;
  if (action === "map-fit") { fitMap(); return; }
  if (action === "zoom-in") viewport = { ...viewport, scale: Math.min(8000, viewport.scale * 1.6) };
  if (action === "zoom-out") viewport = { ...viewport, scale: Math.max(15, viewport.scale / 1.6) };
  const shift = { "map-west": [-1, 0], "map-east": [1, 0], "map-north": [0, 1], "map-south": [0, -1] }[action];
  if (shift) viewport = { ...viewport, center: viewport.center.map((value, i) => value + shift[i] * 120 / viewport.scale) };
  paintMap(map);
}

document.addEventListener("click", event => {
  const control = event.target.closest("button[data-action]");
  if (!control || control.disabled || busy) return;
  const { action, id } = control.dataset;
  const trip = getTrip();
  const fromDialog = dialog.contains(control);
  switch (action) {
    case "section":
      section = id;
      viewport = nearby ? { center: nearby, scale: 800 } : { ...defaultViewport };
      render();
      break;
    case "library-view":
      libraryView = id;
      render();
      break;
    case "collection":
      collection = id;
      render();
      break;
    case "capture":
      captureForm(null, { name: document.getElementById("quick-value")?.value || "" });
      break;
    case "share-settings":
      showDialog("Mobile share destination", '<p>Choose where the installed DCC app saves new shares on this device.</p>' +
        '<form class="stack" id="share-settings-form"><label><input type="checkbox" name="enabled"' + (data.shareToPlaces ? " checked" : "") +
        '> Send new shares to Places</label><p class="muted">When cleared, shared links and images go to the Vault inbox.</p>' +
        '<button type="submit" class="primary">Save destination</button></form>');
      break;
    case "collect":
      collectForm();
      break;
    case "import-record":
      relatedForm("import", "");
      break;
    case "read-screenshot":
      readScreenshot(id);
      break;
    case "apply-route": {
      if (!routePreview || routePreview.tripId !== trip.id || routePreview.revision !== trip.revision) break;
      routePreview.stopIds.slice(1).forEach((stopId, i) => {
        const item = findStop(trip, stopId);
        if (item && !item.stop.locked) {
          item.stop.transferMinutes = Math.ceil(routePreview.segments[i].duration / 60);
          item.stop.transferEvidence = { provider: routePreview.provider, mode: routePreview.mode, observedAt: routePreview.observedAt };
        }
      });
      trip.transport = routePreview.mode;
      updated("Saved provider transfer times for unlocked stops.");
      break;
    }
    case "edit-place":
      captureForm(getPlace(id));
      break;
    case "visit":
      visitForm(id);
      break;
    case "merge":
      mergeForm(...id.split("|"));
      break;
    case "related":
      relatedForm(...id.split("|"));
      break;
    case "link-result":
    case "unlink": {
      const parts = id.split("|");
      const context = action === "unlink" ? parts.shift() : relatedTarget.kind;
      const type = parts.shift(), linkId = parts.join("|");
      if (context === "import") {
        const title = control.closest(".list-row").querySelector("[data-record-title]").textContent;
        persistPlace({ name: title.slice(0, 160), links: [{ type, id: linkId }] });
        break;
      }
      const record = context === "trip" ? getTrip() : getPlace(relatedTarget.id);
      if (action === "unlink") record.links = record.links.filter(link => link.id !== linkId || link.type !== type);
      else if (!record.links.some(link => link.id === linkId && link.type === type)) record.links.push({ type, id: linkId });
      else { say("Already linked."); break; }
      updated(action === "unlink" ? "Removed link." : "Linked the DCC record.");
      break;
    }
    case "prep-task":
      prepTaskForm(id);
      break;
    case "reload":
      reloadRecords();
      break;
    case "retry-save":
      commitPending();
      break;
    case "nearby":
      if (!navigator.geolocation) pointForm();
      else navigator.geolocation.getCurrentPosition(position => setNearby([position.coords.longitude, position.coords.latitude]),
        () => { say("Location unavailable. Enter an origin to continue."); pointForm(); }, { timeout: 8000 });
      break;
    case "nearby-clear":
      nearby = null;
      render();
      break;
    case "nearby-manual":
      pointForm();
      break;
    case "pin-mode":
      placingPin = !placingPin;
      render();
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "details":
      openDetails(getPlace(id));
      break;
    case "select-place":
      if (fromDialog) closeDialog();
      toggleSelection(id);
      break;
    case "clear-selection":
      selected.clear();
      render();
      break;
    case "new-trip":
      newTripForm();
      break;
    case "new-trip-selection":
      newTripForm([...selected]);
      break;
    case "new-trip-place":
      newTripForm([id]);
      break;
    case "open-linked-trip":
      closeDialog();
      // Fall through to the same trip entry point as the trip list.
    case "activate-trip":
      activate(id);
      updated();
      break;
    case "editor-view":
      editorView = id;
      render();
      break;
    case "trip-settings":
      tripSettings(trip);
      break;
    case "day-notes":
      openDayNotes(Number(id));
      break;
    case "new-activity":
      editStop(trip, "", Number(id));
      break;
    case "edit-stop":
      editStop(trip, id);
      break;
    case "remove-stop": {
      const { day, stop } = findStop(trip, id);
      if (stop.locked) {
        say("Unlock the activity before removing it.");
        break;
      }
      day.stops = day.stops.filter(item => item !== stop);
      updated("Removed activity.");
      break;
    }
    case "add-detail-stop":
      activate(trip.id);
      closeDialog();
      addPlaceStop(id, trip);
      break;
    case "add-stop":
      addPlaceStop(id, trip);
      app.querySelector("#active-day")?.focus();
      break;
    case "move-up":
    case "move-down": {
      const item = findStop(trip, id);
      const rows = item.day.stops;
      const from = rows.indexOf(item.stop);
      const next = from + (action === "move-up" ? -1 : 1);
      if (!rows[next] || item.stop.locked || rows[next].locked) break;
      [rows[from], rows[next]] = [rows[next], rows[from]];
      updated("Moved " + label(item.stop) + " to position " + (next + 1) + ".");

      break;
    }
    case "compare":
      comparison(trip);
      break;
    case "duplicate": {
      runCommand({ action: "trip-copy", id: trip.id, revision: trip.revision, version: "Duplicate", strategy: "duplicate" },
        "Duplicated this trip.", { activateResult: true });
      break;
    }
    case "schedule":
      scheduleForm(trip);
      break;
    case "dated-preview":
      schedulePreview(trip, trip.start, "publish");
      break;
    case "zoom-in":
    case "zoom-out":
    case "map-west":
    case "map-east":
    case "map-north":
    case "map-south":
    case "map-fit":
      mapAction(action);
      break;
  }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  if (busy || form.id === "publish-form") return;
  const values = Object.fromEntries(new FormData(form));
  const trip = getTrip();
  const name = values.name?.trim();
  switch (form.id) {
    case "quick-capture": {
      const value = values.value.trim();
      if (!value) return;
      const url = webUrl(value);
      persistPlace(url ? sourceOnly(url) : { name: value.slice(0, 160), originalText: value });
      break;
    }
    case "capture-form": {
      if (!name) return;
      const place = getPlace(values.placeId);
      const url = webUrl(values.url);
      const error = form.querySelector(".form-error");
      let geometries = [...(place?.geometries || [])];
      let availability;
      let point = url ? coordsFromUrl(url) : null;
      const file = form.querySelector("#capture-image").files[0];
      try {
        if (values.url && !url) throw new Error("Enter an HTTP or HTTPS source URL.");
        if (values.lon || values.lat) {
          if (!values.lon || !values.lat) throw new Error("Enter both longitude and latitude.");
          point = [Number(values.lon), Number(values.lat)];
        }
        if (point) {
          const existing = geometries.find(entry => entry.shape.type === "Point");
          if (!(existing && existing.shape.coordinates.every((value, i) => value === point[i]) && existing.kind === values.accuracy)) {
            geometries = [{ kind: values.accuracy, shape: { type: "Point", coordinates: point },
              ...(!values.lon && url ? { source: url } : {}) }, ...geometries.filter(entry => entry !== existing)];
          }
        }
        if (values.geojson.trim()) {
          const shape = JSON.parse(values.geojson);
          const kind = { Point: "exact", LineString: "route", Polygon: "area", MultiPoint: "multi-location" }[shape?.type];
          if (!kind) throw new Error("Use a GeoJSON Point, LineString, Polygon or MultiPoint.");
          geometries.push({ kind, shape });
        }
        if (file) ensureFile(file);
        availability = availabilityValues(values.availability);
      } catch (problem) { error.textContent = problem.message; return; }
      const source = url ? [{ url, kind: values.sourceKind, ...(values.observedAt ? { observedAt: values.observedAt } : {}) }] : [];
      persistPlace({
        ...place, name, geometries, category: values.category, region: values.region, address: values.address, notes: values.notes,
        sources: [...(place?.sources || []), ...source],
        evidence: [...(place?.evidence || []), ...(name === values.detectedName ? [{ field: "name", status: "inferred" }] : [])],
        originalText: values.originalText || place?.originalText || "",
        description: values.description, hours: values.hours, season: values.season, accessibility: values.accessibility, availability,
        visits: place?.visits || [], parents: [...new Set([...(place?.parents || []), values.parent].filter(Boolean))],
        tags: listValues(values.tags), collections: listValues(values.collections), companions: listValues(values.companions),
        priority: values.priority, duration: values.duration ? Number(values.duration) : null,
        cost: values.cost === "" ? null : Number(values.cost), currency: values.currency,
        favorite: Boolean(values.favorite), archived: Boolean(values.archived)
      }, place, file);
      break;
    }
    case "visit-form": {
      const place = getPlace(values.placeId);
      place.visits.push({ date: values.date, notes: values.notes });
      updated("Recorded the visit.");
      break;
    }
    case "nearby-form":
      setNearby([Number(values.longitude), Number(values.latitude)]);
      break;
    case "collect-form": {
      const items = [...selected].map(getPlace).filter(Boolean).map(place => ({ id: place.id, revision: place.revision }));
      runCommand({ action: "place-collect", collection: name, items }, "Added selected places to " + name + ".");
      break;
    }
    case "share-settings-form":
      try {
        const result = await api("/share-preference", { method: "POST", headers: { "Content-Type": "application/json", "X-DCC-Places": "1" },
          body: JSON.stringify({ enabled: Boolean(values.enabled) }) });
        data.shareToPlaces = result.shareToPlaces;
        closeDialog();
        say(data.shareToPlaces ? "New mobile shares go to Places." : "New mobile shares go to the Vault inbox.");
      } catch (error) { say(error.message); }
      break;
    case "route-form": {
      try {
        const result = await api("/trips/" + trip.id + "/route", {
          method: "POST", headers: { "Content-Type": "application/json", "X-DCC-Places": "1" },
          body: JSON.stringify({ day: Number(values.day), mode: values.mode })
        });
        if (getTrip()?.id !== trip.id || getTrip().revision !== result.revision) return say("The trip changed. Check travel again.");
        routePreview = { ...result, tripId: trip.id, day: Number(values.day), window: values.window ? Number(values.window) : null };
        render();
        fitMap();
      } catch (error) { say(error.message); }
      break;
    }
    case "related-form": {
      const container = dialog.querySelector("#related-results");
      try {
        const results = await api("/related?q=" + encodeURIComponent(values.query));
        container.innerHTML = results.map(result => '<div class="list-row"><div><span data-record-title>' + escapeHtml(result.title) + '</span> <small class="muted">' + escapeHtml(result.type) +
          '</small></div>' + button(relatedTarget.kind === "import" ? "Save as place" : "Link", "link-result", result.type + "|" + result.id, "small") + '</div>').join("") || '<p class="muted">No matching records.</p>';
      } catch (error) { container.textContent = error.message; }
      break;
    }
    case "prep-task-form": {
      const record = values.kind === "place" ? getPlace(values.recordId) : getTrip();
      runCommand({ action: "linked-task", id: values.recordId, kind: values.kind, revision: record.revision, title: values.title, date: values.date || undefined }, "Created the linked DCC task.");
      break;
    }
    case "refine-form": {
      const request = values.request.toLowerCase();
      const strategy = /shorter|less day|remove.*day/.test(request) ? "shorter" : /relax|slower|easy/.test(request) ? "relaxed" :
        /cheap|budget|cost/.test(request) ? "budget" : /hik|adventure|outdoor/.test(request) ? "outdoors" :
        /food|restaurant|dining/.test(request) ? "food" : /near|walking|less driving|group/.test(request) ? "nearby" : null;
      if (!strategy) say("Try shorter, more relaxed, cheaper, more hiking, food-focused or nearby stops.");
      else comparison(trip, strategy);
      break;
    }

    case "new-trip-form": {
      const count = Number(values.days);
      if (!name || !Number.isInteger(count) || count < 1 || count > 62) return;
      const next = makeTrip(name, count, values.zone, values.season.trim());
      next.destination = values.destination;
      const ids = values.places.split(",").filter(id => getPlace(id));
      if (!ids.length && values.destination.trim()) {
        const destination = values.destination.trim().toLowerCase();
        ids.push(...data.places.filter(place => !place.archived &&
          [place.region, place.group, ...place.collections].some(label => label.toLowerCase().includes(destination))).map(place => place.id).slice(0, count * 5));
      }
      ids.forEach((id, index) => next.days[values.places ? 0 : Math.floor(index / 5)].stops.push(
        makeStop(id, getPlace(id).category === "Food & drink" ? "Evening" : "Morning")));
      data.trips.push(next);
      selected.clear();
      activate(next.id, libraryView === "map" && ids.length ? "map" : "timeline");
      updated("Created your undated trip.");
      break;
    }
    case "trip-settings-form": {
      if (!name) return;
      const count = Number(values.dayCount);
      if (trip.days.slice(count).some(day => day.notes || day.stops.length)) return say("Move stops or notes out of the final days first.");
      trip.days.splice(count);
      while (trip.days.length < count) trip.days.push({ id: uid(), stops: [], notes: "" });
      activeDay = Math.min(activeDay, count - 1);
      Object.assign(trip, { name, status: values.status, season: values.season.trim(), transport: values.transport, buffer: Number(values.buffer), budget: values.budget === "" ? null : Number(values.budget), currency: values.currency, notes: values.notes.trim(), companions: listValues(values.companions) });
      updated("Saved trip settings.");
      break;
    }
    case "edit-stop-form": {
      const item = values.stopId ? findStop(trip, values.stopId) : null;
      const stop = item?.stop || makeStop(null);
      if (!stop.placeId && !values.title?.trim()) return;
      const day = values.day == null ? item.day : trip.days[Number(values.day)];
      if (item && day !== item.day) item.day.stops = item.day.stops.filter(row => row !== stop);
      if (!item || day !== item.day) day.stops.push(stop);
      if (stop.transferMinutes !== (values.transfer === "" ? null : Number(values.transfer))) delete stop.transferEvidence;
      Object.assign(stop, { title: values.title?.trim(), period: values.period, time: values.time, duration: values.duration ? Number(values.duration) : null,
        transferMinutes: values.transfer === "" ? null : Number(values.transfer), cost: values.cost === "" ? null : Number(values.cost),
        zone: values.zone || undefined, startOffset: values.startOffset?.trim() || undefined, endOffset: values.endOffset?.trim() || undefined,
        notes: values.notes.trim(), locked: Boolean(values.locked), optional: Boolean(values.optional) });
      updated("Saved activity.");
      break;
    }
    case "day-notes-form":
      trip.days[Number(values.day)].notes = values.notes.trim();
      updated("Saved day notes.");
      break;
    case "schedule-form":
      schedulePreview(trip, values.date, values.mode);
      break;
  }
});

document.addEventListener("input", event => {
  if (event.target.id === "search-places") {
    search = event.target.value;
    render();
  }
});

document.addEventListener("change", event => {
  const input = event.target;
  switch (input.id) {
    case "category-filter":
      category = input.value;
      render();
      document.getElementById(input.id).focus();
      break;
    case "sort-places":
      sort = input.value;
      render();
      document.getElementById(input.id).focus();
      break;
    case "location-filter":
      locationFilter = input.value;
      render();
      document.getElementById(input.id).focus();
      break;
    case "compare-version":
      comparison(getTrip(), input.value);
      dialog.querySelector("#compare-version")?.focus();
      break;
    case "active-day":
      activeDay = Number(input.value);
      break;
  }
});

function clearDropTargets() {
  app.querySelectorAll(".drop-target").forEach(node => node.classList.remove("drop-target"));
}

app.addEventListener("dragstart", event => {
  const node = event.target.closest(".stop.draggable");
  if (!node) return;
  dragging = node.dataset.stop;
  event.dataTransfer.setData("text/plain", "trip-stop");
  event.dataTransfer.effectAllowed = "move";
  node.classList.add("dragging");
});

app.addEventListener("dragover", event => {
  const day = event.target.closest("[data-day]");
  if (!dragging || !day) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearDropTargets();
  (event.target.closest(".stop") || day).classList.add("drop-target");
});

app.addEventListener("drop", event => {
  const day = event.target.closest("[data-day]");
  if (!dragging || !day) return;
  event.preventDefault();
  const id = dragging;
  dragging = null;
  clearDropTargets();
  if (moveStop(getTrip(), id, Number(day.dataset.day), event.target.closest(".stop")?.dataset.stop)) updated("Moved activity.");
  else { app.querySelector(".dragging")?.classList.remove("dragging"); say("This position is unavailable for that activity."); }
});

app.addEventListener("dragend", () => {
  dragging = null;
  clearDropTargets();
  app.querySelector(".dragging")?.classList.remove("dragging");
});

window.addEventListener("resize", () => {
  const map = document.getElementById("map-surface");
  if (map) paintMap(map);
});
reloadRecords().then(() => {
  const parameters = new URLSearchParams(location.search);
  const place = getPlace(parameters.get("place"));
  if (place) openDetails(place);
  const share = parameters.get("share");
  if (share === "failed") say("The share did not save. Try again or capture it in Places.");
  if (share === "image-failed") say("The discovery saved. Add the screenshot again from Edit place.");
  if (place || share) {
    parameters.delete("place");
    parameters.delete("share");
    const query = parameters.toString();
    history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
  }
});
})();
