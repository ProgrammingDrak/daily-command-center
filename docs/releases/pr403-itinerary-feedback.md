# PR403: daily itinerary feedback

The owner shares one daily itinerary. Visitors discuss individual tasks through
the existing nested comment threads and send heart, clap, or celebration reactions.
The owner replies in the same threads. Existing task completion remains owner-controlled.

This refocus follows the owner's rejection of the accountability/coaching direction.
The final feature diff starts from main `ff51475900078edb7d0a69d85878012d8248fd84`.
The previous published PR head `dae5d1edc315c24efadf0265fec0555a1e56909e`, including
bounty safeguards and draft fixes, remains retained locally on
`codex/pr403-audit-20261121` and `codex/pr403-release-20261121`. This change does not
delete existing production records or alter the existing accountability APIs.

## Behavior and reuse

- Share Itinerary opens the existing DCC overlay controller with a public-task
  preview, daily link, copy control, and shared-day preview.
- Existing daily bearer links and contribution storage remain authoritative.
  No schema migration, new authentication path, or new account is required.
- Shared projections include only public tasks for the selected owner and day.
  Private task titles and notes remain excluded. Feedback cannot complete tasks.
- Task rows show comment counts and three reactions. The existing reply threads,
  branch controls, and journal photos remain available.
- Drafts retain text and reply target across polling, closing, reopening, and
  reloads within the same browser session. Names remain visitor-supplied labels.
- Stable operation identifiers prevent duplicate comments or reactions after a
  lost acknowledgement. Requests validate token, task, action, and exact intent.
- Reaction storage reuses the existing `like` contribution kind. Empty legacy
  reaction bodies remain hearts. Reaction counts do not establish verified identities.

## Verification

Locked dependencies installed with the seven-day cutoff; lockfile unchanged.
Disposable localhost PostgreSQL 16 only; no production QA data or credentials.

- Full suite: 3,624 passed, seven skipped, zero failed.
- PostgreSQL suite: 182 passed, zero skipped or failed. Every main suite remains,
  and itinerary-sharing-postgres.test.js is now included explicitly.
- Lint: zero errors, 74 existing warnings.
- Synthetic browser workflow covers owner sharing, private-task exclusion,
  guest comments, nested replies, owner replies, separate reaction counts,
  incoming polling updates, reply drafts after reload, lost acknowledgements,
  delayed responses after closing/reopening, and sharing during a pending Post.
- Responsive screenshots: 320, 390, 760, 1024, and 1440 pixels.
- The browser workflow also passes with a UTC server and New York browser.
  Its bootstrap date must match the fixture date, including after UTC midnight.
- FULL security, performance, correctness, test-quality, and consistency review.
  Confirmed findings were independently verified and fixed. Restoring each of
  four bugs makes its regression fail: reaction counts, reopened draft clearing,
  held database connections during retry snapshots, and sharing during pending Post.
- CI runs the same PostgreSQL and browser checks. Exact published-head CI remains
  a separate assertion and must be read from PR403 after publication.

Local evidence, screenshots, mutation logs, and QA card live under
`test-results/itinerary-feedback/` in the review checkout.

## Phone QA

Private Tailscale destination:
https://macbook-pro.nuthatch-emperor.ts.net:8444/

Shared visitor view: `/shared-itinerary/403403403403403403403403403403403403403403403403`

Owner view: `/?tab=tasks&view=list`

1. Open a task comment button, then Reply. The existing nested thread opens.
2. Tap a heart, clap, or celebration. Only that reaction count increases.
3. In the owner view, choose Share Itinerary. Only public tasks appear in its preview.
4. Write a draft, close the thread, then reopen it. Text and reply target remain.

The preview uses fictional accounts and isolated data. It does not test a real
Clerk provider session or prove physical-phone acceptance. Local Chrome control
is disabled in Work settings; the phone link is the interactive handoff.

Presentation options share one named constant: `FEEDBACK_PRESENTATION`.
`inline` is selected; `compact` and `footer` have real screenshot variants.

## Release boundaries

Keep PR403 draft during phone QA. The previously required real Clerk provider
verification remains unfulfilled; no replacement accounts, credentials, grants,
security settings, or real invitations were created. The refocused feature does
not change provider authentication.

The inherited lockfile's nine npm-audit package entries remain unremediated.
Pre-authentication body-parser and authenticated vault multipart exposure still
need security disposition before deployment. These are unchanged main dependencies.

Fresh production backups remain optional under current DCC policy. No backup,
merge, production deployment, or production-data QA is claimed.
