# Unified Research & Ideas

## Audit and architecture

Audited origin/main `6873359` in an isolated `.worktrees/research-ideas` checkout.
The original checkout remains untouched.

- `wishlist-store.js` already persists private Wishlists, criteria, options, assessments,
  vendor offers, dated offer history, research and canonical task links. Its revision
  envelopes and mutation receipts protect concurrent edits and retries.
- `wishlists.html` and `public/js/wishlists.js` already provide comparison sections.
  They remain available for every record. Existing Wishlist IDs and data remain intact.
- Tasks, projects, facets, saved views and dependencies use canonical blocks through
  `project-store.js`. Someday ideas are existing task records and are not reclassified.
- Task text lives in block properties. Private binary attachments use owner-scoped
  `task_attachments`, validated uploads, protected download routes and object storage.
  Research uses the existing Wishlist attachment parent, never a schedulable block.
- PostgreSQL boot DDL lives in `pg-schema.js`. Numbered migrations use the separate
  transactional runner. There is no new framework, dependency, infrastructure or auth path.
- Existing task search and library filters remain unchanged. The new paginated research
  search covers titles, metadata, structured Wishlist research, and research trail entries.
- `/mcp/dcc` uses OAuth consent and per-operation scope verification. New research
  read/write grants are independent. Task and project creation also require the matching
  write grant. Existing OAuth grants receive no new scopes automatically.
- DCC navigation is a responsive vanilla JavaScript application using shared CSS tokens.
  Research follows the existing standalone Wishlist page pattern and native dialogs.
- Railway auto-deploys main. Repository CI runs lint, Node tests, PostgreSQL checks and
  browser smoke. Ship It adds review registration, FIFO integration, exact-candidate QA,
  authoritative merge and production revision checks. No protection may be bypassed.

## Implementation plan

1. Reuse Wishlist storage; add optional typed record membership.
2. Add owner-checked relationships, append-only entries and revision snapshots.
3. Add title-only capture, views, filters, detail editing, comparisons and purchases.
4. Link canonical tasks/projects explicitly and support reverse navigation.
5. Expose shared services through authenticated HTTP and scoped MCP.
6. Exercise embroidery fixtures in an isolated PostgreSQL schema, without account seeding.
7. Validate migrations, existing Wishlists, permissions, replay and browser behavior.
8. Publish, review, integrate and verify deployment through the established workflow.

## Data model

`wishlists` remains the canonical record. `research_records` adds membership types:
idea, research, requirement, product. An absent membership remains a legacy Wishlist.
Extended metadata stays in the existing validated JSONB overview and uses its revision.
A requirement is a reusable purchase need; its candidate edges point to canonical products.
One product can serve several requirements without copying product attributes.

`research_links` has stable IDs, foreign keys, revision checks, reversible active state,
unique relationship pairs, and a database ownership trigger. Each edge targets either a
record or an existing task/project block. Related records resolve in both directions.
Per-link quantity and estimated unit cost can describe project requirements independently.

`research_entries` distinguishes original questions, evidence, findings, AI summaries,
recommendations, notes and decisions. Content is append-only. State changes are revision
checked. New conclusions may reference a superseded entry. `wishlist_revisions` retains
old and new overview/structured-record snapshots, entry states, and relationship actions.
Prices carry observation dates; actual purchase details are separate. No prices or sources
are fetched, inferred or fabricated by this feature.

`research_mutations` stores exact-envelope receipts for atomic replay of create, link,
append and task/project creation. Wishlist metadata edits keep existing mutation receipts.
All related writes, including task/project creation, commit or roll back together.

## Migration and rollback

`012_research_ideas.sql` creates five tables, indexes, RLS, and one ownership trigger.
It is reused verbatim by boot DDL and the numbered migration runner. It performs no
backfill, deletion, legacy reclassification or destructive schema migration.
Run twice to verify idempotency. The dry-run runner rolls back transactionally.

Rollback means redeploying the previous application revision and retaining the additive
schema and records. Old Wishlist readers continue using original rows and fields. New typed records may
appear as generic Wishlists until the forward application is restored.
Never drop the new tables during rollback. Subsequent forward deployment restores access.
A fresh production backup is optional under the repository release policy.

## Security and continuity

HTTP requires an established session and workspace owner, with same-origin write guards.
MCP requires explicit research scopes and never inherits service-token or dev fallbacks.
Task/project creation requires additional scopes. Research never automatically enters
Working Queue or receives a schedule. Optional revisit dates remain metadata.

The browser saves mutations into an owner-namespaced IndexedDB outbox before sending.
Retries reuse exact IDs. Server revision conflicts remain visible and retain pending edits;
users can inspect and discard a local edit. Account changes block pending synchronization.
Background retry follows online, visibility and heartbeat events. API data is not stored
in service-worker caches. Cached detail reads work while the page remains available.

## UI variants

Offline browser reopening still depends on DCC's application shell. This change adds
pending-edit durability and cached reads, without replacing DCC's application-wide shell.

`DEFAULT_LAYOUT` in `public/js/research.js` selects `cards`.
Real `list` and `notebook` variants use the same routes and behavior via `?layout=`.
Cards balance mobile capture and mixed record types. List favors density; notebook favors
long descriptions. No visual variant changes the data model.

Would you like a feature report of this plan?
