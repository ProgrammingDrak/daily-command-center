// meeting-alerts.js — soft pre-meeting nudges on the itinerary.
//
// Rides the 1-second clock tick (clock.js updateClock -> window.meetingAlertTick):
//   - T-5 min: the meeting's card breathes a soft orange pulse (.meeting-soon).
//   - T-2 min: a one-time in-app toast fires (with a Join button when the event
//     has a hangout link). There is no service worker, so this only surfaces
//     while a DCC tab is open (in-app only, by design).
//
// The fire-once key is `${id}@${start}`: moving a meeting (manual drag/picker OR
// a calendar re-sync that changes its time) changes `start`, which re-arms the
// alert for the new time. Fired keys persist to localStorage so a page refresh
// doesn't re-fire an alert you already dismissed.
(function () {
  "use strict";
  var PULSE_MIN = 5; // begin the soft pulse this many minutes before start
  var ALERT_MIN = 2; // pop the one-time toast this many minutes before start

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function viewingToday() {
    try { return !!(window.__state && window.__state.date === todayStr()); }
    catch (e) { return false; }
  }

  // Fired-key set, persisted per day so a refresh doesn't replay alerts.
  var _fired = null, _firedDay = null;
  function firedSet() {
    var day = todayStr();
    if (_fired && _firedDay === day) return _fired;
    var key = "dcc-meeting-alerts-" + day, arr = [];
    try { arr = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { arr = []; }
    _fired = new Set(Array.isArray(arr) ? arr : []);
    _firedDay = day;
    _fired._persist = function () {
      try { localStorage.setItem(key, JSON.stringify(Array.from(_fired))); } catch (e) {}
    };
    return _fired;
  }

  function minutesUntil(ev) {
    if (typeof pt !== "function" || typeof now !== "function") return NaN;
    return pt(ev.start) - now();
  }
  function isLiveMeeting(ev) {
    if (!ev || typeof isMeeting !== "function" || !isMeeting(ev)) return false;
    if (typeof isDone === "function" && isDone(ev)) return false;
    if (typeof isDeleted === "function" && isDeleted(ev)) return false;
    if (typeof isPushed === "function" && isPushed(ev)) return false;
    if (ev.untimed) return false;
    return true;
  }
  function esc(id) {
    return (window.CSS && typeof window.CSS.escape === "function") ? window.CSS.escape(String(id)) : String(id);
  }

  function fireAlert(ev) {
    var mins = Math.max(0, Math.round(minutesUntil(ev)));
    var when = mins <= 0 ? "now" : ("in " + mins + " min");
    var msg = "Meeting " + when + ": " + (ev.title || "(untitled)");
    var link = ev.hangout_link || ev.calUrl || "";
    var action = link ? { label: "Join", onClick: function () { try { window.open(link, "_blank"); } catch (e) {} } } : null;
    if (window.DCC && typeof window.DCC.toast === "function") window.DCC.toast(msg, "info", 60000, action);
    else if (typeof window.showToast === "function") window.showToast(msg, "info", 60000, action);
  }

  function clearAllPulses() {
    document.querySelectorAll(".card.meeting-soon,.it-list-item.meeting-soon")
      .forEach(function (el) { el.classList.remove("meeting-soon"); });
  }

  window.meetingAlertTick = function () {
    if (!Array.isArray(window.scheduled)) return;
    if (!viewingToday()) { clearAllPulses(); return; }
    var fired = firedSet();
    for (var i = 0; i < window.scheduled.length; i++) {
      var ev = window.scheduled[i];
      if (!isLiveMeeting(ev)) continue;
      var mins = minutesUntil(ev);
      if (Number.isNaN(mins)) continue;

      // Pulse window: (0, PULSE_MIN]. Toggle the class on every matching row
      // (list view row + timeline card both carry data-id).
      var soon = mins > 0 && mins <= PULSE_MIN;
      var nodes = document.querySelectorAll('[data-id="' + esc(ev.id) + '"]');
      nodes.forEach(function (el) {
        var card = el.classList.contains("card") ? el
          : (el.classList.contains("it-list-item") ? el : (el.querySelector(".card") || el));
        if (soon) card.classList.add("meeting-soon");
        else card.classList.remove("meeting-soon");
      });

      // Alert window: fire once from ALERT_MIN before start through start
      // (skip meetings already well underway on a late page load).
      if (mins <= ALERT_MIN && mins > -1) {
        var key = ev.id + "@" + ev.start;
        if (!fired.has(key)) { fired.add(key); fired._persist(); fireAlert(ev); }
      }
    }
  };
})();
