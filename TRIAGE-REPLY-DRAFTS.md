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

## Newly discovered finding plus draft (separate undeployed extension)

The same intake also accepts `packet.reply_findings`, mutually exclusive with `reply_drafts` and the legacy `items` packet. It uses the standard Triage task materializer and canonical createItineraryTask/createBlock with an explicit transaction client. The task is created with its unsent internal draft already in triageContext; no pending side file or second production call is required.

```json
{
  "dry_run": true,
  "packet": {
    "reply_findings": [{
      "source_id": "gmail:abc123:abc456",
      "source_ref": "https://mail.google.com/mail/u/0/#all/abc123",
      "title": "Review the verified business request",
      "reason": "Minimized rationale based on the current complete source and supporting research",
      "draft_preview": "Researched reply, unsent",
      "thread_id": "abc123",
      "received_at": "2026-11-23T17:00:00Z",
      "reviewed_at": "2026-11-23T17:10:00Z",
      "sensitivity": "ordinary_business"
    }]
  }
}
```

Replace the example IDs and timestamps with actual verified values. These nine fields are required and no other per-finding fields are accepted. One to ten findings; native Gmail thread/message or Slack dm/mention IDs with exact matching links. The verified thread_id is required: Gmail must match its native thread ID; Slack must carry the actual root timestamp, no later than the source message. The writer never guesses that a reply is its own thread root. Duplicate sources/conversation links in a batch are refused. Reviews must be timezone-qualified and at most one hour old; received_at must be a qualified source timestamp. Titles are bounded to 200 characters; rationale and draft to 1000 each. The declaration is a caller attestation, not server-side research or privacy classification. Both excluded legal Slack channels and Calendar/unknown sources remain refused.

The mode acquires source locks, checks existing Triage suppressions (including legacy Gmail thread cutoffs), reuses exact-source anchors including tombstones and rejects ambiguous/moved/handled/foreign-owner sources. Existing owner titles and drafts win; it does not move another queue's task into Triage. New tasks are private, date-free and use the existing canonical Triage classifier. No day-state, legacy cycle accounting or suppression rows are written by this mode. No Gmail/Slack send, native-draft or reaction adapter is invoked.

The task, draft and ordinary create operation commit together or all their rows roll back. Source identity, not the title, reviewed_at or packet nonce, determines reuse. Identical/concurrent replays converge on the same task without new operations or broadcasts. Contention with an older writer can still return a retriable database conflict rather than silently minting another task; retry the same source packet after reconciling its result. Existing unique-key and tombstone semantics are retained.

Rollback preflight returns prospective task IDs which need not survive rollback. Verify owner and source_ids; take durable task IDs only from the actual successful receipt. Postgres may allocate operation sequence values even during rolled-back preflight; no task/operation rows survive it. No production preflight or delivery has been performed for this extension.

Verify locally with `DCC_TEST_DATABASE_URL='postgresql://drakeshadwell@localhost/postgres?host=/tmp' node --test triage-reply-findings.test.js triage-reply-drafts.test.js`. The fixture uses actual public handlers, canonical task creation, operation logging, private lane classification and cookie-authenticated readback in its own disposable schema. New findings are synthetic, never posted to production or a source system. The original existing-task-only branch remains preserved at f019e946eb506a4e490dcf21cb4ebf9380301a70.
