# Shared task behavior

Task surfaces share behavior, not only markup.

## Ownership

- `DCC.TaskModel.projectCollection` projects rows and resolves relationships together.
- `normalizeCollection` supports existing event collections without changing their IDs unnecessarily.
- Block IDs are canonical. Legacy aliases resolve within a date only when unambiguous.
- `withAncestorContext` retains parents through view filters. Context rows are not actionable work.
- `actionTargets` resolves mutation membership. Completion traverses the subtask edge; deletion includes both edges.
- Missing parents retain an explicit relationship warning. Ambiguous relationships block mutations.
- Distinct canonical records sharing a legacy alias remain visible and flagged. They are never silently merged.
- `DCC.TaskActions` owns shared pending projections, operation deduplication, and acknowledgement ordering.
- `renderItineraryListRow` and `renderItineraryCard` bind every copy to the same action state.
- Legacy Scheduled, suggestion, backlog, and compact cards use the same `DCC.TaskRows.bind` adapter.

## Integrating a surface

1. Project the complete row collection before filtering or sorting for display.
2. Register its collection with `TaskActions.registerPool` when it contains rows unavailable elsewhere.
3. Render using the shared row/card component. Supply presentation callbacks only.
4. Run task actions through `TaskActions.run`. Keep domain rules in the existing writer.
5. Never publish an optimistic action before its durable receipt commits.
6. Report receipts with `captureWrite` or `capture`, then `finish` on acknowledgement or permanent rejection.
7. Take `readToken` before authoritative reads, then reconcile returned rows. Reads started before acknowledgement cannot release its projection.

## Persistence adapters

BlockStore keeps its existing account-scoped WAL. Working Queue keeps its coordinator completion outbox.
Glasses keeps its guarded retry receipt. These are transport adapters, not independent UI state machines.
The controller does not introduce another mutation queue or replay uncertain operations itself.
Receipt recovery restores pending projections after reload. Rejected or cancelled receipts release their projections.
Newer task intents override older ones without allowing stale failures to roll them back.

Queue notes, guided outcomes, recurrence, revision guards, rewards, and delete/undo sequencing remain with their existing domain writers.
Undo publishes its restore intent after the existing recovery snapshot commits, including while deletion is in flight.
Carryover Undo uses canonical identifiers throughout its snapshot and refreshes all task readers after restoration.
The open-task endpoint returns bounded candidates plus `ancestors` and `actionRows`.
Ancestor context and out-of-window descendants do not increase actionable counts.
No production records are rewritten by this change.

## Regression gates

Run `node --test task-actions.test.js task-actions-contract.test.js` and the existing hierarchy, completion, carryover, queue, and Glasses tests.
The contract guard mutation-checks missing lifecycle hooks and private alias resolvers.
Browser verification must delay writes two seconds, check all displayed copies before acknowledgement, and verify rollback and immediate Undo.
