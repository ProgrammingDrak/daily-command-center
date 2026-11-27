// mochi-art.js — draws the DCC pet (Mochi) as inline SVG. Pure string output,
// no DOM, so the band, the header chip and any dialog share one drawing.
//   DCCMochiArt.svg({ mood, hat, color, label }) -> "<svg …>…</svg>"
//   mood: happy | proud | sleepy | worried
//   hat:  none | bandana | beanie | flower | party | wizard | crown
//         (the pet's saved `accessory` values hat/necklace map to beanie/none)
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DCCMochiArt = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const HATS = ["none", "bandana", "beanie", "flower", "party", "wizard", "crown"];
  const INK = "#2b2230";

  function hatId(value) {
    const v = String(value || "none").toLowerCase();
    if (v === "hat") return "beanie";
    return HATS.includes(v) ? v : "none";
  }

  function safeColor(value) {
    return /^#[0-9a-f]{3,8}$/i.test(String(value || "")) ? value : "#f2b56b";
  }

  function hat(id) {
    switch (id) {
      case "bandana": return '<path d="M-46 -30 Q0 -12 46 -30 L40 -18 Q0 -2 -40 -18Z" fill="#e2566b"/><path d="M38 -22 l18 8 -6 -16z" fill="#c9465a"/>';
      case "beanie": return '<path d="M-44 -38 Q0 -98 44 -38Z" fill="#5b8def"/><rect x="-47" y="-42" width="94" height="14" rx="7" fill="#7aa6ff"/><circle cx="0" cy="-86" r="9" fill="#fff"/>';
      case "flower": return '<path d="M-44 -40 Q0 -54 44 -40" stroke="#7cc47f" stroke-width="5" fill="none"/>' +
        [-34, -17, 0, 17, 34].map((x, i) => '<g transform="translate(' + x + " " + (-45 - (i % 2) * 4) + ')"><circle r="7" fill="' + ["#f08a9b", "#f6c453", "#fff", "#f6c453", "#f08a9b"][i] + '"/><circle r="2.5" fill="#e0884a"/></g>').join("");
      case "party": return '<path d="M-24 -40 L0 -104 L24 -40Z" fill="#b38cf5"/><path d="M-16 -60 L16 -60 M-9 -80 L9 -80" stroke="#f6c453" stroke-width="5"/><circle cx="0" cy="-106" r="7" fill="#f6c453"/>';
      case "wizard": return '<path d="M-50 -38 Q0 -28 50 -38 Q0 -50 -50 -38Z" fill="#33407a"/><path d="M-30 -40 Q-4 -80 20 -112 Q14 -70 30 -40Z" fill="#3e4d93"/><path d="M-2 -70 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1z" fill="#f6c453"/>';
      case "crown": return '<path d="M-28 -40 L-30 -72 L-14 -56 L0 -78 L14 -56 L30 -72 L28 -40Z" fill="#f6c453"/><circle cx="0" cy="-52" r="5" fill="#f08a9b"/>';
      default: return "";
    }
  }

  function face(mood) {
    const eyes = mood === "proud"
      ? '<path d="M-24 -6 q8 -9 16 0 M8 -6 q8 -9 16 0" stroke="' + INK + '" stroke-width="5" fill="none" stroke-linecap="round"/>'
      : mood === "sleepy"
        ? '<path d="M-24 -4 h16 M8 -4 h16" stroke="' + INK + '" stroke-width="5" stroke-linecap="round"/>'
        : '<ellipse cx="-16" cy="-6" rx="6" ry="8" fill="' + INK + '"/><ellipse cx="16" cy="-6" rx="6" ry="8" fill="' + INK + '"/><circle cx="-14" cy="-9" r="2.2" fill="#fff"/><circle cx="18" cy="-9" r="2.2" fill="#fff"/>';
    const mouth = mood === "sleepy"
      ? '<ellipse cx="0" cy="14" rx="4" ry="3" fill="' + INK + '"/>'
      : mood === "worried"
        ? '<path d="M-7 16 q7 -6 14 0" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>'
        : '<path d="M-9 10 q9 10 18 0" stroke="' + INK + '" stroke-width="4" fill="none" stroke-linecap="round"/>';
    return eyes + '<ellipse cx="-32" cy="8" rx="8" ry="5" fill="#f08a9b" opacity=".7"/><ellipse cx="32" cy="8" rx="8" ry="5" fill="#f08a9b" opacity=".7"/>' + mouth;
  }

  // The body group, centred on (0,0), about 160 x 180 units with a hat.
  function body({ mood = "happy", hat: hatValue = "none", color } = {}) {
    const h = hatId(hatValue), c = safeColor(color);
    const leaf = ["none", "bandana", "flower"].includes(h)
      ? '<path d="M0 -48 Q-4 -66 6 -74" stroke="#5a9a5e" stroke-width="4" fill="none"/><path d="M6 -74 Q24 -84 30 -66 Q14 -62 6 -74Z" fill="#7cc47f"/>'
      : "";
    return '<ellipse cx="0" cy="62" rx="54" ry="9" fill="#000" opacity=".22"/>' +
      '<ellipse cx="-24" cy="54" rx="14" ry="9" fill="' + c + '" style="filter:brightness(.85)"/><ellipse cx="24" cy="54" rx="14" ry="9" fill="' + c + '" style="filter:brightness(.85)"/>' +
      '<path d="M-56 10 Q-58 -46 0 -48 Q58 -46 56 10 Q54 58 0 58 Q-54 58 -56 10Z" fill="' + c + '"/>' +
      '<path d="M-30 30 Q0 50 30 30 Q26 52 0 52 Q-26 52 -30 30Z" fill="#fff" opacity=".35"/>' +
      '<path d="M-52 2 Q-74 14 -66 30 Q-56 26 -50 18Z" fill="' + c + '" style="filter:brightness(.9)"/><path d="M52 2 Q74 14 66 30 Q56 26 50 18Z" fill="' + c + '" style="filter:brightness(.9)"/>' +
      leaf + face(mood) + hat(h);
  }

  function svg(opts = {}) {
    const label = String(opts.label || "").replace(/[&<>"']/g, "");
    return '<svg viewBox="-80 -115 160 185" ' + (label ? 'role="img" aria-label="' + label + '"' : 'aria-hidden="true" focusable="false"') +
      ' class="mochi-art"><g class="mochi-body">' + body(opts) + "</g></svg>";
  }

  return { svg, body, hatId, HATS };
});
