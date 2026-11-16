const policy = require("./task-attachment-policy");

// ChatGPT file parameters are signed URLs. Accept the documented file host
// only. Never follow redirects or forward DCC credentials to the download.
async function readChatFile(file, filename, fetchFile = fetch) {
  if (
    !file ||
    typeof file.file_id !== "string" ||
    !file.file_id ||
    file.file_id.length > 256 ||
    typeof file.download_url !== "string" ||
    file.download_url.length > 8192
  )
    throw policy.fail("Select a file through ChatGPT");
  let url;
  try {
    url = new URL(file.download_url);
  } catch {
    throw policy.fail("Invalid ChatGPT file URL");
  }
  if (url.origin !== "https://files.oaiusercontent.com" || url.username || url.password)
    throw policy.fail("This file host is unsupported. Use the task's Notes attachment uploader.", 422);
  filename ||= file.file_name;
  if (
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.length > 180 ||
    (file.mime_type !== undefined && typeof file.mime_type !== "string")
  )
    throw policy.fail("Provide the file name, including extension");
  const response = await fetchFile(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw policy.fail("ChatGPT file could not be downloaded. Select it again.", 422);
  if (Number(response.headers.get("content-length")) > policy.MAX_BYTES) {
    await response.body.cancel();
    throw policy.fail("Files must be 10 MB or smaller", 413);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > policy.MAX_BYTES) throw policy.fail("Files must be 10 MB or smaller", 413);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  return {
    bytes,
    meta: policy.validateFile({ buffer: bytes, originalname: filename, mimetype: file.mime_type })
  };
}
module.exports = { readChatFile };
