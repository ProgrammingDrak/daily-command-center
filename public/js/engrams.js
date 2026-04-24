// ======== ENGRAM MEMORY ========
let ENGRAM_KEY = "pa-engrams-" + ((__state && __state.date) ? __state.date : "unknown");
let MOOD_KEY = "pa-mood-" + ((__state && __state.date) ? __state.date : "unknown");

function loadEngrams() {
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.engrams&&window.blockStore){
    return [...window.blockStore.getByType("engram"),...window.blockStore.getByType("block").filter(b=>(b.properties||{}).tag&&(b.properties||{}).name&&!(b.properties||{}).scheduled_dates)].map(b=>({
      tag:b.properties.tag, name:b.properties.name,
      category:b.properties.category, context:b.properties.context, _blockId:b.id
    }));
  }
  try { return JSON.parse(localStorage.getItem(ENGRAM_KEY) || "[]"); } catch(e) { return []; }
}
function saveEngrams(data) {
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.engrams&&window.blockStore){
    data.forEach(e=>{
      if(!e._blockId){
        window.blockStore.createBlock("block",{tag:e.tag,name:e.name,category:e.category||"",context:e.context||""},{
          parentId:window.blockStore.getDayRootId(),date:window.blockStore.getCurrentDate()
        }).then(b=>{e._blockId=b.id});
      }
    });
    return;
  }
  localStorage.setItem(ENGRAM_KEY, JSON.stringify(data)); scheduleIDBSave();
}
function loadMoodData() {
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.mood&&window.blockStore){
    const entries=[...window.blockStore.getByType("mood_entry"),...window.blockStore.getByType("block").filter(b=>(b.properties||{}).mood!==undefined&&!(b.properties||{}).scheduled_dates)].map(b=>({
      mood:b.properties.mood, energy:b.properties.energy,
      time:b.properties.time, note:b.properties.note, _blockId:b.id
    }));
    if(entries.length){
      const avgMood=entries.reduce((s,e)=>s+e.mood,0)/entries.length;
      const avgEnergy=entries.reduce((s,e)=>s+(e.energy||3),0)/entries.length;
      return{entries,overall:avgMood,energy:avgEnergy};
    }
    return{};
  }
  try { return JSON.parse(localStorage.getItem(MOOD_KEY) || "{}"); } catch(e) { return {}; }
}
function saveMoodData(data) {
  if(window.USE_BLOCKSTORE&&window.USE_BLOCKSTORE.mood&&window.blockStore&&data.entries){
    const lastEntry=data.entries[data.entries.length-1];
    if(lastEntry&&!lastEntry._blockId){
      window.blockStore.createBlock("block",{
        mood:lastEntry.mood,energy:lastEntry.energy||3,time:lastEntry.time||"",note:lastEntry.note||""
      },{parentId:window.blockStore.getDayRootId(),date:window.blockStore.getCurrentDate()})
      .then(b=>{lastEntry._blockId=b.id});
    }
    return;
  }
  localStorage.setItem(MOOD_KEY, JSON.stringify(data)); scheduleIDBSave();
}

// Category color map (populated at load time if taxonomy available, re-populated by boot.js after API fetch)
const ENGRAM_COLORS = {};
const ENGRAM_ICONS = {};
(function populateEngramMaps() {
  const cats = (window.__ENGRAM_TAXONOMY__ && window.__ENGRAM_TAXONOMY__.categories) || [];
  cats.forEach(c => { ENGRAM_COLORS[c.id] = c.color; ENGRAM_ICONS[c.id] = c.icon; });
})();

