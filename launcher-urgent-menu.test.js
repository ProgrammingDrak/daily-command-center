const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeClassList {
  constructor(){ this.values = new Set(); }
  add(value){ this.values.add(value); }
  remove(value){ this.values.delete(value); }
  contains(value){ return this.values.has(value); }
}

class FakeElement {
  constructor(){
    this.listeners = {};
    this.classList = new FakeClassList();
    this.attributes = {};
    this.dataset = {};
    this.style = {
      display: "",
      removeProperty: property => { if(property === "display") this.style.display = ""; }
    };
    this.value = "";
  }
  addEventListener(type, listener){ (this.listeners[type] ||= []).push(listener); }
  emit(type, event = {}){ (this.listeners[type] || []).forEach(listener => listener(event)); }
  dispatchEvent(event){ this.emit(event.type, event); return true; }
  setAttribute(name, value){ this.attributes[name] = value; }
  focus(){ this.focused = true; }
}

function makeSelect(initial = "urgent"){
  const select = new FakeElement();
  select.value = initial;
  select.options = [{value: "urgent", textContent: "Urgent"}];
  select.querySelector = selector => {
    const match = selector.match(/option\[value="([^"]+)"\]/);
    return match ? select.options.find(option => option.value === match[1]) || null : null;
  };
  select.appendChild = option => select.options.push(option);
  select.dispatchEvent = event => select.emit(event.type, event);
  return select;
}

function makeAddBar(id){
  const bar = new FakeElement();
  bar.id = id;
  const title = new FakeElement();
  const duration = new FakeElement();
  const destination = makeSelect();
  const add = new FakeElement();
  title.value = "";
  duration.value = "30";
  bar.parts = {title, duration, destination, add};
  bar.querySelector = selector => ({
    ".tab-title": title,
    ".tab-dur": duration,
    ".tab-dest": destination,
    ".tab-add": add
  })[selector] || null;
  return bar;
}

function loadDestinationSection(){
  const source = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
  const start = source.indexOf("// ======== TASK DESTINATIONS");
  const end = source.indexOf("// ======== UNIFIED BLOCK QUERY HELPERS");
  const section = source.slice(start, end);
  const launcherBar = makeAddBar("task-add-launcher");
  const regularBar = makeAddBar("task-add-regular");
  const submissions = [];
  let successfulSubmissions = 0;
  const radialCalls = [];
  let radialCloses = 0;
  const document = {
    querySelectorAll: selector => selector === ".task-add-bar" ? [launcherBar, regularBar] : [],
    querySelector: () => null,
    getElementById: id => id === "task-add-launcher" ? launcherBar : null,
    createElement: () => ({value: "", textContent: ""})
  };
  class FakeEvent { constructor(type, init){ this.type = type; this.bubbles = !!(init && init.bubbles); } }
  const context = {
    window: {}, document, Event: FakeEvent,
    setTimeout: () => 1, clearTimeout: () => {},
    addTaskUniversal: bar => submissions.push({bar, destination: bar.parts.destination.value}),
    openRadialMenu: (anchor, items, options) => radialCalls.push({anchor, items, options}),
    closeRadialMenu: () => { radialCloses++; },
    showRadialMenuPreview: () => {}, hideRadialMenuPreview: () => {}
  };
  vm.createContext(context);
  launcherBar.addEventListener("dcc:launcher-submit-success", () => { successfulSubmissions++; });
  vm.runInContext(section, context);
  return {
    context, launcherBar, regularBar, submissions, radialCalls,
    radialCloses: () => radialCloses,
    successfulSubmissions: () => successfulSubmissions
  };
}

test("launcher shows all task types and submits the visible selection directly", () => {
  const loaded = loadDestinationSection();
  const {launcherBar, submissions, radialCalls} = loaded;
  assert.deepEqual(
    launcherBar.parts.destination.options.map(option => option.value),
    ["urgent", "done", "schedule", "backlog", "shell", "wrap", "habit", "meeting"]
  );
  assert.equal(launcherBar.parts.destination.style.display, "");

  for(const destination of launcherBar.parts.destination.options.map(option => option.value)){
    launcherBar.parts.title.value = "Create " + destination;
    launcherBar.parts.destination.value = destination;
    launcherBar.parts.add.emit("click", {stopPropagation(){}});
  }

  assert.deepEqual(submissions.map(item => item.destination),
    ["urgent", "done", "schedule", "backlog", "shell", "wrap", "habit", "meeting"]);
  assert.equal(radialCalls.length, 0, "launcher Add must not reopen the full destination radial");
});

