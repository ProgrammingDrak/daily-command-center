// Shared route/date helpers used across route modules.
// NOTE: addMinutesHHMM is the historical 'winning' definition (server.js had two;
// function hoisting meant this later one was in effect file-wide).

function coerceDateString(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function isValidDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }

function addMinutesHHMM(hhmm, mins) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const total = Math.min(24 * 60, (h * 60 + m) + Math.max(0, mins));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}

// `route` wraps the common handler shape: run a store call, send result as JSON,
// map thrown errors to statusCode (or 500). `intParam` parses a numeric path param.
const intParam = (req, name) => parseInt(req.params[name], 10);
const route = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    if (!res.headersSent) res.status(e.statusCode || 500).json({ error: e.message });
  }
};

module.exports = { coerceDateString, isValidDate, addMinutesHHMM, intParam, route };
