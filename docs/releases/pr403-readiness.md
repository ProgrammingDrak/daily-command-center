# PR403 release preparation

Reconciled against main `ff51475900078edb7d0a69d85878012d8248fd84` on 2026-11-21.
The published source was `039aeeff1f3cb9f47667fb3a14384a332c9a14bc`.

## Scope and integration

Collaboration stays on canonical itinerary tasks and uses their existing completion checkbox. Shared outcomes never copy private task titles or notes automatically. People & sharing and Personal vault open through Utilities. Current Tasks views, Research & Ideas, shared DccLoginReturn, device authentication, public activity projections and every existing PostgreSQL suite remain intact.

The recovered rebase omitted published bounty safeguards. Restored the original precise guards and regressions from `b00c762`: legacy reward queues and transitions exclude collaboration offers; dismissed offers cannot be reapproved. Published delayed-seen draft preservation remains intact. Utilities now use the current navigation controller, maintain URL/history state, and emit transitions for the actual visible panel. No retired primary tab was restored.

## Validation

- Locked dependency installation: npm ci with the seven-day cutoff.
- Node 20.20.2 full suite with disposable localhost PostgreSQL 16: 3,641 passed, 7 skipped, zero failed.
- Dedicated PostgreSQL suites: 197 passed, zero skipped or failed.
- Full production schema initialized successfully on disposable local PostgreSQL.
- Lint: zero errors, 74 existing warnings.
- All three synthetic browser workflows pass: verify-commitments.mjs, verify-accountability-completion.mjs, verify-invite-link-and-details.mjs.
- Coverage includes owner/coach/manager roles, private projections, revocation, account switching, durable offline retry, paging, delayed acknowledgement draft/focus preservation, canonical completion, explicit Invite Link consent, interrupted onboarding acknowledgement, and widths 320/390/760/1024/1440.
- Five independent FULL review lanes completed: security, performance, correctness, test quality and consistency. Independent second-pass verification and PostgreSQL regressions cleared the restored bounty and navigation findings. Review size exceeds 1,000 changed lines but remains below the automated refusal limits.
- CI now runs the three browser workflows sequentially against its disposable PostgreSQL fixture. Exact published-head CI must be checked on PR403; local evidence does not substitute for it.

One local browser rerun encountered a pending-action timeout during bounty submission. A direct rerun passed; the complete sequential CI-style run and exact-head CI are the final browser evidence. No assertion was weakened or bypassed.

## Current release boundaries

Production health and Railway deployment metadata both identify `ff51475900078edb7d0a69d85878012d8248fd84`. Railway CLI authentication works. PR417 is merged, and the authoritative integration queue has no active entries. Historical freeze and invalid-CLI claims no longer establish a current blocker. Historical credential revocation cannot be established from an old security document; no credentials or security settings were changed.

Real Clerk provider verification remains outstanding. No authorized test identity was established in this session. Browser control reports the Mac locked and local browser access disabled. Synthetic Clerk callbacks do not clear this gate. Use an existing authorized test identity with an isolated local database; do not create accounts, credentials, grants or real social invitations.

Fresh production backups are optional under AGENTS.md and docs/releases/database-backup-policy.md. No backup is claimed. Additive schema review/acknowledgment, normal deployment guards and exact-SHA post-deployment verification still apply. Keep PR403 draft until the real-provider gate and release checks pass. No merge, deployment or production-data QA occurred.

## Local QA

Destination: http://127.0.0.1:8107/?tab=tasks&view=list

1. Tasks > Itinerary > collaboration: choose a separate shared outcome. Private notes stay private; complete through the existing task checkbox.
2. Settings and utilities > People & sharing > Invite Link: copy an expiring link. The recipient explicitly chooses Add.
3. Settings and utilities > Personal vault, then Tasks and browser Back: panels open correctly and Tasks retains view/Actual preferences.

The local server uses fictional identities and disposable fixture data. It never imports production environment configuration. QA card: test-results/pr403-release/qa-card.html.
