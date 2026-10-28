// Transport-neutral adapter. The host supplies an already authorized MCP caller
// and durable connection-scoped journal; this installs no hooks or credentials.
const M = require("./conversation-model");
function codingIdentity({ source, repository, worktreeId, codingTaskId }) {
  for (const [k, v] of Object.entries({ source, repository, worktreeId, codingTaskId })) M.text(v, k, 240);
  return {
    source,
    kind: "coding",
    id: "coding:" + M.digest({ repository, worktreeId, codingTaskId }),
    repository,
    worktreeId,
    codingTaskId
  };
}
function createReporter({ callTool, journal, connectionId }) {
  M.text(connectionId, "connection identity", 240);
  if (typeof callTool !== "function" || !["load", "save", "clear"].every((k) => typeof journal?.[k] === "function"))
    throw new Error("Provide an authorized transport and durable pending journal");
  async function call(name, args) {
    const result = await callTool(name, args);
    if (result?.isError)
      throw new Error(result.content?.find((c) => c.type === "text")?.text || "Delegated work command was rejected");
    return result?.structuredContent || result;
  }
  let tail = Promise.resolve();
  async function report(input) {
    const fingerprint = M.digest(input),
      key = "delegated:" + M.digest({ connectionId, work: input.delegation?.work });
    let pending = await journal.load(key);
    if (pending && pending.fingerprint !== fingerprint)
      throw new Error("Resolve the pending lifecycle event before reporting another milestone");
    if (!pending) {
      const state = await call("dcc_working_queue", {});
      const command = M.command({ ...input, expectedRevision: state.revision });
      pending = { fingerprint, command };
      await journal.save(key, pending);
    }
    // Unknown outcomes keep this exact event, timestamp and revision for reload.
    const result = await call("dcc_delegate", pending.command);
    if (result?.ok !== true) throw new Error("No successful lifecycle acknowledgement; pending event retained");
    await journal.clear(key);
    return result;
  }
  return {
    report(input) {
      const request = structuredClone(input);
      const run = tail.then(() => report(request));
      tail = run.catch(() => {});
      return run;
    }
  };
}
module.exports = { codingIdentity, createReporter };
