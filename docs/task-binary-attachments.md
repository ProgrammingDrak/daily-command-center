# Private task binary attachments

Local branch: `feature/task-binary-attachments`, based on upstream `b126acc` (PR402).

## Audit

PR397 (`65e791d`) already shipped source references, Notes attachment pills, safe external-link validation and Whenever task parity. Its description explicitly excluded durable binary uploads. Main checkout was still `f845ad6`; this isolated worktree uses upstream main instead. Existing worktrees were inventoried; none implemented binary task attachments. Open PR403 implements collaboration and Invite Links; private task Notes/files are deliberately outside those roles and exports. No shared checkout changes, production writes, deployment, push, or live provisioning occurred.

## Implementation

Metadata lives in additive PostgreSQL `task_attachments`, independent of client-editable block properties. Bytes use a **dedicated private S3-compatible bucket** through the existing AWS SDK. The app proxies validated uploads and downloads; it does not mint client grants, expose keys, return public URLs or extend Vault/media access. This adapts the Private Document Uploads pattern's owner namespace and protected-parent reader, using server-mediated upload instead of a presigned PUT so size and content checks occur before storage.

Every operation requires an established app cookie session, the actual workspace owner and a live parent task in that workspace. Headers, service-token identity and development owner fallbacks do not authorize files. Shared task visibility, collaboration invitation roles and workspace membership confer no file access. Missing/foreign/deleted tasks return 404. Authorization repeats inside each metadata transaction and before multipart buffering. Downloads hold the task lock while retrieving bytes. Mutations require a custom same-origin header and reject cross-site origins.

Files are associated with the persisted block ID. Current rescheduling/Whenever moves preserve that ID. Task deletion makes files inaccessible; normal parent undo re-enables access. Repeating definitions and newly created task copies do not inherit attachments implicitly.

Accepted: PDF, PNG, JPEG, WebP, UTF-8 `.txt`, `.md` and `.csv`. Image/document signatures and extension must agree; declared MIME cannot contradict detected contents. This is format identification, not malware scanning or a full document decoder. HTML, SVG, executables, archives, Office documents and arbitrary binary types are refused. Downloads are always attachment/application-octet-stream with no-sniff, sandbox CSP and private/no-store caching. Integrity is checked against stored length and SHA256 before delivery; the client shows missing/auth/network errors without navigating away from Notes.

Limits: 10 MiB/file, 20 active or pending files/task, 200 total records and 200 MiB/account including retained removals. Transfers are bounded to two per owner and eight per application process. User-row locks serialize quotas across the owner's workspaces. Names are sanitized; object keys contain only a validated numeric owner, hashed workspace/task segments and a server-validated UUID. Every read validates the stored key again.

A committed pending reservation precedes object upload. Failed puts or crashes retain a quota-counted key rather than creating untracked objects. Retry uses the same UUID and SHA256; a lost success response returns the ready record. Replacing bytes on an existing identity is refused. Pending records are visible only to the owner and can be removed; reselecting the same named/sized file after reopening retries its reservation. Concurrent retries converge to one metadata record and object key.

Notes modal, drawer and completion editor share file controls. Multi-file uploads proceed sequentially, preserve successes, show progress and provide Retry. Image paste and file drag/drop use the same route. Binary transfers are an explicitly online feature: unsuccessful selected bytes stay in the open view only, and the UI states this. They are not serialized into JSON, source references, data URLs or the existing block WAL. After reopening, pending server reservations can be retried by reselecting their original local files. Account changes stop stale controls; all successes reload from authorized metadata.

Removal is a tombstone, not physical object erasure. It disables reads, is idempotent, survives old upload retries and offers persistent Undo removal. Originals and failed reservations remain counted. No purge job, object delete permission or automatic retention clock has been introduced.

## Infrastructure decisions still requiring Drake

Approve/select the dedicated **private** bucket/provider, billing and limited server credentials before activation. Required environment names:

- `DCC_ATTACHMENT_ENDPOINT`
- `DCC_ATTACHMENT_BUCKET`
- `DCC_ATTACHMENT_ACCESS_KEY_ID`
- `DCC_ATTACHMENT_SECRET_ACCESS_KEY`
- Optional `DCC_ATTACHMENT_REGION` (default `auto`)

Credentials need PutObject/GetObject only for the `task-attachments/` prefix; no ACL, public-read, bucket provisioning or DeleteObject is needed. Configure provider-side public-access blocking and avoid independent expiry/overwrite of active originals. No browser CORS setup is needed because all transfers use DCC's authenticated server. These are configuration requirements; no such grants or credentials were created or changed. Vault and other apps' credentials are never reused. Until configured, uploads answer 503 with an explicit message.

Approve the additive schema migration and release separately. `pg-schema.js` includes the table idempotently on the normal startup path; **do not deploy this branch before migration/release approval**. Metadata foreign keys intentionally avoid cascading deletion. Define backup/retention/purge policy and operational alerting for failed reservations before increasing quotas or adding permanent erasure. No active attachments should be expired solely because a task is old. Current local behavior retains all originals until an explicit future purge implementation/policy is approved.

## Local verification

Run ordinary tests with Node20. PostgreSQL and browser checks use a dedicated disposable localhost fixture database and an in-memory object store; they never read `DATABASE_URL` or `.env`:

```sh
DCC_ATTACHMENT_TEST_DATABASE_URL=postgresql://<local-fixture-user>@localhost:<unique-fixture-port>/postgres node --test task-attachment-policy.test.js task-attachment-postgres.test.js
DCC_ATTACHMENT_TEST_DATABASE_URL=postgresql://<local-fixture-user>@localhost:<unique-fixture-port>/postgres node scripts/verify-task-attachments.cjs
```

The fixture builds its own random schema and drops only that schema. No production service or storage is contacted. The browser harness opens ephemeral localhost ports at 1280px and 390px. It covers partial failure/retry, metadata reload, removal/undo, pasted image bytes, exact downloaded bytes, offline failure/retry, stale-account protection, keyboard access and mobile overflow. Owner, workspace and stored-key guards were mutation checked: removing each made its negative acceptance tests fail, then the guards were restored.

Real provider credentials, bucket privacy/grants and live storage availability remain unverified pending approved infrastructure. There is no claim of production activation.

### Verified result on this branch

- Final complete Node20 regression suite: **2,891 passed, 8 skipped, 0 failed** (2,899 total).
- Targeted policy/real-SDK/route/PostgreSQL run: **15 passed, 0 failed, 0 skipped**.
- Synthetic browser: both 1280px and 390px workflows passed.
- Owner, workspace and key guard mutation checks: all three mutations killed.
- ESLint for the new/changed attachment modules and harnesses: no errors; diff whitespace check clean.

The earlier full run's one unrelated Vault LFS failure used a fixed 60ms wait during concurrent machine load. `vault-b3.test.js` passed all 23 checks on an isolated rerun; the final full suite then passed at two-file concurrency. The original source-reference browser harness had a stale pre-PR401 Notes boundary; it was updated to the current Notes tab boundary and a scoped type selector to exercise the intended surface.
