---
name: ingest-mycelium-journal-image
description: Transcribe one uploaded handwritten journal image and store it as a source-backed Mycelium journal entry. Use when the user asks Codex to read, ingest, archive, or save a handwritten journal page in Mycelium with the original image, highlights, and visibly marked uncertain passages.
---

# Ingest a Mycelium journal image

Process exactly one handwritten journal image through the source-preserving pilot.

1. Inspect the original image at sufficient detail.
2. Transcribe it faithfully. Preserve paragraph breaks. Use `[unclear]` instead of guessing.
3. Classify it as a journal capture and assign confidence from 0 through 1. Do not use this pilot for a non-journal image.
4. Extract up to five concise highlights. List every uncertain passage separately in `lowConfidence`.
5. Prepare a JSON payload:

```json
{
  "title": "Optional title",
  "date": "YYYY-MM-DD",
  "classification": "journal",
  "confidence": 0.94,
  "classificationRationale": "Brief reason",
  "transcript": "Full faithful transcription",
  "highlights": ["One evidence-backed highlight"],
  "lowConfidence": ["Exact uncertain passage and why it is uncertain"]
}
```

6. Use `scripts/ingest.js` with the image path and payload file. Run `--dry-run` first when validating a new environment. Production requires `DCC_PA_TOKEN` or `SECRET_PA_TOKEN`; local development can use `DCC_BASE_URL=http://localhost:8090` without a token.
7. Send the write only when the user asked to store or ingest the page. Report the returned Mycelium slug, whether the entry was created or deduplicated, and whether low classification confidence caused an inbox fallback.

The endpoint preserves the original, writes the transcript sidecar, and links highlights and uncertain passages to the source image. Confidence below `0.7` files the capture to `inbox/` as `fleeting`. Never present that fallback as a completed journal entry.
