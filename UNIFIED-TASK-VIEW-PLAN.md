# Unified task view — local implementation plan

Base: a40a9e1cdb2b6186354f21f01c193d296a6bf22b, branch feat/unified-task-view. PR421 is unchanged. No publication/deployment authorization for this scope.

## Evidence and capability matrix
DCC capabilities.js, access-store.js and routes/access.js separate public tier entitlements from directional per-owner grants. Current delegated rights: view_itinerary (viewer+) and adjust_points (coach+). Manager is NOT task-edit authority. Public-share social rights are existing guest reactions/comments/reward offers, signed-in bounty offers; sponsorships await owner approval. Public pages do not complete tasks. Existing public projections redact private task information.

Line Learner reference: local origin/master 2538c66d96fefa0e8ff52acf424b80bec7dc6f1e, server/production-permissions.js (explicit capabilities, removals override grants), server/production-view-as.js and src/lib/components/ViewAsBar.svelte (visible role context; previews read-only). Roles QA da0ee6f791178c42f563e964869c97b30ea90606 confirms these patterns. This is source inspection, not a production deployment claim.

| Principal | Existing read | New task actions by default | Existing social behavior |
|---|---|---|---|
| public link | redacted shared projection | view only | preserve reactions/comments/reward offers; bounty sign-in |
| viewer/commenter | granted itinerary | view only | no inferred rights |
| coach/manager | granted itinerary, points adjustment | view only | no inferred task-edit rights |
| owner | own itinerary | execute | self-bounty; add reaction/reward entry points |

Owner-managed per-action modes: view, suggest, execute for completion, title editing, scheduling, Waiting delegation, reactions, bounties and rewards. Existing grants default to no new authority. No actual live grants changed. Unknown capabilities/modes fail closed. Blocking and revocation veto access. Suggestions are separate records, owner approval/rejection only, with stale-state detection and idempotent action identity. Public token access must never expand task visibility through a grant or owner identity.

## Steps
1. Shared active stacked-row renderer for owner/public/granted views; same completed/open skeleton, compact capability context, no owner-global handlers in another user's context.
2. Explicit granular owner-managed modes and backend checks, authenticated scoped action namespace. Preserve existing owner APIs and public entitlements.
3. Reuse canonical completion, reschedule and Waiting transitions; field-only title edits; durable suggestion approval/rejection and audit attribution.
4. Owner social/self-incentive controls; retain existing bounty/reward validation and approval rules.
5. Real PostgreSQL/PGlite permission and concurrency tests; direct endpoint abuse, stale/duplicate approvals, completed/open states; isolated desktop/mobile synthetic QA and full regression/lint; adversarial review.

No private data added to public projections, no live task edits, no credential changes, no push/merge/deploy. Any unfinished behavior will be reported explicitly.

## Implemented and validated — 2026-10-23

Owner, public-share and delegated-day task rows now use `renderItineraryListRow`, including completed rows. Page shells remain contextual; task structure and task-action policy are shared. Public task redaction remains in its existing projection. Public comments/reward composers keep their draft/focus/live-refresh behavior. Compact action menus expose only granted task operations; existing public social entitlements and coach points adjustments retain their separate established gates.

The owner can configure View/Suggest/Execute per action from People & sharing → Access → Task actions. Existing grants default to View for these new operations. Suggestions use a separate durable receipt and never change a task before approval. Approval rejects stale task snapshots and revoked authority. Writes recheck permissions within their mutation transaction, holding the grant while applying the action. Blocking uses the same pair lock. Unknown execution outcomes remain `executing` and cannot automatically run again; operational verification is required before resolving them.

Completion, scheduling and Waiting conversion reuse canonical handlers. Title edits preserve unrelated properties and synchronize linked Waiting labels. Owner self-reactions, daily bounties and rewards use the same action entry point. Reward creation and activation share one transaction. Reactions use the existing `todo_task_reactions` ledger across surfaces.

### Compatibility

- `access_grants.task_permissions` defaults to `{}`. No existing user receives new authority.
- `task_action_requests` adds command/suggestion receipts and outcome history.
- Existing reaction rows are preserved. `share_id` becomes nullable so an owner can react without creating a public share; canonical task identity and distinct actor counts connect the surfaces. No destructive migration or real-user data change occurred.
- This branch depends on PR421 head `a40a9e1cdb2b6186354f21f01c193d296a6bf22b`. PR421 itself is unchanged.

### Validation and review

- Full regression with real disposable PostgreSQL: 3,380 passed, 3 skipped, 0 failed (3,383 tests). Same-key concurrent submits, permission downgrade during mutation, cross-user/direct API denial, stale snapshots, rejection/approval, known failure and uncertain scheduling outcomes are covered.
- Desktop/mobile browser: 24 task-action groups at 1280/390/320 widths; 7 existing composer groups; 2 delegated-view groups at 1280/390, preserving coach points and completed state. All passed, 33 groups total.
- ESLint: 0 errors, 69 pre-existing warnings. Syntax checks and `git diff --check` pass. Repository has no separate build script.
- Five-lane pre-review and independent verification completed. Fixed refreshed-permission enforcement, self-reward sponsor identity, unreachable pending suggestions, reaction-store duplication, permission audit omission, legacy completion projection and uncertain scheduling classification. Final verifier reported no remaining blocking candidates.
- One maximum-concurrency run returned an empty HTTP response in unchanged `waiting-routes.test.js`; isolated rerun passed 48/48 and full bounded-concurrency rerun passed 3,380/3 skipped. Both logs are retained.
- Diff exceeds 1,000 lines including new tests; splitting the future PR is recommended by pre-review, not a blocking gate. Review depth is limited by size.

### Release boundary

Local implementation only. No push, PR update, merge, deployment, credential change, live access grant or production task mutation. Existing PR421/security holds remain. A new release authorization and exact-head remote CI/review are required before publishing this scope. Physical iOS/WebKit and production behavior are not verified; browser checks used isolated headless Chrome and synthetic records.
