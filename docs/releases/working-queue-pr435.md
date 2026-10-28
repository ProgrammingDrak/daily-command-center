# Working Queue PR435 release decision

On 2026-10-28 the account owner explicitly waived the production-backup requirement for PR435 and directed deployment after normal review and checks. This waiver applies only to this release. No current backup is claimed.

The supported commit-level database-risk acknowledgement (`[db-ok]`) may record this specific decision in PR435's eventual merge commit. Do not use the workflow input whose wording asserts that a pg_dump was taken. No workflow, branch rule, review requirement or default backup policy is changed.

The release still requires current-main reconciliation, exact-candidate tests, release-lane ownership, and exact deployed-SHA verification. Preserve PR437's queued deployment and its viewport fixes. The separately gated foreground unique index still requires the duplicate-clock audit; do not alter active tasks or choose a winning clock automatically. Enable the common coordinator only after that index is verified. Leave remote OAuth disabled until its separate approved connection setup is complete.

This waiver does not approve credential creation, broader permissions, OAuth grants, installed assistant hooks, or live task records as QA fixtures. Report provider/access blocks and incomplete activation explicitly.
