const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("./public/js/onboarding-tour.js"), "utf8");
const clerkImport = 'import("/vendor/drake-auth/browser.js")';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({ dccLogout, loadAuth }) {
  let clickHandler = null;
  let href = "/";
  const calls = [];
  const signOut = {
    addEventListener(type, handler) {
      if (type === "click") clickHandler = handler;
    },
  };
  const location = {};
  Object.defineProperty(location, "href", {
    get: () => href,
    set: (value) => { href = value; },
  });
  const document = {
    readyState: "complete",
    body: { classList: { add() {}, remove() {} } },
    getElementById(id) { return id === "dcc-sign-out" ? signOut : null; },
    addEventListener() {},
  };
  const window = {
    location,
    addEventListener() {},
  };
  const instrumented = source.replace(clerkImport, "__loadDrakeAuth()")
    .replace(/\}\)\(\);\s*$/, "window.__logoutTestSourceLoaded = true;})();");

  const context = vm.createContext({
    window,
    document,
    console,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    fetch(url, options) {
      calls.push({ type: "dcc", url, options });
      return dccLogout();
    },
    __loadDrakeAuth() {
      calls.push({ type: "load-clerk" });
      return loadAuth(calls);
    },
  });
  vm.runInContext(instrumented, context, { filename: "onboarding-tour.js" });
  assert.equal(window.__logoutTestSourceLoaded, true);
  assert.equal(typeof clickHandler, "function", "the real sign-out button must be bound");

  return {
    calls,
    click: () => clickHandler(),
    href: () => href,
  };
}

test("sign out clears DCC and Clerk sessions before redirecting", async () => {
  const dcc = deferred();
  const clerk = deferred();
  const harness = createHarness({
    dccLogout: () => dcc.promise,
    loadAuth: async (calls) => ({
      clerkSignOut() {
        calls.push({ type: "clerk-sign-out" });
        return clerk.promise;
      },
    }),
  });

  const signOut = harness.click();
  await Promise.resolve();
  assert.deepEqual(harness.calls.map((call) => call.type), ["dcc", "load-clerk", "clerk-sign-out"]);
  assert.equal(harness.calls[0].url, "/api/auth/logout");
  assert.equal(harness.calls[0].options.method, "POST");
  assert.equal(harness.href(), "/", "navigation must wait for both sessions");

  dcc.resolve({ ok: true });
  await Promise.resolve();
  assert.equal(harness.href(), "/", "Clerk must finish before navigation");

  clerk.resolve();
  await signOut;
  assert.equal(harness.href(), "/login");
});

test("credential logout still redirects when Clerk has no active session", async () => {
  const harness = createHarness({
    dccLogout: async () => ({ ok: true }),
    loadAuth: async (calls) => ({
      async clerkSignOut() { calls.push({ type: "clerk-sign-out" }); },
    }),
  });

  await harness.click();
  assert.equal(harness.calls.filter((call) => call.type === "dcc").length, 1);
  assert.equal(harness.href(), "/login");
});
