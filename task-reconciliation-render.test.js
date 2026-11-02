const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const payload = '<img src=x onerror="window.__xss=1">\nnext & final';
const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function fixture() {
  const boards = new Map();
  const element = () => ({
    innerHTML: "",
    dataset: {},
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() {
      return { addEventListener() {}, dataset: {} };
    },
    appendChild(el) {
      this.children.push(el);
    }
  });
  const ctx = vm.createContext({
    window: {},
    document: {
      createElement: element,
      getElementById: (id) => {
        if (!boards.has(id)) boards.set(id, element());
        return boards.get(id);
      }
    },
    escHtml: escape,
    cfg: () => ({ tag: "Task", cls: "task", color: "#fff" }),
    srcTag: () => "",
    ms: () => "",
    notesButton: () => "",
    _scheduleTaskHasDelegate: () => false,
    loadSubtasks: () => ({ "next-step": [{}] }),
    getLinkedTrivialTasks: () => []
  });
  return { ctx, boards };
}
test("remaining-work summaries remain plain text in actual itinerary and library renderers", () => {
  const { ctx, boards } = fixture();
  vm.runInContext(fs.readFileSync("public/js/itinerary-card.js", "utf8"), ctx);
  const task = { id: "next-step", type: "task", title: payload, detail: payload };
  const card = ctx.window.renderItineraryCard(task, { pointsChip: () => "" });
  const source = fs.readFileSync("public/js/schedule-tab.js", "utf8");
  vm.runInContext(
    source.slice(source.indexOf("function buildUnscheduledSuggestions(){"), source.indexOf("// PIN 10.A:")),
    ctx
  );
  ctx.consider = [task];
  ctx.backlog = [task];
  ctx.buildUnscheduledSuggestions();
  ctx.buildBacklog();
  for (const rendered of [card, ...boards.get("suggestions-board").children, ...boards.get("backlog-board").children]) {
    assert.ok(!rendered.innerHTML.includes("<img src=x"), "untrusted task text must not become markup");
    assert.ok(
      rendered.innerHTML.includes(escape(payload).replace(/\n/g, "<br>")),
      "summary text and line breaks remain readable"
    );
  }
});