test("launcher markup starts on Urgent without changing other add bars", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const launcher = html.match(/<div class="task-add-bar" id="task-add-launcher">([\s\S]*?)<\/div>/)[1];
  const sticky = html.match(/<div class="task-add-bar" id="task-add-sticky"[\s\S]*?<\/div>/)[0];
  assert.deepEqual(Array.from(launcher.matchAll(/<option value="([^"]+)"/g), match => match[1]),
    ["15", "30", "45", "60", "90", "120", "urgent"]);
  assert.match(sticky, /option value="schedule"/);
  assert.match(sticky, /option value="backlog"/);
  assert.match(sticky, /option value="shell"/);
  assert.match(launcher, /<select class="tab-dest" aria-label="Task type">/);
});

test("launcher quick radial contains only Wrap, Habit, and Meeting and only changes selection", () => {
  const loaded = loadDestinationSection();
  const {context, launcherBar, submissions, radialCalls} = loaded;
  context.openLauncherTaskTypeRadial(new FakeElement());
  assert.equal(radialCalls.length, 1);
  const call = radialCalls[0];
  assert.deepEqual(Array.from(call.items, item => item.label), ["Wrap", "Habit", "Meeting"]);
  assert.equal(call.options.backdrop, false);

  call.items[1].onPick();
  assert.equal(launcherBar.parts.destination.value, "habit");
  assert.equal(launcherBar.parts.title.focused, true);
  assert.equal(submissions.length, 0, "picking a quick type must not submit the task");
});

test("regular add bars retain the full modal destination radial", () => {
  const loaded = loadDestinationSection();
  const {regularBar, radialCalls} = loaded;
  assert.equal(regularBar.parts.destination.style.display, "none");
  regularBar.parts.title.value = "Regular task";
  regularBar.parts.add.emit("click", {stopPropagation(){}});
  assert.equal(radialCalls.length, 1);
  assert.equal(radialCalls[0].items.length, 8);
  assert.notEqual(radialCalls[0].options.backdrop, false);
});

function loadLauncher(){
  const source = fs.readFileSync(require.resolve("./public/js/launcher.js"), "utf8");
  const launcher = new FakeElement();
  const button = new FakeElement();
  const utilityRadial = new FakeElement();
  const compose = new FakeElement();
  const scrim = new FakeElement();
  const bar = makeAddBar("task-add-launcher");
  const documentListeners = {};
  const elements = {
    "dcc-launcher": launcher,
    "dcc-launcher-btn": button,
    "dcc-radial": utilityRadial,
    "dcc-compose": compose,
    "dcc-scrim": scrim,
    "task-add-launcher": bar
  };
  const holdTimers = [];
  let quickRadialOpens = 0;
  let quickRadialCloses = 0;
  const context = {
    window: {
      openLauncherTaskTypeRadial: () => { quickRadialOpens++; },
      closeRadialMenu: () => { quickRadialCloses++; }
    },
    document: {
      getElementById: id => elements[id] || null,
      querySelector: () => null,
      addEventListener: (type, listener) => { (documentListeners[type] ||= []).push(listener); }
    },
    setTimeout: (callback, delay) => {
      if(delay === 0){ callback(); return 0; }
      holdTimers.push(callback); return holdTimers.length;
    },
    clearTimeout: () => {}
  };
  button.setPointerCapture = () => {};
  button.hasPointerCapture = () => false;
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    button, utilityRadial, compose, scrim, bar, holdTimers,
    emitDocument: (type, event) => (documentListeners[type] || []).forEach(listener => listener(event)),
    quickRadialOpens: () => quickRadialOpens,
    quickRadialCloses: () => quickRadialCloses
  };
}

test("quick tap opens Urgent compose and its quick radial, then toggles both closed", () => {
  const loaded = loadLauncher();
  loaded.bar.parts.destination.value = "meeting";
  loaded.button.emit("pointerup", {});
  loaded.button.emit("click", {detail: 1});
  assert.equal(loaded.compose.classList.contains("open"), true);
  assert.equal(loaded.bar.parts.destination.value, "urgent");
  assert.equal(loaded.bar.parts.title.focused, true);
  assert.equal(loaded.quickRadialOpens(), 1);

  loaded.button.emit("pointerup", {});
  assert.equal(loaded.compose.classList.contains("open"), false);
  assert.equal(loaded.quickRadialCloses(), 1);
});

