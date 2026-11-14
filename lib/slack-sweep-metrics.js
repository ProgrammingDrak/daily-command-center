"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

const context = new AsyncLocalStorage();
const wrapped = new WeakSet();

function measureQueries(target) {
  if (wrapped.has(target)) return;
  wrapped.add(target);
  const query = target.query;
  target.query = function (...args) {
    const active = context.getStore();
    if (!active) return query.apply(this, args);
    const { totals, phase } = active;
    const counters = [totals.database, ...phase.map(name => totals[name])];
    for (const counter of counters) counter.queries += 1;
    const record = result => {
      for (const page of Array.isArray(result) ? result : [result]) {
        for (const row of page?.rows || []) {
          const bytes = Buffer.byteLength(JSON.stringify(row));
          for (const counter of counters) {
            counter.rows += 1;
            counter.estimatedResultBytes += bytes;
          }
        }
      }
      return result;
    };
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const callback = args[last];
      args[last] = (error, result) => callback(error, error ? result : record(result));
      return query.apply(this, args);
    }
    return Promise.resolve(query.apply(this, args)).then(record);
  };
}

function instrumentPool(pool) {
  if (wrapped.has(pool)) return;
  if (typeof pool.on === "function" && typeof pool.connect === "function") {
    // Acquire also covers clients that were already connected at mount time.
    wrapped.add(pool);
    pool.on("acquire", measureQueries);
  } else {
    measureQueries(pool);
  }
}

function withSweepMetrics(run) {
  const counter = () => ({ queries: 0, rows: 0, estimatedResultBytes: 0 });
  const totals = {
    database: counter(), lookup: counter(), waiting: counter(), mirror: counter(),
    keys: 0, projections: 0, slackWrites: 0, retries: 0, rateLimited: 0,
    settled: 0, ineligible: 0, unreachable: 0, cooldown: 0, saturatedHistory: 0,
  };
  return context.run({ totals, phase: [] }, async () => ({ ...(await run()), metrics: totals }));
}

function phase(name, run) {
  const active = context.getStore();
  return active ? context.run({ ...active, phase: [...new Set([...active.phase, name])] }, run) : run();
}

function count(key, amount = 1) {
  const active = context.getStore();
  if (active) active.totals[key] += amount;
}

module.exports = { instrumentPool, withSweepMetrics, phase, count };
