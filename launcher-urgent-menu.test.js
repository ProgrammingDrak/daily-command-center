const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeClassList {
  constructor(){ this.values = new Set(); }
  add(value){ this.values.add(value); }
  remove(value){ this.values.delete(value); }
  contains(value){ return this.values.has(value); }
  toggle(value, force){
    const next = force === undefined ? !this.values.has(value) : Boolean(force);
    if(next) this.values.add(value); else this.values.delete(value);
    return next;
  }
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
    ["urgent", "done", "schedule", "backlog", "whenever", "anytime", "habit", "meeting", "workout", "meal"]
  );
  assert.equal(launcherBar.parts.destination.style.display, "");

  for(const destination of launcherBar.parts.destination.options.map(option => option.value)){
    launcherBar.parts.title.value = "Create " + destination;
    launcherBar.parts.destination.value = destination;
    launcherBar.parts.add.emit("click", {stopPropagation(){}});
  }

  assert.deepEqual(submissions.map(item => item.destination),
    ["urgent", "done", "schedule", "backlog", "whenever", "anytime", "habit", "meeting", "workout", "meal"]);
  assert.equal(radialCalls.length, 0, "launcher Add must not reopen the full destination radial");
});

test("launcher markup starts on Urgent without changing other add bars", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const launcher = html.match(/<div class="task-add-bar" id="task-add-launcher">([\s\S]*?)<\/div>/)[1];
  const sticky = html.match(/<div class="task-add-bar" id="task-add-sticky"[\s\S]*?<\/div>/)[0];
  assert.deepEqual(Array.from(launcher.matchAll(/<option value="([^"]+)"/g), match => match[1]),
    ["15", "30", "45", "60", "90", "120", "urgent", "schedule", "backlog"]);
  assert.match(sticky, /option value="schedule"/);
  assert.match(sticky, /option value="backlog"/);
  assert.doesNotMatch(sticky, /option value="(?:shell|wrap)"/);
  assert.match(launcher, /<select class="tab-dest" aria-label="Task type or destination">/);
});

test("launcher quick radial contains only Habit and Meeting and only changes selection", () => {
  const loaded = loadDestinationSection();
  const {context, launcherBar, submissions, radialCalls} = loaded;
  context.openLauncherTaskTypeRadial(new FakeElement());
  assert.equal(radialCalls.length, 1);
  const call = radialCalls[0];
  assert.deepEqual(Array.from(call.items, item => item.label), ["Habit", "Meeting"]);
  assert.equal(call.options.backdrop, false);

  call.items[0].onPick();
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
  assert.equal(radialCalls[0].items.length, 10);
  assert.notEqual(radialCalls[0].options.backdrop, false);
});

test("Anytime destination opens the configured creation form", () => {
  const source = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
  const start = source.indexOf("function addTaskUniversal(barEl){");
  const end = source.indexOf("// ======== SCHEDULE-AT PICKER", start);
  assert.notEqual(start, -1, "addTaskUniversal start moved");
  assert.notEqual(end, -1, "addTaskUniversal end moved");
  const fnSource = source.slice(start, end);
  const opened = [];
  const title = new FakeElement(); title.value = "Drink water";
  const duration = new FakeElement(); duration.value = "30";
  const destination = new FakeElement(); destination.value = "anytime";
  const add = new FakeElement();
  const bar = {
    querySelector: selector => ({
      ".tab-title": title, ".tab-dur": duration,
      ".tab-dest": destination, ".tab-add": add
    })[selector] || null
  };
  const DCC = {AnytimeDock: {openCreate: value => opened.push(value)}};
  const context = {window: {DCC}, DCC, parseInt};
  vm.createContext(context);
  vm.runInContext(fnSource, context);
  context.addTaskUniversal(bar);
  assert.deepEqual(opened, ["Drink water"]);
  assert.equal(title.value, "");
  assert.equal(destination.value, "urgent");

  const mutated = fnSource.replace('case"anytime"', 'case"removed-anytime"');
  const brokenOpened = [];
  const brokenDCC = {AnytimeDock: {openCreate: value => brokenOpened.push(value)}};
  const broken = {window: {DCC: brokenDCC}, DCC: brokenDCC, parseInt};
  vm.createContext(broken);
  vm.runInContext(mutated, broken);
  title.value = "Drink water";
  destination.value = "anytime";
  broken.addTaskUniversal(bar);
  assert.deepEqual(brokenOpened, [], "mutation must prove the destination guard can fail");
});

