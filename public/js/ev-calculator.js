(function(){
  function $(id){ return document.getElementById(id); }
  function money(value){ return "$" + (Number(value) || 0).toFixed(2); }
  function pct(value){ return value == null ? "n/a" : ((Number(value) || 0) * 100).toFixed(1) + "%"; }

  function outcomeRow(label, probability, value){
    const row = document.createElement("div");
    row.className = "ev-outcome-row";
    row.innerHTML =
      '<input class="ev-outcome-label" type="text" value="' + label + '" aria-label="Outcome label">' +
      '<input class="ev-outcome-prob" type="number" min="0" max="100" step="1" value="' + probability + '" aria-label="Probability percent">' +
      '<input class="ev-outcome-value" type="number" step="1" value="' + value + '" aria-label="Outcome value">' +
      '<button class="ev-remove-outcome" type="button" title="Remove outcome">x</button>';
    row.querySelector(".ev-remove-outcome").addEventListener("click", () => row.remove());
    return row;
  }

  function collectPayload(){
    const outcomes = Array.from(document.querySelectorAll(".ev-outcome-row")).map(row => ({
      label: row.querySelector(".ev-outcome-label").value || "Outcome",
      probability: Number(row.querySelector(".ev-outcome-prob").value || 0) / 100,
      value: Number(row.querySelector(".ev-outcome-value").value || 0)
    }));
    return {
      category: $("ev-category").value,
      time_hours: Number($("ev-time").value || 0),
      energy: Number($("ev-energy").value || 0),
      attention: Number($("ev-attention").value || 0),
      money_usd: Number($("ev-money").value || 0),
      outcomes
    };
  }

  async function calculate(){
    const resultEl = $("ev-result");
    if(!resultEl) return;
    resultEl.textContent = "Calculating...";
    try{
      const res = await fetch("/api/evaluation/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectPayload())
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Evaluation failed");
      renderResult(data);
    }catch(e){
      resultEl.innerHTML = '<div class="ev-error">' + String(e.message || e).replace(/[<>&]/g, "") + '</div>';
    }
  }

  function renderResult(data){
    const resultEl = $("ev-result");
    if(!resultEl) return;
    const warnings = (data.warnings || []).map(w => '<li>' + w + '</li>').join("");
    resultEl.innerHTML =
      '<div class="ev-result-grid">' +
        '<div><span>EV</span><strong>' + money(data.ev) + '</strong></div>' +
        '<div><span>Input cost</span><strong>' + money(data.inputCost) + '</strong></div>' +
        '<div><span>Net EV</span><strong class="' + (data.netEv >= 0 ? "positive" : "negative") + '">' + money(data.netEv) + '</strong></div>' +
        '<div><span>ROI</span><strong>' + pct(data.roi) + '</strong></div>' +
        '<div><span>EV/hour</span><strong>' + (data.evPerHour == null ? "n/a" : money(data.evPerHour)) + '</strong></div>' +
      '</div>' +
      (warnings ? '<ul class="ev-warnings">' + warnings + '</ul>' : '<div class="ev-ok">No warnings.</div>');
  }

  function init(){
    const root = $("ev-calculator");
    if(!root) return;
    const outcomes = $("ev-outcomes");
    if(outcomes && !outcomes.children.length){
      outcomes.appendChild(outcomeRow("Good outcome", 60, 4));
      outcomes.appendChild(outcomeRow("Miss", 40, 0));
    }
    const add = $("ev-add-outcome");
    if(add) add.addEventListener("click", () => outcomes.appendChild(outcomeRow("Outcome", 10, 1)));
    const calc = $("ev-calculate");
    if(calc) calc.addEventListener("click", calculate);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
