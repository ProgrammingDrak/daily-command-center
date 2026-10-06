# Universal task sources — local implementation

Base: `a66a52f` (PR #395). Branch: `feature/universal-external-sources`.

## Audit and reuse

Task provenance is stored in block JSONB properties (`source_id`, Slack channel/timestamp, triage keys). `taskCommonProps` and `TaskModel.fromBlock` are the canonical serializer/projection. Existing dedupe fields and Slack source identifiers remain verbatim. Notes live in separate owner-task-linked note blocks. Note images previously used FileReader data URLs; those legacy blocks remain readable.

Vault has authenticated media ingestion and readers with its own manifest, sensitivity locks and storage semantics. It is not a task-owner scoped upload system. No Vault access or grants have been expanded. Task writes remain on existing authenticated, workspace-scoped block APIs. Shared exports use their existing explicit field lists; no reference fields were added to public output.

## Implemented contract

`sourceReferences` is an optional array of `{kind,url,name,mime?}`. Supported kinds: Slack, email, image, file, link. Names retain original filenames or user-supplied source descriptions. Optional MIME is display metadata, not a claim that uploaded bytes were validated. Maximum 20 references; name maximum 255 printable characters; URL maximum 4096 characters. Omitted properties preserve existing update semantics; an explicit `[]` clears references. Malformed submitted references are rejected rather than treated as removal. Create, PATCH, batch and the shared database validator enforce the same contract. Existing 100KB property limit still applies. No schema migration is needed for JSONB properties.

Only HTTP/HTTPS external navigation is accepted. Credentials, control characters, local hosts/IP literals, data/blob/file URLs, signed download parameters and known ephemeral OpenAI file endpoints are rejected. General external domains are supported; no server fetch, proxy, image downloader, credentials or SSRF surface was introduced. No remote availability probes occur. Provider sign-in and private-file authorization remain with the original provider. DCC neither grants access nor stores private file bytes.

The Notes tab renders a shared rail plus an attach-link form. Notes drawer and completion Notes use the same renderer. Legacy source identity is displayed once and cannot be removed by reference deletion. Invalid stored references show unavailable and can be removed. Remove affects only references; original files are retained. Existing `operations` before/after history records ordinary task updates and tombstones preserve properties. No object deletion or retention policy was added. Queue writes are serialized against current row properties. Buffered saves explicitly report local pending sync.

Task Notes reject new file-to-data-URL paste uploads; they explain using a stable original link instead. Other editor consumers retain their existing behavior. Existing inline images are not migrated or deleted. Pasted external images continue through the editor's stable-URL gate; linked attachments added via the form are the canonical typed provenance references.

## Validation

244 targeted Node tests passed. URL and batch guards were mutation-checked: disabling each caused its acceptance test to fail, then originals were restored. Syntax and diff whitespace checks passed.

Synthetic Node tests cover multi-source serialization/projection, Slack identity/dedupe, hostile URLs, private provider links, temporary file URLs, metadata/count/duplicate validation, clear/omit behavior, database and batch guards, queued failure recovery, pending WAL retention/replay and existing sharing paths.

`node scripts/verify-task-sources.cjs` exercises actual Notes form and renderer code in headless Chrome, using only in-memory synthetic stores, at 1280px and 390px. It verifies attachment/removal, failed save feedback, Slack field preservation, blocked file paste, keyboard links, 44px targets, no horizontal overflow and no browser exceptions. Set `CHROME_PATH` for another local Chrome executable. Screenshots are written to `/tmp/dcc-sources-1280.png` and `/tmp/dcc-sources-390.png`.

Real private provider authentication and revoked/missing remote files are intentionally not fetched or exercised against user accounts; opening the source delegates those states to the provider. Invalid stored links are locally tested as unavailable. No production task writes or external upload tests were performed.

## Remaining decision: durable task uploads

Durable uploaded originals need a task-owner/workspace-scoped private object namespace and authenticated reader authorized through the parent task. Choose storage and provision grants before enabling uploads. Reusing Vault's content hashes and media access directly would incorrectly couple task permissions to Vault permissions. A task upload implementation must validate MIME against bytes, sanitize filenames, limit size/count, retain partial successes, prevent cross-owner/traversal references, enforce task reader access and define retention separately from removing a reference. This branch adds no upload endpoint, storage credentials or buckets. Upload size/type limits and reader-auth tests remain pending that decision; uploads are not represented as implemented.

No push, merge, deploy, task creation or production mutation was performed.
