# Native background sitrep verification

This review concerns PR #457, based on `87cf99222e17e92ad6f93d8933dc2cd8880ec348`.
Events remain default-off. This work does not approve the PR, merge it, deploy it,
configure live credentials, grant scopes or activate a subscription.

## Independent review findings

Five read-only lanes reviewed security, correctness, performance, tests and
consistency. Separate read-only verifiers judged candidate findings before fixes.

- Fixed quota exhaustion: inactive historical subscriptions release capacity;
  active refresh retains its slot and inactive reactivation cannot exceed the cap.
- Reused the existing versioned `lib/secret-box.js` encryption helper, retaining
  the separate event encryption key. No live event ciphertext requires migration.
- Strengthened the default-off test with valid encryption configuration, explicit
  subscription refusal, no callback verification/storage, and an absent-flag case.
- Added deterministic DNS/transfer timeout and response-size boundary tests,
  including request/response destruction and timer cleanup.
- Avoided full canonical queue projections for idle future/absent reminders,
  acknowledged or terminal generations, and pending retry backoff. Every actual
  outbound attempt still loads a fresh canonical projection under the account lock;
  legacy queue adoption retains that path.
- Retained the documented bounded lock-through-network design. Independent
  verification dismissed a proposed lease refactor as a change to the intentional
  cancellation/revocation serialization guarantee. The callback timeout can delay
  interactive operations for the same account; it remains a deployment consideration.

The PR exceeds 1,000 changed lines, predominantly synthetic verification and
runbooks. Splitting is a nonblocking review-size suggestion; the implementation
and its guard tests remain together. The repository's local-reviewer configuration
selects the in-host pre-review. The Claude peer CLI is not enabled for this repo.

## Guided-context failure investigation

An extended full-suite repeat failed the unchanged guided test
`immutable briefing survives later context edits and stale source prevents start`.
The failure is an existing same-millisecond version collision:

1. `db.js` creates/updates `blocks.updated_at` using `new Date().toISOString()`.
2. `guided-store.js` exposes that timestamp as `contextVersion` and compares it
   before start/resume. There is no independent content revision in that check.
3. A synthetic create and title edit under the same JavaScript millisecond leave
   `contextVersion` equal, so the stale start is accepted instead of rejected.

A standalone synthetic harness froze only its subprocess's JavaScript clock for
the create/edit sequence, used the real stores and isolated PostgreSQL schemas,
and reproduced this behavior on both unmodified base and the feature. The relevant
`guided-store.js` and `db.js` file hashes match between checkouts. No event worker
or event subscription was involved. Earlier 15 ordinary targeted baseline runs
passed because they did not reliably hit that schedule. No guided production code
or test was changed by this PR.

Local evidence for this session is in `/tmp/dcc-guided-same-ms.cjs`,
`/tmp/dcc-guided-same-ms-base.log` and `/tmp/dcc-guided-same-ms-feature.log`.
This establishes the existing source of the intermittent extended-suite failure;
it does not claim that the underlying guided-context issue has been repaired.

## Disabled rollout versus activation

Ordinary release checks can verify deployment with the event flag absent/false.
Exact candidate CI and local evidence must match the final PR head. No integration
lane is acquired by this verification-only follow-up. Configured GitHub reviewers
and feature broadcasts are `none`; repository protection and rulesets observed
during review impose no required approval. No GitHub approval is submitted.

The schema change still triggers DCC's database-risk guardrail. An owner-reviewed
database-risk acknowledgment is required for a future release, even though these
are additive empty private tables. A fresh backup is optional under DCC policy.
Merge/deploy are explicitly outside this follow-up. The production guardrail and
exact-deploy canary cannot be marked passed before an authorized release.

Activation is separately gated on specific approval for the Railway encryption
key and event flag, `dcc.read dcc.events` consent, plugin rescan, task-specific
subscription storage/activation, and an actual subscribed Griffula wake-up and
evidence-based reply. See [the activation runbook](background-sitrep.md).
