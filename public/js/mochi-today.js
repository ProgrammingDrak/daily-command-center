// mochi-today.js — the Mochi band on top of "Today with Mochi" (the reskinned
// Working Queue). It only READS: game summary (/api/game/summary), the pet
// (/api/pet-home/state) and the queue's own render event (dcc:queue-rendered).
// Queue state and actions stay in working-queue.js.
/* global window, document */
(function () {
  "use strict";
  const DCC = window.DCC, Art = window.DCCMochiArt;
  const panel = document.getElementById("tab-working-queue");
  const queueRoot = document.getElementById("working-queue-root");
  if (!DCC || typeof DCC.api !== "function" || !Art || !panel || !queueRoot) return;

  const band = document.createElement("section");
  band.className = "mochi-band";
  band.id = "mochi-band";
  band.setAttribute("aria-label", "Mochi");
  panel.insertBefore(band, queueRoot);

  let game = null, pet = null, queue = { foreground: [], next: [], needs: 0, waiting: 0 };
  let cheer = null, cheerTimer = null, inflight = null;

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const name = () => (pet && pet.name) || "Mochi";
  const pct = (n) => Math.max(0, Math.min(100, Math.round(n)));

  function speech() {
    if (cheer) return { text: cheer, mood: "proud" };
    const asks = (game && game.intentions && game.intentions.big3) || [];
    if (game && !asks.length && !queue.foreground.length) return { text: "Good morning! Pick 3 asks for us today? Tap \"Pick asks\".", mood: "happy", pick: true };
    if (queue.needs) return { text: queue.needs === 1 ? "One thing needs you. Take a look when you're ready." : queue.needs + " things need you. One at a time.", mood: "worried" };
    if (queue.foreground[0]) return { text: "I'm sitting with you on \"" + queue.foreground[0] + "\". Finish it together for bonus sparks.", mood: "happy" };
    if (queue.next[0]) return { text: "Ready when you are. \"" + queue.next[0] + "\" is the most important next.", mood: "happy" };
    return { text: "All clear! I'm proud of you.", mood: "proud" };
  }

  function render() {
    const say = speech();
    const stage = game && game.petStage;
    const asks = (game && game.intentions && game.intentions.big3) || [];
    const asksDone = asks.filter((a) => a.done).length;
    const it = (game && game.intentions) || {};
    const stagePct = stage ? (stage.next ? pct(100 * (game.lifetimeXp - stage.min) / (stage.next.min - stage.min)) : 100) : 0;
    band.innerHTML =
      '<div class="mochi-pet" data-mochi-pet>' + Art.svg({ mood: say.mood, hat: pet && pet.accessory, color: pet && pet.color, label: name() + " looks " + say.mood }) + "</div>" +
      '<div class="mochi-talk"><p class="mochi-bubble" role="status" aria-live="polite">' + esc(say.text) + "</p>" +
        '<div class="mochi-chips">' +
          (asks.length ? '<button type="button" class="mochi-chip is-ask" data-mochi-asks>Asks ' + asksDone + "/" + asks.length + "</button>" : '<button type="button" class="mochi-chip is-ask" data-mochi-asks>Pick asks</button>') +
          (game ? '<span class="mochi-chip">' + game.streak.current + " day streak</span>" +
            '<span class="mochi-chip">' + game.lives.left + " rest day" + (game.lives.left === 1 ? "" : "s") + " left</span>" : "") +
          (it.minimumDay ? '<label class="mochi-chip mochi-min"><input type="checkbox" data-mochi-min' + (it.minimumDayDone ? " checked" : "") + "> Minimum day: " + esc(it.minimumDay) + "</label>" : "") +
        "</div></div>" +
      '<div class="mochi-meters">' +
        (stage ? '<div class="mochi-meter"><span>' + esc(name()) + " is a <b>" + esc(stage.label) + '</b></span><div class="mochi-bar"><i style="width:' + stagePct + '%;background:var(--mochi-leaf)"></i></div><small>' + (stage.next ? stage.next.xpToGo + " sparks to " + esc(stage.next.label) : "Fully grown") + "</small></div>" : "") +
        (game ? '<div class="mochi-meter"><span>Today</span><div class="mochi-bar"><i style="width:' + pct(game.todayXp / 1.2) + '%;background:var(--mochi-gold)"></i></div><small><b data-mochi-today>' + game.todayXp + "</b> sparks</small></div>" +
          '<div class="mochi-meter"><span>Weekend trip</span><div class="mochi-bar"><i style="width:' + (game.tier.next ? pct(100 * (game.weekXp - game.tier.min) / (game.tier.next.min - game.tier.min)) : 100) + '%;background:var(--mochi-sky)"></i></div><small>' + esc(game.tier.label) + (game.tier.next ? " · " + game.tier.next.xpToGo + " to " + esc(game.tier.next.label) : "") + "</small></div>" : "") +
      "</div>";
  }

  function pop(points) {
    if (!(points > 0)) return;
    cheer = ["Yay! +", "Wonderful! +", "We did it! +"][Math.floor(Math.random() * 3)] + points + " sparks for me. Thank you!";
    window.clearTimeout(cheerTimer);
    cheerTimer = window.setTimeout(() => { cheer = null; render(); }, 6000);
    render();
    if (reduced()) return;
    const host = band.querySelector("[data-mochi-pet]");
    if (!host) return;
    host.classList.add("is-hop");
    const p = document.createElement("span");
    p.className = "mochi-pop";
    p.textContent = "+" + points;
    p.setAttribute("aria-hidden", "true");
    host.appendChild(p);
    window.setTimeout(() => { host.classList.remove("is-hop"); p.remove(); }, 1400);
  }

  async function load() {
    if (inflight) return inflight;
    inflight = (async () => {
      const before = game ? game.todayXp : null;
      const [g, p] = await Promise.all([
        DCC.api("/api/game/summary").catch(() => game),
        pet ? Promise.resolve(null) : DCC.api("/api/pet-home/state").catch(() => null),
      ]);
      if (g) game = g;
      if (p && p.home) pet = p.home.pet || null;
      render();
      if (before != null && game && game.today === (g && g.today) && game.todayXp > before) pop(game.todayXp - before);
    })().finally(() => { inflight = null; });
    return inflight;
  }

  band.addEventListener("click", (e) => {
    if (e.target.closest("[data-mochi-asks]") && window.DCCGameHud) window.DCCGameHud.open();
  });
  band.addEventListener("change", async (e) => {
    if (!e.target.matches("[data-mochi-min]") || !game) return;
    try {
      await DCC.api("/api/game/intentions/" + game.today + "/minimum-day", { method: "POST", body: { done: e.target.checked } });
      if (e.target.checked) cheer = "Minimum day done! Today counts, no matter what.";
      load();
    } catch (err) { DCC.toast(err.message || "Could not update minimum day"); }
  });
  window.addEventListener("dcc:queue-rendered", (e) => {
    const d = e.detail || {};
    const changed = JSON.stringify(d) !== JSON.stringify(queue);
    queue = { foreground: d.foreground || [], next: d.next || [], needs: d.needs || 0, waiting: d.waiting || 0 };
    if (changed) render();
  });
  document.addEventListener("game-changed", () => load());
  window.addEventListener("dcc:work-session-changed", () => load());
  window.addEventListener("dcc:game-intentions-changed", () => load());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  window.setInterval(() => { if (!document.hidden) load(); }, 60000);

  window.DCCMochiToday = { refresh: load };
  render();
  load();
})();