function slugify(str) { return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

// Mood face selection
let _selectedMood = null, _selectedEnergy = null;
document.querySelectorAll("#engram-mood-faces .mood-face").forEach(btn => {
  btn.addEventListener("click", () => {
    _selectedMood = parseInt(btn.dataset.mood);
    document.querySelectorAll("#engram-mood-faces .mood-face").forEach(b => b.classList.toggle("selected", b === btn));
    document.getElementById("engram-mood-note-row").style.display = "flex";
  });
});
document.querySelectorAll("#engram-energy-faces .mood-face").forEach(btn => {
  btn.addEventListener("click", () => {
    _selectedEnergy = parseInt(btn.dataset.energy);
    document.querySelectorAll("#engram-energy-faces .mood-face").forEach(b => b.classList.toggle("selected", b === btn));
    document.getElementById("engram-mood-note-row").style.display = "flex";
  });
});

function saveMoodEntry() {
  if (!_selectedMood && !_selectedEnergy) return;
  const mood = loadMoodData();
  const entry = {
    time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
    mood: _selectedMood || null,
    energy: _selectedEnergy || null,
    note: document.getElementById("engram-mood-note").value.trim()
  };
  if (!mood.entries) mood.entries = [];
  mood.entries.push(entry);
  // Compute overall as average
  const moods = mood.entries.filter(e => e.mood).map(e => e.mood);
  const energies = mood.entries.filter(e => e.energy).map(e => e.energy);
  if (moods.length) mood.overall = Math.round(moods.reduce((a, b) => a + b, 0) / moods.length * 10) / 10;
  if (energies.length) mood.energy = Math.round(energies.reduce((a, b) => a + b, 0) / energies.length * 10) / 10;
  saveMoodData(mood);
  // Reset UI
  _selectedMood = null; _selectedEnergy = null;
  document.querySelectorAll(".mood-face").forEach(b => b.classList.remove("selected"));
  document.getElementById("engram-mood-note").value = "";
  buildMoodTimeline();
}

function buildMoodTimeline() {
  const mood = loadMoodData();
  const el = document.getElementById("engram-mood-timeline");
  if (!mood.entries || !mood.entries.length) { el.innerHTML = ""; return; }
  const moodEmoji = { 1: "😫", 2: "😔", 3: "😐", 4: "😊", 5: "🤩" };
  el.innerHTML = mood.entries.map(e => {
    const moji = e.mood ? moodEmoji[e.mood] : "";
    const nrg = e.energy ? "⚡".repeat(Math.min(e.energy, 3)) : "";
    const note = e.note ? ` — ${e.note}` : "";
    return `<span class="mood-timeline-dot"><span class="mtd-time">${e.time}</span> ${moji}${nrg}${note}</span>`;
  }).join("");
}

// Engram tag autocomplete
const engramInput = document.getElementById("engram-tag-input");
const engramAC = document.getElementById("engram-autocomplete");

engramInput.addEventListener("input", () => {
  const q = engramInput.value.trim().toLowerCase();
  if (q.length < 2) { engramAC.style.display = "none"; return; }
  const index = (window.__ENGRAM_INDEX__ || {}).tags || {};
  const matches = Object.entries(index).filter(([id, tag]) =>
    tag.name.toLowerCase().includes(q) || id.includes(q) || (tag.aliases || []).some(a => a.toLowerCase().includes(q))
  ).slice(0, 8);
  if (!matches.length) { engramAC.style.display = "none"; return; }
  engramAC.innerHTML = matches.map(([id, tag]) => {
    const icon = ENGRAM_ICONS[tag.category] || "🏷️";
    return `<div class="engram-ac-item" onclick="selectEngramAC('${id}','${tag.category}','${tag.name.replace(/'/g, "\\'")}')">
      <span>${icon}</span> <span>${tag.name}</span> <span class="eac-cat">${tag.category} · ${tag.count || 0}x</span>
    </div>`;
  }).join("");
  engramAC.style.display = "block";
});

engramInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { addEngram(); e.preventDefault(); }
  if (e.key === "Escape") { engramAC.style.display = "none"; }
});

document.addEventListener("click", (e) => {
  if (!engramAC.contains(e.target) && e.target !== engramInput) engramAC.style.display = "none";
});

function selectEngramAC(id, category, name) {
  engramInput.value = name;
  document.getElementById("engram-cat-select").value = category;
  engramAC.style.display = "none";
}

function addEngram() {
  const name = engramInput.value.trim();
  if (!name) return;
  const category = document.getElementById("engram-cat-select").value;
  const context = document.getElementById("engram-context-input").value.trim();
  const tagId = slugify(name);
  const engrams = loadEngrams();
  // Don't add duplicate
  if (engrams.find(e => e.tag === tagId)) { engramInput.value = ""; return; }
  engrams.push({ tag: tagId, name, category, context: context || undefined });
  saveEngrams(engrams);
  engramInput.value = "";
  document.getElementById("engram-context-input").value = "";
  engramAC.style.display = "none";
  buildEngramChips();
  updateEngramBadge();
}

function removeEngram(tagId) {
  const engrams = loadEngrams().filter(e => e.tag !== tagId);
  saveEngrams(engrams);
  buildEngramChips();
  updateEngramBadge();
}

