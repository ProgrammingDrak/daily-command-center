const fs = require("node:fs");
const path = require("node:path");
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "migrations/012_research_ideas.sql"), "utf8");
module.exports = { SCHEMA_SQL };
