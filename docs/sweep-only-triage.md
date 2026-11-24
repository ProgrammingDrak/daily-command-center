# Sweep-created Triage tasks

Triage is the intake drawer for new, private, open, unscheduled tasks created by a trusted Gmail or Slack sweep. Manually launching that trusted sweep still counts. A manual task, a source bookmark, a legacy day-state row, or a Daily Brief proposal does not count. Manual subtasks do not inherit sweep origin and are still available in task details and All Tasks. Existing tasks are not relabeled: keep looking for them in All Tasks, on their dates, or in their existing queues. Daily Brief suggestions still require the human decision they always did.

Schedule a Triage task for a date (with or without a time), move it into the Working Queue, complete it, or choose **Dismiss from Triage** to remove it from the drawer without deleting it. An exit is final for that capture. Unscheduling, undoing completion, dismissing twice, or replaying the source will not send it back into Triage. A duplicate source receipt may point at an already existing task without changing its owner edits, notes, or draft; a receipt alone is not proof the task is pending.

## On-demand producer handoff

The supported publisher in this repository is `npm run triage:ingest`. Bring a fresh, minimized finding packet from an approved sweep that actually reviewed the current source thread and relevant sent replies. Use at most ten verified Gmail message/Slack message findings, keep titles and rationale short, and omit private information, restricted channels, credentials, and copied history. The Slack permalink identifies the exact message, and `thread_id` is the actual parent thread timestamp. For Gmail, use the native hex thread and message IDs (not an inferred message ID) and a matching native thread URL. Calendar and repeat sources do not qualify for this lane.

Example with **synthetic identities**, not a publishable real finding. The actual producer sets qualified `reviewed_at` using the time of its fresh source review (accepted for one hour).

```json
{
  "sweep_findings": [
    {
      "source_id": "gmail:aaa331:aaa332",
      "source_ref": "https://mail.google.com/mail/u/0/#all/aaa331",
      "thread_id": "aaa331",
      "title": "Review synthetic example",
      "reason": "The synthetic message requests a decision.",
      "received_at": "2026-11-24T15:10:00Z",
      "reviewed_at": "2026-11-24T15:15:00Z",
      "sensitivity": "ordinary_business"
    }
  ]
}
```

A finding may include a short, unsent `draft_preview`; nothing is sent to Slack or Gmail. For historical `reply_findings` producers the draft remains required and the same dedicated authentication applies. Reserve the capture credential for the reviewed sweep producer. Use `DCC_SWEEP_CAPTURE_TOKEN` (a service token with exact `sweep` scope), or the dedicated deployment `SECRET_SWEEP_SUITE_TOKEN`; inject it from the approved secret store. The server selects `DCC_SERVICE_USER_ID` and `DCC_SERVICE_WORKSPACE_ID` from its own deployment configuration, not request headers. Owner sessions and broad DCC/PA tokens cannot stamp provenance.

1. `npm run triage:ingest -- --base-url <verified-dcc-origin> --file <packet> --dry-run` previews locally without network.
2. `npm run triage:ingest -- --base-url <verified-dcc-origin> --file <packet> --verify` sends a rollback-only preflight. Verify the returned owner IDs and exact `source_ids`. Dry-run task IDs are provisional.
3. After release verification and only for an authorized sweep, run the same command without `--verify`. Expect `merged` or `duplicate` with the matching source IDs and task IDs. Reconcile an ambiguous response by replaying the same packet; if review freshness has expired, re-read the source without changing its identity. Source replay does not reset lifecycle or replace an edited draft.

Sweep Suite's day-state publisher and `reviewed_proposals.py` are separate producers. The former still publishes day state; the latter still submits Daily Brief suggestions. Neither is implicitly converted to sweep-created tasks. Use the on-demand handoff above for the pilot. Any future maintained Sweep Suite runner adopting this lane should explicitly emit the reviewed packet and call this publisher with the least-privileged capability; do not wire raw `triage.open_items`, repurpose Daily Brief proposals, or enable old recurring or reply send jobs. This release does not install a schedule or enable a producer in production.
