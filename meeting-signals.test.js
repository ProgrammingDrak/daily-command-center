const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseExplicitSignal,
  createMeetingSignalReader,
} = require("./meeting-signals");

test("explicit signal parser supports inline and marker-only forms", () => {
  assert.deepEqual(parseExplicitSignal("Action Item: Send Rachel the brief"), {
    phrase: "action item", taskText: "Send Rachel the brief", excerpt: "Action Item: Send Rachel the brief",
  });
  assert.deepEqual(parseExplicitSignal("sweep task"), {
    phrase: "sweep task", taskText: "", excerpt: "sweep task",
  });
  assert.equal(parseExplicitSignal("We discussed an action item yesterday"), null);
});

function readerFixture({ spaces, messagesBySpace, membershipName = "users/123", auth = {} }) {
  const calls = [];
  const chat = {
    spaces: {
      list: async args => { calls.push(["spaces.list", args]); return { data: { spaces } }; },
      members: {
        get: async args => { calls.push(["members.get", args]); return { data: { member: { name: membershipName } } }; },
      },
      messages: {
        list: async args => { calls.push(["messages.list", args]); return { data: { messages: messagesBySpace[args.parent] || [] } }; },
      },
    },
  };
  const reader = createMeetingSignalReader({
    googleApi: { chat: () => chat },
    authModule: {
      WORK_ACCOUNT_KEY: "work", WORK_ACCOUNT_EMAIL: "drake@example.com",
      normalizeAccountKey: key => key || "default",
      getAuthClient: async () => auth,
    },
  });
  return { reader, calls };
}

const MEETING = {
  title: "Investor planning", start: "2026-08-14T13:00:00Z", end: "2026-08-14T13:30:00Z",
  account_key: "work", account_email: "drake@example.com",
};

test("reader returns only the connected user's explicit messages in the meeting window", async () => {
  const { reader } = readerFixture({
    spaces: [{ name: "spaces/a", displayName: "Investor planning", spaceType: "GROUP_CHAT", spaceThreadingState: "UNTHREADED_MESSAGES", lastActiveTime: "2026-08-14T13:10:00Z" }],
    messagesBySpace: { "spaces/a": [
      { name: "messages/0", sender: { name: "users/999" }, createTime: "2026-08-14T13:04:30Z", text: "Can you send the deck after this?" },
      { name: "messages/1", sender: { name: "users/123" }, createTime: "2026-08-14T13:05:00Z", text: "Action item: Send the deck" },
      { name: "messages/2", sender: { name: "users/999" }, createTime: "2026-08-14T13:05:10Z", text: "Action item: Ignore another sender" },
      { name: "messages/3", sender: { name: "users/123" }, createTime: "2026-08-14T13:05:20Z", text: "ordinary chat" },
    ] },
  });
  const result = await reader.readSignals({ userId: 1, meeting: MEETING, prefixes: ["action item"] });
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].taskText, "Send the deck");
  assert.equal(result.signals[0].source, "google_chat");
  assert.deepEqual(result.signals[0].context, [{
    at: "2026-08-14T13:04:30Z", speaker: "participant", excerpt: "Can you send the deck after this?",
  }, {
    at: "2026-08-14T13:05:10Z", speaker: "participant", excerpt: "Action item: Ignore another sender",
  }, {
    at: "2026-08-14T13:05:20Z", speaker: "drake", excerpt: "ordinary chat",
  }]);
});

test("reader refuses ambiguous signal-bearing spaces and degrades when OAuth is absent", async () => {
  const fixture = readerFixture({
    spaces: [
      { name: "spaces/a", displayName: "General", spaceThreadingState: "UNTHREADED_MESSAGES" },
      { name: "spaces/b", displayName: "Other", spaceThreadingState: "UNTHREADED_MESSAGES" },
    ],
    messagesBySpace: {
      "spaces/a": [{ sender: { name: "users/123" }, createTime: "2026-08-14T13:05:00Z", text: "Action item: One" }],
      "spaces/b": [{ sender: { name: "users/123" }, createTime: "2026-08-14T13:06:00Z", text: "Action item: Two" }],
    },
  });
  const ambiguous = await fixture.reader.readSignals({ userId: 1, meeting: MEETING });
  assert.equal(ambiguous.signals.length, 0);
  assert.equal(ambiguous.diagnostics.some(item => item.code === "ambiguous_chat_space"), true);

  const noAuthReader = createMeetingSignalReader({
    googleApi: { chat: () => { throw new Error("should not instantiate"); } },
    authModule: {
      WORK_ACCOUNT_KEY: "work", WORK_ACCOUNT_EMAIL: "drake@example.com",
      normalizeAccountKey: key => key,
      getAuthClient: async () => null,
    },
  });
  const unavailable = await noAuthReader.readSignals({ userId: 1, meeting: MEETING });
  assert.deepEqual(unavailable.signals, []);
  assert.equal(unavailable.diagnostics[0].code, "google_reconnect_required");
});

test("reader asks for reconnect before calling Chat when stored OAuth scopes are stale", async () => {
  let clientCalls = 0;
  const reader = createMeetingSignalReader({
    googleApi: { chat: () => { throw new Error("should not instantiate"); } },
    authModule: {
      WORK_ACCOUNT_KEY: "work", WORK_ACCOUNT_EMAIL: "drake@example.com",
      normalizeAccountKey: key => key,
      loadAccountTokens: async () => ({ scope: "calendar" }),
      hasAllScopes: () => false,
      getAuthClient: async () => { clientCalls += 1; return {}; },
    },
  });
  const result = await reader.readSignals({ userId: 1, meeting: MEETING });
  assert.equal(result.diagnostics[0].code, "google_reconnect_required");
  assert.equal(clientCalls, 0);
});

test("reader queries group conversations and two-person direct meeting chats", async () => {
  const fixture = readerFixture({ spaces: [], messagesBySpace: {} });
  await fixture.reader.readSignals({ userId: 1, meeting: MEETING });
  const listArgs = fixture.calls.find(call => call[0] === "spaces.list")[1];
  assert.equal(listArgs.filter, 'spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"');
});

test("reader rejects an unbounded meeting window", async () => {
  const fixture = readerFixture({ spaces: [], messagesBySpace: {} });
  const result = await fixture.reader.readSignals({ userId: 1, meeting: {
    ...MEETING,
    end: "2026-08-16T13:30:00Z",
  } });
  assert.equal(result.diagnostics[0].code, "invalid_meeting_window");
  assert.equal(fixture.calls.length, 0);
});

test("reader rejects an account email that conflicts with the configured OAuth account", async () => {
  const reader = createMeetingSignalReader({
    googleApi: { chat: () => { throw new Error("should not instantiate"); } },
    authModule: {
      WORK_ACCOUNT_KEY: "work", WORK_ACCOUNT_EMAIL: "drake@example.com",
      normalizeAccountKey: key => key,
      accountEmailFor: () => "drake@example.com",
      getAuthClient: async () => ({}),
    },
  });
  const result = await reader.readSignals({ userId: 1, meeting: {
    ...MEETING,
    account_email: "someone-else@example.com",
  } });
  assert.equal(result.diagnostics[0].code, "account_email_mismatch");
});
