module.exports = function retiredTodoShare(req, res, next) {
  const route = req.path.toLowerCase();
  const api = /^\/api\/(?:public\/)?todo-share(?:\/|$)/.test(route);
  const page = /^\/todo(?:\/|$)/.test(route) || route === "/public-todo" || route === "/public-todo.html";
  if (!api && !page) return next();

  res.set("Cache-Control", "no-store");
  const message = "This shared list link has been retired. Ask the owner for a new itinerary link.";
  if (api) return res.status(410).json({ error: message });
  return res.status(410).type("text").send(message);
};