test("keyboard activation opens the launcher and Escape closes it with focus restored", () => {
  const loaded = loadLauncher();
  let prevented = false;
  loaded.button.emit("keydown", {key: "Enter", repeat: false, preventDefault(){ prevented = true; }});
  assert.equal(loaded.compose.classList.contains("open"), true);
  assert.equal(prevented, true);
  loaded.button.emit("click", {detail: 0});
  assert.equal(loaded.compose.classList.contains("open"), true, "paired keyboard click must not toggle twice");
  loaded.button.emit("keyup", {key: "Enter", preventDefault(){}});
  loaded.button.focused = false;
  loaded.emitDocument("keydown", {key: "Escape"});
  assert.equal(loaded.compose.classList.contains("open"), false);
  assert.equal(loaded.button.focused, true);

  loaded.button.emit("click", {detail: 0});
  assert.equal(loaded.compose.classList.contains("open"), true, "direct assistive click still activates the launcher");
});

test("press and hold still opens the utility radial instead of the task-type fan", () => {
  const loaded = loadLauncher();
  loaded.button.emit("pointerdown", {button: 0, pointerId: 1, clientX: 10, clientY: 10});
  assert.equal(loaded.holdTimers.length, 1);
  loaded.holdTimers[0]();
  assert.equal(loaded.utilityRadial.classList.contains("open"), true);
  assert.equal(loaded.quickRadialOpens(), 0);

  loaded.button.emit("pointerup", {});
  assert.equal(loaded.utilityRadial.classList.contains("open"), true, "release after a hold must not toggle the menu");
});

test("a successful or deferred submission closes the launcher", () => {
  const loaded = loadLauncher();
  loaded.button.emit("pointerup", {});
  loaded.bar.dispatchEvent({type: "dcc:launcher-submit-success"});
  assert.equal(loaded.compose.classList.contains("open"), false);
  assert.equal(loaded.scrim.classList.contains("open"), false);
});

test("blank Add and Enter stay open while valid submissions emit success", () => {
  for (const trigger of ["click", "enter"]){
    const loaded = loadDestinationSection();
    const {launcherBar} = loaded;
    launcherBar.parts.title.value = "   ";
    if (trigger === "click") launcherBar.parts.add.emit("click", {stopPropagation(){}});
    else launcherBar.parts.title.emit("keydown", {key: "Enter", preventDefault(){}});
    assert.equal(loaded.submissions.length, 0);
    assert.equal(loaded.successfulSubmissions(), 0);
    assert.equal(launcherBar.parts.title.classList.contains("tab-error"), true);
    assert.equal(launcherBar.parts.title.focused, true);

    launcherBar.parts.title.value = "A real task";
    if (trigger === "click") launcherBar.parts.add.emit("click", {stopPropagation(){}});
    else launcherBar.parts.title.emit("keydown", {key: "Enter", preventDefault(){}});
    assert.equal(loaded.submissions.length, 1);
    assert.equal(loaded.successfulSubmissions(), 1);
  }
});

test("generic radial supports non-blocking mode without changing its modal default", () => {
  const source = fs.readFileSync(require.resolve("./public/js/radial-menu.js"), "utf8");
  const appended = [];
  const document = {
    body: {appendChild: element => appended.push(element)},
    createElement: () => {
      const element = new FakeElement();
      element.remove = () => {};
      element.innerHTML = "";
      return element;
    },
    querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {}
  };
  const context = {
    window: {innerWidth: 1280, innerHeight: 800}, document,
    requestAnimationFrame: callback => callback()
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const anchor = new FakeElement();
  anchor.getBoundingClientRect = () => ({left: 1100, top: 700, width: 48, height: 48});
  context.openRadialMenu(anchor, [{icon: "⚡", label: "Urgent"}], {backdrop: false});
  assert.equal(appended.some(element => element.className === "dest-radial-backdrop"), false);
  assert.equal(appended.find(element => element.className === "dest-radial-item").attributes["aria-label"], "Urgent");

  appended.length = 0;
  context.openRadialMenu(anchor, [{icon: "⚡", label: "Urgent"}], {});
  assert.equal(appended.some(element => element.className === "dest-radial-backdrop"), true);
});
