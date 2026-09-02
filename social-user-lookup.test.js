// The user lookup behind "add a friend" and "give access" (routes/social-todo.js).
//
// This one endpoint is the only way one person can name another in this app:
// there is no directory and no search, by design. That makes its resolver the
// whole story, and two properties of it are worth pinning:
//
//   - It must accept an EMAIL. A Google-signed-in account never picked a
//     username -- auth.js derives one from the email address -- so the person
//     being added often cannot say what their own handle is. Username-only
//     lookup made those accounts unaddressable.
//   - It must NEVER echo the email back. The route is session-gated but any
//     signed-in user can call it, so returning the address would turn a
//     username into an email-harvesting oracle.
//
// Harness: mount the real route module against a recording `app` and a stub ctx,
// with `route` as the identity function, so the handler under test is the
// shipped closure rather than a copy of it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const USERS = [
  // A password signup: username, no email.
  { id: 1, username: "drake", email: null, password_hash: "x" },
  // A Google sign-in: the username was derived from the email.
  { id: 4, username: "collins-okoye", email: "collins.okoye@movewithclever.com" },
  // The collision that decides precedence: this person's EMAIL is somebody
  // else's username.
  { id: 7, username: "seraphina121", email: "drake@example.com" }
];

// Same precedence as auth.findUserByLogin: exact username first, then email.
function findUserByLogin(identifier) {
  const value = String(identifier || "").trim();
  return USERS.find(u => u.username === value)
    || USERS.find(u => (u.email || "").toLowerCase() === value.toLowerCase())
    || null;
}

function mountLookup() {
  const handlers = new Map();
  const record = (verb) => (path, ...rest) => handlers.set(verb + " " + path, rest[rest.length - 1]);
  const app = { get: record("GET"), post: record("POST"), patch: record("PATCH"), delete: record("DELETE"), put: record("PUT") };
  const err = (code) => (msg) => { const e = new Error(msg); e.statusCode = code; return e; };
  require("./routes/social-todo.js")(app, {
    auth: { findUserByLogin: async (v) => findUserByLogin(v) },
    badRequest: err(400),
    notFound: err(404),
    route: (fn) => fn,
    crypto: require("node:crypto"),
    path: require("node:path")
  });
  const handler = handlers.get("GET /api/social/users/lookup");
  assert.ok(handler, "the lookup route was not mounted -- the harness is testing nothing");
  return handler;
}

const lookup = mountLookup();
const call = (query) => lookup({ query, session: { userId: 1 } }, { status: () => ({ json: () => {} }) });

test("lookup resolves an exact username", async () => {
  assert.deepEqual(await call({ q: "drake" }), { id: 1, username: "drake" });
});

test("lookup resolves an exact email to that person's handle", async () => {
  // The point of the whole change: a Google account is addressable by the only
  // string its owner actually knows.
  assert.deepEqual(await call({ q: "collins.okoye@movewithclever.com" }),
    { id: 4, username: "collins-okoye" });
});

test("a username beats an email that spells the same string", async () => {
  // "drake" is user 1's username and the local part of user 7's address. The
  // resolver must not hand a friend request or an access grant to user 7.
  assert.equal((await call({ q: "drake" })).id, 1);
});

test("nobody can register an email-shaped username to intercept lookups", async () => {
  // Precedence is only safe because a username cannot CONTAIN an address.
  // registerUser's charset is what enforces that, and Google sign-ins are
  // slugified through the same alphabet, so this reads the rule at its source
  // rather than trusting it.
  const src = require("node:fs").readFileSync(require.resolve("./auth.js"), "utf8");
  const charset = src.match(/\/\^\[([^\]]+)\]\{3,30\}\$\//);
  assert.ok(charset, "auth.js username charset moved -- re-check the precedence argument");
  assert.ok(!charset[1].includes("@"), "an @ in a username would let one person shadow another's email");
});

test("the old ?username= caller still works", async () => {
  // public/js/social.js now sends ?q=, but a stale cached bundle sends the old
  // name. Dropping it would break "add a friend" for anyone mid-deploy.
  assert.deepEqual(await call({ username: "drake" }), { id: 1, username: "drake" });
});

test("the response carries the handle and the id, and nothing else", async () => {
  const found = await call({ q: "collins.okoye@movewithclever.com" });
  assert.deepEqual(Object.keys(found).sort(), ["id", "username"]);
});

test("an empty identifier is a 400, not a lookup of everybody", async () => {
  await assert.rejects(() => call({ q: "   " }), e => e.statusCode === 400);
  await assert.rejects(() => call({}), e => e.statusCode === 400);
});

test("an unknown identifier is a 404", async () => {
  await assert.rejects(() => call({ q: "nobody@example.com" }), e => e.statusCode === 404);
});

test("a partial match is not a match -- this is not a directory", async () => {
  // Exactness is the privacy property: no prefix walking a name or an address.
  await assert.rejects(() => call({ q: "drak" }), e => e.statusCode === 404);
  await assert.rejects(() => call({ q: "collins" }), e => e.statusCode === 404);
});

test("the Social tab shows the viewer's handle and labels email lookup honestly", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const client = fs.readFileSync(require.resolve("./public/js/social.js"), "utf8");

  assert.match(html, /id="social-you-name"/);
  assert.match(html, /id="social-you-copy"/);
  assert.match(html, /id="social-lookup-input"[^>]*placeholder="Username or email"/);
  assert.match(client, /api\("\/api\/me"\)/);
  assert.match(client, /navigator\.clipboard\.writeText\(myUsername\)/);
  assert.match(client, /lookup\?q=" \+ encodeURIComponent\(identifier\)/);
  assert.match(client, /Enter a username or email\./);
  assert.match(client, /Copy blocked here\. Your username is /);
});
