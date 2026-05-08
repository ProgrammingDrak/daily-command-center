// ======== GOOGLE CALENDAR CLIENT ========
// Browser-side API wrapper for GCal integration.
// All calls go through the Express API — no direct Google API access from browser.

(function () {
  "use strict";

  const gcal = {};

  // ── Connection Status ──
  gcal.status = async function () {
    const res = await fetch("/api/gcal/status");
    return res.json();
  };

  gcal.disconnect = async function () {
    const res = await fetch("/api/gcal/disconnect", { method: "POST" });
    return res.json();
  };

  // ── Calendar Management ──
  gcal.getCalendars = async function () {
    const res = await fetch("/api/gcal/calendars");
    return res.json();
  };

  gcal.toggleCalendar = async function (calendarId, selected, accountKey) {
    const res = await fetch(`/api/gcal/calendars/${encodeURIComponent(calendarId)}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected, accountKey }),
    });
    return res.json();
  };

  // ── Event Details (full GCal metadata) ──
  gcal.getEventDetails = async function (blockId) {
    const res = await fetch(`/api/gcal/event/${blockId}`);
    if (!res.ok) return null;
    return res.json();
  };

  // ── Event Mutations ──
  gcal.updateEvent = async function (blockId, changes) {
    const res = await fetch(`/api/gcal/event/${blockId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    return res.json();
  };

  gcal.addAttendee = async function (blockId, email) {
    const res = await fetch(`/api/gcal/event/${blockId}/attendees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return res.json();
  };

  gcal.removeAttendee = async function (blockId, email) {
    const res = await fetch(`/api/gcal/event/${blockId}/attendees/${encodeURIComponent(email)}`, {
      method: "DELETE",
    });
    return res.json();
  };

  gcal.rsvp = async function (blockId, response) {
    const res = await fetch(`/api/gcal/event/${blockId}/rsvp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    });
    return res.json();
  };

  gcal.createEvent = async function (eventData) {
    const res = await fetch("/api/gcal/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventData),
    });
    return res.json();
  };

  gcal.deleteEvent = async function (blockId) {
    const res = await fetch(`/api/gcal/event/${blockId}`, {
      method: "DELETE",
    });
    return res.json();
  };

  // ── Sync ──
  gcal.triggerSync = async function () {
    const res = await fetch("/api/gcal/sync", { method: "POST" });
    return res.json();
  };

  // ── Cache for overlay details ──
  gcal._detailsCache = new Map();

  gcal.getCachedDetails = async function (blockId) {
    if (gcal._detailsCache.has(blockId)) return gcal._detailsCache.get(blockId);
    const details = await gcal.getEventDetails(blockId);
    if (details) gcal._detailsCache.set(blockId, details);
    return details;
  };

  gcal.clearCache = function (blockId) {
    if (blockId) gcal._detailsCache.delete(blockId);
    else gcal._detailsCache.clear();
  };

  // Expose globally
  window.gcal = gcal;
})();
