// The glasses bookmark launches the canonical app. Keep explicit task links
// readable in the existing compact page until full DCC supports those links.
module.exports = function glassesLaunch(req, res, next) {
  if (typeof req.query.task === "string" && req.query.task.trim()) return next();
  const queryStart = req.originalUrl.indexOf("?");
  const search = queryStart < 0 ? "" : req.originalUrl.slice(queryStart);
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, "/" + search);
};
