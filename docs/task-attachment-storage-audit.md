# Task/note attachment storage audit and approval scope

Read-only audit on 2026-10-08. No secret values or credentials were read; no grants, buckets, billing settings, migrations or deployments were created or changed by this investigation.

## Existing configuration

- Railway metadata confirms DCC belongs to existing **Productivity Based Apps** project (`23c46a4d-ad8a-4d06-8df5-e936c6b9f4a3`). Project bucket count is **zero**; production DCC has no volume mounts. This rules out a native bucket/volume already attached there, not an external provider.
- Local `.env` and `.env.example` name-only inspection found `DATABASE_URL`, but no `DCC_ATTACHMENT_*`, S3 or R2 names. Railway variable listing exposes values, so it was deliberately not run. External production storage variables remain unverified; local absence is not proof of production absence.
- Existing meeting/Vault code references `MYCELIUM_R2_*`, `MEETING_AUDIO_R2_BUCKET` and warm-media storage. Historical Mycelium planning restricts warm R2 to album/video derivatives and specifies ten-year locked Glacier cold storage. These are different content/retention domains, not authorization to store DCC originals. Historical plans do not establish current live bucket existence. Audio expiry is unsuitable for permanent attachments.
- Existing `scripts/db-backup.sh` backs up PostgreSQL metadata, not object bytes. No existing attachment-object backup is verified.

There is **no verified reusable private bucket plus authorized credential pair**. An existing external configuration could change that finding only after a safe name-only production check and confirmation of its intended scope. Do not reuse another app's credentials by inference.

## Proposed choice

Use a dedicated private Railway bucket in the existing project, proposed display name **dcc-private-attachments**. This avoids a new third-party account but still requires approval for a new billable resource and its credentials. Use separate development/test resources; current tests continue using synthetic local storage.

Railway provides private S3 buckets with per-bucket credentials; use the actual generated `BUCKET`, not its display name. New buckets use virtual-hosted addressing. Current documented storage pricing is **$0.015/GB-month**, with free S3 operations/bucket egress; application-proxied transfers incur service egress. Versioning, object lock and lifecycle configuration are currently unsupported. [Railway bucket documentation](https://docs.railway.com/storage-buckets)

Service network egress is currently **$0.05/GB**, plus existing plan/compute usage. At the local 200 MiB account cap, stored originals alone are approximately $0.003/account-month; repeated downloads and more accounts increase usage. This estimate excludes backups and account plan costs. [Railway pricing](https://docs.railway.com/pricing)

## Exact new access/configuration requested before activation

1. Approve creating one private bucket in that project and accepting its usage charges; no public sharing or browser CORS grant.
2. Authorize supplying that bucket's server credential references to **DCC only**. Application operations are `PutObject` and `GetObject` on `task-attachments/*`. No application use of object deletion/listing, ACLs or bucket administration. Railway's generated credential grant must be reviewed: per-bucket isolation does not prove an exact Get/Put-only or prefix-only policy. If that policy is mandatory, choose a provider that enforces it or add a scoped temporary credential provider; do not promise it from ordinary bucket credentials.
3. Configure these references without posting credential values in chat:

| DCC environment variable | Bucket value/config |
| --- | --- |
| `DCC_ATTACHMENT_ENDPOINT` | `ENDPOINT` |
| `DCC_ATTACHMENT_BUCKET` | `BUCKET` |
| `DCC_ATTACHMENT_ACCESS_KEY_ID` | `ACCESS_KEY_ID` |
| `DCC_ATTACHMENT_SECRET_ACCESS_KEY` | `SECRET_ACCESS_KEY` |
| `DCC_ATTACHMENT_REGION` | `REGION` |
| `DCC_ATTACHMENT_FORCE_PATH_STYLE` | `0` for new Railway buckets |

4. Separately approve additive database migration and release. None has been performed.

## Retention and backup decision

Current behavior retains originals indefinitely under quota, including removed files and pending reservations. Removal disables download and allows persistent Undo; parent deletion also disables access. No automatic expiry or physical erasure is implemented. Decide whether permanent erasure is required and how long recovery must remain possible before adding a purge policy or DeleteObject capability.

Recommend an approved, encrypted independent object backup paired with PostgreSQL metadata and a restore test before activation. Define recovery window/frequency/destination/cost first. No new backup account or credentials are authorized by this proposal. Provider durability and metadata-only dumps are insufficient evidence of recoverable attachment bytes; independent accidental-deletion recovery remains unverified. [R2 durability explanation](https://developers.cloudflare.com/r2/reference/durability/)

## Alternative

A dedicated private **R2 Standard** bucket is viable if an existing approved Cloudflare account/billing relationship is confirmed. No such authorization was verified here. Standard currently has $0.015/GB-month storage with an account-shared free allowance and operation charges beyond free allowances; free egress does not eliminate DCC service egress. Avoid Infrequent Access for this small interactive feature. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

R2's bucket-scoped Object Read & Write token is narrower than account administration but includes broader object operations; it is not an exact Get/Put-only grant. Action/prefix-restricted temporary credentials need a refresh integration not implemented here. No provider-admin grant is needed in DCC runtime. [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/), [temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

## Coverage

Both task Notes and independent Quick/Sticky Notes now support binary files through the same owner-authorized storage, quotas, retry, safe download and removal/undo flow. File-only notes survive cleanup. HTTP note aliases, current/legacy note blocks, forbidden owner/workspace reads and parent deletion are covered by fixture tests. Desktop/mobile tests exercise both task and independent note workflows. Live provider connectivity/privacy/grant granularity remain unverified pending approval.
