// Server-owned private attachment contract; display metadata never authorizes a read.
const crypto = require("node:crypto");
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_OWNER_FILES = 200;
const MAX_OWNER_BYTES = 200 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function filename(raw) {
  // eslint-disable-next-line no-control-regex -- Strip unsafe filename/header controls.
  return String(raw || "attachment").normalize("NFKC").replace(/[\x00-\x1f\x7f/\\<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").slice(0, 180).trim() || "attachment";
}
function validateFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) throw fail("Choose a non-empty file");
  if (file.buffer.length > MAX_BYTES) throw fail("Files must be 10 MB or smaller", 413);
  const b = file.buffer, name = filename(file.originalname);
  const ext = name.split(".").pop().toLowerCase();
  let mime;
  if (ext === "pdf" && b.subarray(0, 5).toString() === "%PDF-") mime = "application/pdf";
  if (ext === "png" && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = "image/png";
  if (["jpg", "jpeg"].includes(ext) && b[0] === 255 && b[1] === 216 && b[2] === 255) mime = "image/jpeg";
  if (ext === "webp" && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") mime = "image/webp";
  if (["txt", "csv", "md"].includes(ext)) {
    const decoded = b.toString("utf8");
    // eslint-disable-next-line no-control-regex -- Binary controls are forbidden in text files.
    if (Buffer.from(decoded, "utf8").equals(b) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) mime = ext === "csv" ? "text/csv" : "text/plain";
  }
  if (!mime) throw fail("Use a PDF, PNG, JPEG, WebP, UTF-8 text, Markdown or CSV file with matching contents", 415);
  const claimed = (file.mimetype || "").toLowerCase();
  if (claimed && ![mime, "application/octet-stream", ...(ext === "md" ? ["text/markdown"] : []), ...(ext === "csv" ? ["application/vnd.ms-excel"] : [])].includes(claimed)) throw fail("File type does not match its contents", 415);
  return { filename: name, mime, size: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") };
}
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
function keyFor(userId, workspaceId, blockId, id) {
  if (!Number.isSafeInteger(userId) || userId < 1 || !UUID.test(id)) throw fail("Invalid attachment identity");
  return `task-attachments/${userId}/${hash(workspaceId)}/${hash(blockId)}/${id.toLowerCase()}`;
}
function assertKey(row, actor) {
  if (row.object_key !== keyFor(actor.userId, actor.workspaceId, row.block_id, row.id)) throw fail("Attachment unavailable", 404);
}
function disposition(name) {
  return `attachment; filename="${filename(name).replace(/[^a-zA-Z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename(name)).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16))}`;
}
module.exports = { MAX_BYTES, MAX_FILES, MAX_OWNER_FILES, MAX_OWNER_BYTES, UUID, fail, filename, validateFile, keyFor, assertKey, disposition };
