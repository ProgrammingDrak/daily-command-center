---
name: dcc-integration
description: Use DCC's direct account integration to reconcile explicit chat completion, meaningful progress with a linked next iteration, and morning or evening review choices. Diagnose connection and save status through the supported contract.
---

# DCC integration

Read [the integration runbook](../../../docs/dcc-integration-runbook.md) for the current implementation, setup state, contracts and recovery examples. It is the maintained reference; do not infer live availability from this skill being installed.

- Use the connected account's DCC tools when present. A browser session, password CLI profile and remote OAuth connection are distinct. Discover actual tools; stop a blocked connection step without acquiring new credentials or substituting a shared service token.
- A clear report of finished work authorizes reconciling its matching task. Search/read canonical identity, current revision and task version first. Ask a narrow task/occurrence choice if ambiguous. Do not mutate based on a title guess, ended timer/calendar event or assistant background status.
- Meaningful progress may close a work **iteration**: record what got done and the concise remaining work in a linked next task. Keep the overall goal and parent/recurrence lineage intact. An entire phase need not be complete. Tiny updates do not automatically create tasks; unclear remaining scope needs a choice.
- At existing morning/evening reviews, use `dcc_completion_review` and offer Done, Still working, Drop it, or Progress made → next iteration. Unanswered choices remain open. This skill adds no notification schedule.
- Preserve the source-message command envelope for exact retry. Confirm only `verified_saved`; distinguish reported, pending, uncertain, superseded/conflicted, and access failure. Use `dcc_reconciliation_receipt` to verify both iteration records, including after a lost response. Undo references the original source event and refuses later edits.

Implementation/test permission does not authorize production deployment, OAuth configuration changes, additional account consent, or completing live tasks merely because they appear in a static document. Follow any explicit task-specific authorization for real writes, with one designated writer.

- Review queue placement using the runbook's Working Queue policy: one human Foreground; explicit attention/check-backs in Needs You; inactive unfinished work in ordered Priority; Background only with fresh, bounded host execution evidence. An open chat or “Still working” answer does not establish worker liveness. Use `queue-return` for the safe supported return when available; never remove/recreate tasks to change lanes. Stop/blocked/unknown reports must be honest and preserve history. Do not add polling or notification schedules.
