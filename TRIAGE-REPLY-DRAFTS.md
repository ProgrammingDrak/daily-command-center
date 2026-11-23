# Reviewed replies on existing private Triage tasks (undeployed)

This opt-in mode reuses POST /api/dcc/triage-check/ingest, the existing strict owner resolver and service/session authorization. It changes no read permissions or credentials. The legacy items intake remains unchanged. No task is created, promoted, moved, sent, or posted to a source system.

```json
{
  "dry_run": true,
  "packet": {
    "reply_drafts": [{
      "task_id": "existing durable block ID",
      "triage_id": "that task's existing triageId",
      "source_ref": "that task's exact existing Gmail or Slack source URL",
      "draft_preview": "Researched plain-text response, unsent"
    }]
  }
}
```

One to ten updates; the four per-item fields are required and no others are admitted. Preview length is 1–1000 JavaScript string units; multiline text is allowed, control characters are rejected. Slack sources are restricted to the established workspace and exclude both legal channels. Gmail references use the established #all thread form. Calendars and other source types are refused.

Callers must first read the actual open task, latest full source thread, relevant sent replies and accessible supporting material. The server binds the supplied triage identity and permalink to the task already stored for both the resolved user and workspace; it does not independently access Slack/Gmail or certify research quality. Source provenance must already have been admitted by the existing workflow. Do not substitute a guessed task, use another queue, or treat token configuration as an ownership receipt.

The transaction locks only requested workspace task rows, validates the entire batch, and fills the existing triageContext draft fields only when no draft exists. It requires a private, date-free, nondeleted open Triage task. Titles, priorities, notes, source context and placement survive unchanged. A different existing draft (native or internal) returns 409; this endpoint cannot overwrite it. A missing, deleted or foreign task returns 404. Identical replay returns duplicate without updating timestamps, day-state, mirrors, audit/cycle counters or broadcasts. Concurrent identical updates serialize to one merge and one duplicate.

Use dry_run:true first. It executes the same validation/write transaction then rolls back and sends no broadcast. Check returned owner and requested task_ids. Only an authorized caller may then omit dry_run or set false. Verify persisted draft text through the existing authenticated task read and Triage controls; retry the same packet and expect duplicate. Existing read restrictions remain: the legacy service bearer does not grant the broad task read needed to discover these IDs. No production delivery is authorized by this document, and this branch is not deployed.

The existing TaskModel and Triage copy/review controls render the stored context. Copy prefers the durable task's draft over a stale raw day-state item. The response remains text, never HTML inserted into the page. Opening/copying via user controls does not send a message.

## Local verification

Run `DCC_TEST_DATABASE_URL='postgresql://drakeshadwell@localhost/postgres?host=/tmp' node --test triage-reply-drafts.test.js`. It uses a uniquely named disposable local schema and drops only that schema. It mounts the actual intake and block read routes with a test-only session fixture, uses the real Postgres store, and exercises the existing TaskModel/Triage functions. No production server, data, credentials or external messaging adapters participate.

The old generic triage-check intake's replay counters are intentionally unchanged. The new reply_drafts mode has true no-op retries. This is a same-task attachment path, not a new researched-finding collector or a repair for all historical intake behavior.