function buildEngramChips() {
  const engrams = loadEngrams();
  const el = document.getElementById("engram-chips");
  if (!engrams.length) { el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">No tags yet. Start typing above to add engrams.</span>'; return; }
  el.innerHTML = engrams.map(e => {
    const color = ENGRAM_COLORS[e.category] || "#6b7280";
    const icon = ENGRAM_ICONS[e.category] || "🏷️";
    const ctx = e.context ? ` <span class="ec-context">${e.context}</span>` : "";
    return `<span class="engram-chip" style="border-color:${color}33;background:${color}12;color:${color}">
      <span class="ec-icon">${icon}</span> ${e.name || e.tag}${ctx}
      <span class="ec-remove" onclick="removeEngram('${e.tag}')">&times;</span>
    </span>`;
  }).join("");
}

function updateEngramBadge() {
  const count = loadEngrams().length;
  const badge = document.getElementById("engrams-count");
  if (count > 0) { badge.textContent = count; badge.style.display = "inline"; }
  else { badge.style.display = "none"; }
}

// ======== ENGRAM EXPLORER ========
function buildEngramExplorer(filterCat) {
  const index = (window.__ENGRAM_INDEX__ || {}).tags || {};
  const taxonomy = (window.__ENGRAM_TAXONOMY__ || {}).categories || [];

  // Build category filter buttons
  const filterEl = document.getElementById("engram-category-filters");
  filterEl.innerHTML = '<button class="engram-cat-btn' + (!filterCat ? " active" : "") + '" onclick="buildEngramExplorer()">All</button>' +
    taxonomy.map(c =>
      `<button class="engram-cat-btn${filterCat === c.id ? " active" : ""}" onclick="buildEngramExplorer('${c.id}')">${c.icon} ${c.label}</button>`
    ).join("");

  // Filter and sort tags
  let tags = Object.entries(index);
  if (filterCat) tags = tags.filter(([_, t]) => t.category === filterCat);
  tags.sort((a, b) => (b[1].count || 0) - (a[1].count || 0));

  const listEl = document.getElementById("engram-explorer-list");
  if (!tags.length) {
    listEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:12px">No engrams in this category yet.</div>';
    return;
  }
  listEl.innerHTML = tags.map(([id, tag]) => {
    const icon = ENGRAM_ICONS[tag.category] || "🏷️";
    const color = ENGRAM_COLORS[tag.category] || "#6b7280";
    const dates = (tag.dates || []).slice(-3).reverse().join(", ");
    const moodStr = tag.avgMood ? ` · mood ${tag.avgMood}` : "";
    return `<div class="engram-explorer-item" onclick="showEngramDetail('${id}')">
      <div>
        <span style="color:${color}">${icon}</span>
        <strong>${tag.name || id}</strong>
        <span style="font-size:10px;color:var(--text-muted);margin-left:4px">${tag.count || 0}x${moodStr}</span>
      </div>
      <span class="eei-dates">${dates}</span>
    </div>`;
  }).join("");
}

function showEngramDetail(tagId) {
  const index = (window.__ENGRAM_INDEX__ || {}).tags || {};
  const cooc = window.__ENGRAM_COOCCURRENCE__ || {};
  const tag = index[tagId];
  if (!tag) return;

  const icon = ENGRAM_ICONS[tag.category] || "🏷️";
  const color = ENGRAM_COLORS[tag.category] || "#6b7280";
  const dates = (tag.dates || []).sort().reverse();
  const related = Object.entries(cooc[tagId] || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const listEl = document.getElementById("engram-explorer-list");
  listEl.innerHTML = `
    <div style="padding:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <span style="font-size:24px">${icon}</span>
          <strong style="font-size:16px;margin-left:4px">${tag.name || tagId}</strong>
          <span style="font-size:11px;color:var(--text-muted);margin-left:8px">${tag.category}</span>
        </div>
        <button onclick="buildEngramExplorer()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--text-muted);cursor:pointer">&larr; Back</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:var(--bg);border-radius:6px;padding:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:var(--accent-light)">${tag.count || 0}</div>
          <div style="font-size:10px;color:var(--text-muted)">occurrences</div>
        </div>
        <div style="background:var(--bg);border-radius:6px;padding:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:var(--green)">${tag.avgMood || "—"}</div>
          <div style="font-size:10px;color:var(--text-muted)">avg mood</div>
        </div>
        <div style="background:var(--bg);border-radius:6px;padding:8px;text-align:center">
          <div style="font-size:18px;font-weight:700;color:var(--amber)">${tag.avgEnergy || "—"}</div>
          <div style="font-size:10px;color:var(--text-muted)">avg energy</div>
        </div>
      </div>
      ${related.length ? `<h4 style="font-size:12px;font-weight:700;margin-bottom:6px">Related tags</h4>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px">
        ${related.map(([rid, count]) => {
          const rt = index[rid];
          const rc = rt ? ENGRAM_COLORS[rt.category] || "#6b7280" : "#6b7280";
          return `<span class="engram-chip" style="border-color:${rc}33;background:${rc}12;color:${rc};cursor:pointer;font-size:10px" onclick="showEngramDetail('${rid}')">
            ${rt ? (ENGRAM_ICONS[rt.category] || "") : ""} ${rt ? rt.name : rid} <span style="opacity:0.5">${count}x</span>
          </span>`;
        }).join("")}
      </div>` : ""}
      <h4 style="font-size:12px;font-weight:700;margin-bottom:6px">Timeline</h4>
      <div style="display:flex;flex-direction:column;gap:2px">
        ${dates.map(d => `<div style="font-size:11px;padding:4px 8px;border-radius:4px;cursor:pointer;transition:background 0.1s" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background='none'" onclick="switchToDate('${d}')">${d}</div>`).join("")}
      </div>
    </div>
  `;
}

// Initialize engrams on load
buildEngramChips();
buildMoodTimeline();
updateEngramBadge();
buildEngramExplorer();

// ======== SECOND BRAIN: BACKUP / RESTORE ========
// Removed Phase 6. The previous implementation read empty localStorage and
// empty IndexedDB (BlockStore is the source of truth) and "restored" data into
// keys that nothing reads. A real backup/restore must hit /api/blocks +
// /api/pa-state -- file an issue, ship as a feature, not as tech debt.

