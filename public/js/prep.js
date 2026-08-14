// Embedded meeting-prep viewer.
const PREP_REGISTRY = {};
function registerPrep(key, htmlContent) { PREP_REGISTRY[key] = htmlContent; }
if (window.__PREP_FILES__) {
  Object.entries(window.__PREP_FILES__).forEach(([key, value]) => {
    PREP_REGISTRY[key] = value;
    PREP_REGISTRY["meeting-prep/" + key] = value;
  });
}
function openPrepViewer(href, title) {
  const body = document.getElementById("prep-viewer-body");
  document.getElementById("prep-viewer-title").textContent = title || "Document";
  const content = PREP_REGISTRY[href];
  body.innerHTML = content || '<div style="text-align:center;padding:60px;color:var(--text-muted)">No embedded content found.</div>';
  document.getElementById("prep-viewer-overlay").classList.add("open");
  const floating = document.getElementById("prep-float");
  if (floating) floating.style.display = "none";
}
function closePrepViewer() {
  document.getElementById("prep-viewer-overlay").classList.remove("open");
  document.getElementById("prep-viewer-body").innerHTML = "";
}
document.getElementById("prep-viewer-close").addEventListener("click", closePrepViewer);
document.getElementById("prep-viewer-overlay").addEventListener("click", event => { if (event.target === event.currentTarget) closePrepViewer(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && document.getElementById("prep-viewer-overlay").classList.contains("open")) closePrepViewer(); });
