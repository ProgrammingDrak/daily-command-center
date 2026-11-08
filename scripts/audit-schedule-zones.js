const fs = require("node:fs");
const { inspect, validZone } = require("../public/js/schedule-zones");

function migrate(blocks, { mode, zone, approved = [] }) {
  const ids = new Set(approved);
  const counts = {};
  const review = [];
  const output = blocks.map(block => {
    if (block.type !== "block" || block.deleted_at) return block;
    const p = block.properties || {};
    if (mode === "rollback") {
      if (p.scheduleInstant?.source !== "reviewed-legacy-v1") return block;
      const properties = { ...p };
      delete properties.scheduleInstant;
      counts.removed = (counts.removed || 0) + 1;
      return { ...block, properties };
    }
    const result = inspect(block, zone);
    counts[result.status] = (counts[result.status] || 0) + 1;
    if (!["legacy-schedule", "date-only", "fixed"].includes(result.status)) {
      review.push({ id: block.id, date: block.date, start: p.start, reason: result.status });
    }
    if (mode !== "apply" || !ids.has(block.id) || p.scheduleInstant || result.status !== "legacy-schedule") return block;
    counts.added = (counts.added || 0) + 1;
    return {
      ...block,
      properties: {
        ...p,
        scheduleInstant: {
          source: "reviewed-legacy-v1", timeZone: zone, date: block.date,
          start: p.start, end: p.end || null, startAt: new Date(result.instant).toISOString(),
        },
      },
    };
  });
  return { report: { assumedLegacyZone: zone, counts, review }, blocks: output };
}

if (require.main === module) {
  const [file, zone, mode = "audit", reviewFile] = process.argv.slice(2);
  if (!file || !validZone(zone) || !["audit", "apply", "rollback"].includes(mode) || (mode === "apply" && !reviewFile)) {
    console.error("Usage: node scripts/audit-schedule-zones.js <blocks.json> <legacy IANA zone> [audit|apply|rollback] [approved-ids.json]");
    process.exitCode = 1;
  } else {
    const blocks = JSON.parse(fs.readFileSync(file, "utf8"));
    const approved = reviewFile ? JSON.parse(fs.readFileSync(reviewFile, "utf8")) : [];
    const result = migrate(blocks, { mode, zone, approved });
    console.log(JSON.stringify(mode === "audit" ? result.report : result.blocks, null, 2));
  }
}

module.exports = { migrate };