function loadLauncher(){
  const source = fs.readFileSync(require.resolve("./public/js/launcher.js"), "utf8");
  const launcher = new FakeElement();
  launcher.querySelectorAll = () => [];
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

test("quick tap opens one composer and preserves its selected destination", () => {
  const loaded = loadLauncher();
  loaded.bar.parts.destination.value = "meeting";
  loaded.button.emit("click", {detail: 1});
  assert.equal(loaded.compose.classList.contains("open"), true);
  assert.equal(loaded.bar.parts.destination.value, "meeting");
  assert.equal(loaded.bar.parts.title.focused, true);
  assert.equal(loaded.quickRadialOpens(), 0);

  loaded.button.emit("click", {detail: 1});
  assert.equal(loaded.compose.classList.contains("open"), false);
  assert.equal(loaded.button.focused, true);
});

test("keyboard activation opens the launcher and Escape closes it with focus restored", () => {
  const loaded = loadLauncher();
  loaded.button.emit("click", {detail: 0});
  assert.equal(loaded.compose.classList.contains("open"), true);
  loaded.button.focused = false;
  loaded.emitDocument("keydown", {key: "Escape", preventDefault(){}});
  assert.equal(loaded.compose.classList.contains("open"), false);
  assert.equal(loaded.button.focused, true);

  loaded.button.emit("click", {detail: 0});
  assert.equal(loaded.compose.classList.contains("open"), true, "direct assistive click still activates the launcher");
});

test("press and hold has no hidden second launcher mode", () => {
  const loaded = loadLauncher();
  loaded.button.emit("pointerdown", {button: 0, pointerId: 1, clientX: 10, clientY: 10});
  assert.equal(loaded.holdTimers.length, 0);
  assert.equal(loaded.utilityRadial.classList.contains("open"), false);
  assert.equal(loaded.quickRadialOpens(), 0);
});

test("a successful or deferred submission closes the launcher", () => {
  const loaded = loadLauncher();
  loaded.button.emit("click", {detail: 1});
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

test("Whenever destination drops the task into the no-set-time pool", () => {
  const source = fs.readFileSync(require.resolve("./public/js/schedule.js"), "utf8");
  const start = source.indexOf("function addTaskUniversal(barEl){");
  const end = source.indexOf("// ======== SCHEDULE-AT PICKER", start);
  assert.notEqual(start, -1, "addTaskUniversal start moved");
  assert.notEqual(end, -1, "addTaskUniversal end moved");
  const fnSource = source.slice(start, end);
  const run = (src) => {
    const added = [], toasts = [];
    const title = new FakeElement(); title.value = "Grab the mail";
    const duration = new FakeElement(); duration.value = "15";
    const destination = new FakeElement(); destination.value = "whenever";
    const bar = {
      querySelector: selector => ({
        ".tab-title": title, ".tab-dur": duration,
        ".tab-dest": destination, ".tab-add": new FakeElement()
      })[selector] || null
    };
    const DCC = {Whenever: {LABEL: "Whenever"}};
    const context = {
      window: {DCC}, DCC, parseInt,
      addWheneverTask: (t, d) => { added.push([t, d]); return {id: "wh-1"}; },
      showToast: msg => toasts.push(msg)
    };
    vm.createContext(context);
    vm.runInContext(src, context);
    context.addTaskUniversal(bar);
    return {added, toasts, title, destination};
  };
  const ok = run(fnSource);
  assert.deepEqual(ok.added, [["Grab the mail", 15]]);
  assert.deepEqual(ok.toasts, ["Added to Whenever"]);
  assert.equal(ok.title.value, "", "the title clears like every non-schedule destination");
  assert.equal(ok.destination.value, "urgent", "the type snaps back to Urgent");

  const broken = run(fnSource.replace('case"whenever"', 'case"removed-whenever"'));
  assert.deepEqual(broken.added, [], "mutation must prove the destination guard can fail");
});

function loadActivityAdd(type, titleValue = "Evening run") {
  const source=fs.readFileSync(require.resolve("./public/js/schedule.js"),"utf8");
  const start=source.indexOf("function addTaskUniversal(barEl){"), end=source.indexOf("// ======== SCHEDULE-AT PICKER",start);
  const bar=makeAddBar("task-add-launcher"), opened=[], events=[], toasts=[];
  bar.parts.title.value=titleValue; bar.parts.duration.value="90"; bar.parts.destination.value=type;
  bar.addEventListener("dcc:launcher-handoff",()=>events.push("handoff"));
  const DCC={Activity:{create:(...args)=>opened.push(args)}};
  class Event {constructor(type){this.type=type;}}
  const context={window:{DCC},DCC,Event,showToast:(...args)=>toasts.push(args)};
  vm.createContext(context); vm.runInContext(source.slice(start,end),context);
  return {bar,opened,events,toasts,context};
}

test("Workout and Meal handoff preserve duration and draft until confirmed creation", () => {
  for(const type of ["workout","meal"]){
    const {bar,opened,events,context}=loadActivityAdd(type);
    assert.equal(context.addTaskUniversal(bar),false,"deferred dialog is not a successful save");
    assert.equal(opened[0][0],type); assert.equal(opened[0][2],"Evening run");
    assert.equal(opened[0][3].durationMinutes,90); assert.deepEqual(events,["handoff"]);
    assert.equal(bar.parts.title.value,"Evening run"); assert.equal(bar.parts.destination.value,type);
    // Cancel or failure does not call onCreated: reopening retains the original draft.
    opened[0][3].onCreated();
    assert.equal(bar.parts.title.value,""); assert.equal(bar.parts.destination.value,"urgent");
    assert.equal(bar.parts.duration.value,"90");
  }
});

test("activity shortcuts allow a type title and unavailable logger preserves input", () => {
  const blank=loadActivityAdd("meal",""); blank.context.addTaskUniversal(blank.bar);
  assert.equal(blank.opened[0][2],"Meal");
  const loaded=loadActivityAdd("workout"); loaded.context.window.DCC.Activity=null;
  assert.equal(loaded.context.addTaskUniversal(loaded.bar),false);
  assert.equal(loaded.bar.parts.title.value,"Evening run"); assert.equal(loaded.bar.parts.destination.value,"workout");
  assert.equal(loaded.events.length,0); assert.equal(loaded.toasts.length,1);
});

test("launcher handoff releases modal state without taking focus back", () => {
  const loaded=loadLauncher(); loaded.button.emit("click",{});
  loaded.button.focused=false; loaded.bar.dispatchEvent({type:"dcc:launcher-handoff"});
  assert.equal(loaded.compose.classList.contains("open"),false); assert.equal(loaded.button.focused,false);
});
