# DCC release backup policy

On 2026-10-29 the owner removed the mandatory fresh-production-backup prerequisite
for Daily Command Center releases, including Priority Queue PR440. This is the
ongoing DCC policy, superseding older DCC release documentation that requires a
backup. It does not apply to unrelated projects.

Backups remain optional. Keep existing backups and `npm run backup` available.
No PostgreSQL backup client was installed and no fresh backup was taken for PR440.
Recovery from an unexpected data issue may therefore be harder.

Database changes still require review and the existing deployment-risk acknowledgment.
`[db-ok]`, `[migration-ok]`, and the workflow dispatch acknowledgment mean the changes
and their data effects were reviewed; none asserts that a backup was taken.
Tests, required reviews, branch protections, deployment checks, and exact deployed-SHA
verification remain in force. This policy grants no new credentials, access, sharing,
provider-plan changes, or permission to delete backups.
