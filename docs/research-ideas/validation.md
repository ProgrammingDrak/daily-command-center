# Validation and release notes

## Completed locally

- Full Node suite: 3,433 passed, zero failed, 54 environment-dependent skips.
- Dedicated PostgreSQL suite: 181 passed, zero failed, zero skips.
- PostgreSQL research fixture covers the complete embroidery example using synthetic
  products and prices in an isolated test schema. Nothing seeded into the real account.
- Existing Wishlist comparison, attachment, conversion and MCP regressions pass.
- OAuth HTTP calls and UI endpoints resolve the same records. Read-only, write-only,
  missing task/project grants, workspace spoofing and unrelated owners are exercised.
- Concurrent edits reject stale revisions. Mutation replay remains exact-envelope bound.
- Injected receipt failure rolls back task creation, links and history together.
- Migration runner: dry-run rollback, apply and forced reapplication all pass.
  Repeat DDL leaves existing Wishlist IDs and payloads unchanged.
- Browser acceptance covers phone capture, reload, Markdown sanitization, question
  resolution, existing links, unlink/relink, two-product comparisons, selected-item
  purchase task creation, owned metadata, private files, archive/restore and history.
- Browser recovery checks preserve a failed write through reload and automatically
  retry through the online event. Invalid input can be corrected without queue blockage.
- Nine responsive combinations pass: cards/list/notebook at 375/768/1280 pixels.
- Mutation checks detect removed ownership and MCP scope enforcement. Removing both
  independent stale-write protections also fails the concurrent-edit assertion.
  The revision guard and unique revision-history constraint independently prevent loss.

## Review

FULL local review covered security, correctness, performance, tests and consistency.
Verified findings were fixed, including account-switch cache ownership, legacy grant
isolation, comparison request fan-out, rejected-request recovery, inactive-edge relinking,
CI integration and deleted-project promotion. No verified blocker remains.

The repository configuration enables the in-host pre-review. Claude CLI review is not
configured. Slack lifecycle posts, DMs and feature reports are disabled by configuration.
No messages were sent. No human reviewer is configured or requested.

## Release strategy

PR #513 retains one reviewed feature branch. The legacy npm ship helper was inspected
with --dry: it creates a second PR and merges immediately. The guarded Ship It workflow
owns publication, review, FIFO integration and one exact-head merge instead.
No rules, workflows, checks or protections are weakened.

The browser acceptance runner is wired into existing CI smoke, using a separate localhost
fixture schema. The existing PostgreSQL test command now includes research and Wishlist
coverage. CI validation and production checks remain separate assertions.

Production must serve the authoritative merge SHA before release completion. Confirm
Research routes, authenticated records and reload behavior where an established session
is available. Report any missing authenticated production proof explicitly.

## Limits

- No external product lookup, fabricated evidence, recurring idea tasks, or automatic
  Working Queue insertion is introduced.
- Revisit dates and last-reviewed metadata are available; automated monthly resurfacing
  remains future work.
- Detail views cap inline trail entries at 200. Paginated activity history retains the
  complete trail. Relationship details are bounded at 200 records and 200 block links.
- Cached reads and a durable pending-edit outbox work in an open application shell.
  Complete offline browser reopening remains dependent on DCC's broader shell.
- Conflicting edits remain preserved for inspection and deliberate resolution.
- MCP clients need explicit Research consent and a refreshed action catalog. Creating
  work additionally needs the corresponding task/project permission.
