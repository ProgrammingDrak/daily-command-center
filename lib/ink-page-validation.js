// Server-side validation for the open Ink stroke format (public/js/ink/strokes.js).
// The client parser is intentionally forgiving for recovery. The server is not.
// Shared by the vault notebook ingest and private journal task pages so the two
// durable stores accept exactly the same page shape.
const InkStrokes = require("../public/js/ink/strokes.js");

const INK_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const INK_PAGE_MAX_POINTS = 500000;

// Reject hostile or corrupt stroke JSON before it becomes the durable source.
function validateInkPage(page) {
  if (!page || page.v !== 1 || !Number.isFinite(page.w) || !Number.isFinite(page.h)
      || page.w < 1 || page.h < 1 || page.w > 10000 || page.h > 10000
      || !Array.isArray(page.strokes)) {
    throw new Error("ink must match the version 1 stroke format");
  }
  if (page.paper != null && (!page.paper || typeof page.paper !== "object"
      || !InkStrokes.PAPERS.some(p => p.id === page.paper.type)
      || !Object.prototype.hasOwnProperty.call(InkStrokes.TINTS, page.paper.tint)
      || !Number.isFinite(page.paper.spacing) || page.paper.spacing < InkStrokes.PAPER_SPACING.min || page.paper.spacing > InkStrokes.PAPER_SPACING.max
      || typeof page.paper.margin !== "boolean")) {
    throw new Error("ink contains invalid paper settings");
  }
  let points = 0;
  for (const stroke of page.strokes) {
    if (!stroke || !Object.prototype.hasOwnProperty.call(InkStrokes.TOOLS, stroke.tool)
        || !/^#[0-9a-f]{3,8}$/i.test(String(stroke.color || ""))
        || !Number.isFinite(stroke.size) || stroke.size <= 0 || stroke.size > 200
        || !Array.isArray(stroke.pts) || stroke.pts.length < 3 || stroke.pts.length % 3 !== 0) {
      throw new Error("ink contains an invalid stroke");
    }
    if (stroke.style != null && (!stroke.style || stroke.style.v !== 2
        || !Number.isFinite(stroke.style.angle) || stroke.style.angle < InkStrokes.NIB_ANGLE.min || stroke.style.angle > InkStrokes.NIB_ANGLE.max)) {
      throw new Error("ink contains invalid nib settings");
    }
    points += stroke.pts.length / 3;
    if (points > INK_PAGE_MAX_POINTS) throw new Error("ink contains too many points");
    for (let i = 0; i < stroke.pts.length; i += 3) {
      const x = stroke.pts[i]; const y = stroke.pts[i + 1]; const pressure = stroke.pts[i + 2];
      if (![x, y, pressure].every(Number.isFinite)
          || x < -page.w || x > page.w * 2 || y < -page.h || y > page.h * 2
          || pressure < 0 || pressure > 1) {
        throw new Error("ink contains an invalid point");
      }
    }
  }
  return page;
}

// Buffer entry point used by multipart uploads.
function validateInkBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("ink strokes required");
  if (buffer.length > INK_PAGE_MAX_BYTES) throw new Error("ink stroke file is too large");
  let page;
  try { page = JSON.parse(buffer.toString("utf8")); }
  catch { throw new Error("ink must contain valid JSON"); }
  return validateInkPage(page);
}

module.exports = { INK_PAGE_MAX_BYTES, INK_PAGE_MAX_POINTS, validateInkPage, validateInkBuffer };
