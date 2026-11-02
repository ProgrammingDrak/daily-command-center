const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture(nav = {}, standalone = false) {
  const listeners = {};
  const elements = new Map();
  for (const id of ["dcc-install", "dcc-settings-wrap", "dcc-settings-button", "dcc-settings-menu"]) {
    elements.set(id, { classList: { remove() {} }, setAttribute() {}, addEventListener(name, fn) { this[name] = fn; } });
  }
  const views = [];
  const media = [];
  const window = {
    addEventListener(name, fn) { listeners[name] = fn; },
    matchMedia() { const mode = { matches: standalone, addEventListener(name, fn) { this[name] = fn; } }; media.push(mode); return mode; },
    DCC: { overlay: { open(view) { views.push(view); return { close(reason) { views.push(reason); view.onClose(); }, update(next) { views.push(next); } }; } } }
  };
  vm.runInNewContext(fs.readFileSync("public/js/install-guidance.js", "utf8"), {
    window, document: { getElementById: (id) => elements.get(id) },
    navigator: { userAgent: "Chrome", platform: "Linux", maxTouchPoints: 0, ...nav }
  });
  return { listeners, views, media, button: elements.get("dcc-install") };
}

test("Apple guide supports iPhone and desktop-identifying iPad, with no automatic dialog", async () => {
  for (const nav of [{ userAgent: "iPhone Safari" }, { userAgent: "Macintosh Safari", platform: "MacIntel", maxTouchPoints: 5 }]) {
    const f = fixture(nav);
    assert.equal(f.views.length, 0);
    await f.button.click();
    assert.match(f.views[0].title, /Home Screen/);
    assert.match(f.views[0].body, /Share.*Add to Home Screen.*Open as Web App.*Add/s);
    f.views[0].onClose();
    await f.button.click();
    assert.equal(f.views.length, 2);
  }
});

test("Apple non-Safari and embedded browsers route to an external browser", async () => {
  for (const userAgent of ["iPhone CriOS Safari", "iPad Safari Slack"]) {
    const f = fixture({ userAgent });
    await f.button.click();
    assert.match(f.views[0].body, /address in Safari first/);
  }
  const f = fixture({ userAgent: "Android wv)" });
  await f.button.click();
  assert.match(f.views[0].title, /your browser/);
});

test("native events are user initiated, single use, and accepted does not claim installed", async () => {
  for (const outcome of ["accepted", "dismissed"]) {
    const f = fixture();
    let calls = 0;
    let prevented = false;
    f.listeners.beforeinstallprompt({ preventDefault() { prevented = true; }, async prompt() { calls++; }, userChoice: Promise.resolve({ outcome }) });
    assert.ok(prevented);
    assert.equal(calls, 0);
    await f.button.click();
    assert.equal(calls, 1);
    assert.equal(f.button.textContent, "Install DCC");
    assert.match(f.views[0].body, outcome === "accepted" ? /request accepted/ : /dismissed/);
    await f.button.click();
    assert.equal(calls, 1);
  }
});

test("prompt rejection recovers, and duplicate clicks cannot invoke it twice", async () => {
  const f = fixture();
  let reject;
  let calls = 0;
  f.listeners.beforeinstallprompt({ preventDefault() {}, prompt() { calls++; return new Promise((resolve, fail) => { reject = fail; }); } });
  const pending = f.button.click();
  assert.equal(f.button.disabled, true);
  await f.button.click();
  reject(new Error("unavailable"));
  await pending;
  assert.equal(calls, 1);
  assert.equal(f.button.disabled, false);
  assert.match(f.views[0].body, /couldn’t open/);
});

test("installed events and display modes show installed state; back closes without history writes", async () => {
  for (const f of [fixture({}, true), fixture({ standalone: true })]) {
    await f.button.click();
    assert.equal(f.views[0].title, "DCC is installed");
  }
  const f = fixture();
  await f.button.click();
  f.listeners.appinstalled();
  assert.equal(f.button.textContent, "DCC is installed");
  assert.equal(f.views[1].title, "DCC is installed");
  f.listeners.popstate();
  assert.equal(f.views[2], "navigation");
});
