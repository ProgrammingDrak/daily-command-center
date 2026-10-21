# Admin feedback inbox

## Original routing diagnosis

Feedback was already persisted in Postgres: the launcher/Utilities feedback form used `public/js/feedback.js` to POST message and existing page context to `/api/feedback`, which inserted `feedback_messages` with session user/workspace, user agent and server time. The sender saw an in-app confirmation; there was no email, Slack or other external notification.

`/api/admin/activity` already read the latest feedback across workspaces behind the existing admin allowlist. `/admin` already rendered those records through `DCC.collection`, but the UI fetched only 100 messages, omitted author identity, and inherited non-wrapping table cells. There was no paging for older submissions. In addition, static-file serving appeared before the `/admin` route guard, exposing the admin shell to ordinary authenticated users; the feedback data API itself remained guarded. The task addresses these readability, browsing and page-access gaps rather than introducing a new feedback destination or repairing a missing database write.


The Utilities menu now exposes **Feedback inbox** to sessions authorized by the existing site-admin username allowlist. The mobile menu uses the same server-provided admin flag. `/admin` and `/admin.html` enforce that allowlist before static-file serving. Workspace owners and delegated roles do not gain site-admin access.

Feedback still writes to `feedback_messages` through the existing authenticated `POST /api/feedback`. There is no schema migration, record rewrite, external notification, account change, or new sensitive-data collection. The inbox reads all existing feedback, including records with no matching author, through `GET /api/admin/feedback`.

The inbox displays complete multiline message text, existing author display name/username, timestamp, page path, status, workspace and record ID. It defaults to newest first and reuses the app's collection search/filter/sort controls. Fifty records load initially; **Load older feedback** uses a timestamp/ID cursor that preserves Postgres microseconds and tied timestamps. Search and filters apply to loaded records, as stated on the page. **Refresh** reloads the newest page. Total feedback and latest submission refer to the entire stored inbox.

A failed refresh preserves loaded messages. Initial failures, session expiry, permission denial and timeouts have readable messages. Login activity loads independently. Submission failures retain the draft; repeated keyboard submissions while Send is disabled do not create duplicate requests. Inbox responses, the admin shell and legacy admin activity are marked `no-store`.

## Initial validation on 2026-10-13

- Existing site-admin account mapping verified with a read-only transaction. No account or access settings changed.
- `npm test`: 2,723 passed, 3 skipped, 0 failed under the already-installed supported Node 20.20.2 runtime (`/opt/homebrew/Cellar/node@20/20.20.2/bin/node`). The earlier Node 24 run also passed. No tooling was installed.
- `npm run lint`: 0 errors, 67 existing warnings under Node 20.20.2 as well as the earlier Node 24 run. Focused lint of added modules/tests/harness: clean.
- `node --check`: changed server/browser scripts passed. No TypeScript/type-check script is defined in this JavaScript repository.
- Focused route/client tests cover admin/non-admin/anonymous access, both admin page paths, submission delivery, exact text/context, paging, input validation, database failures, author fallback, independent login loading, refresh retention, admin navigation and duplicate submission prevention.
- Five mutation checks caught removal of the API admin guard, page admin guard, refresh retention guard, admin navigation flag and disabled-send guard. Committed production files were restored after each check.
- Chrome QA against the real feedback router and an isolated local Postgres schema: ordinary-account submission to admin inbox, denied ordinary-account admin page, exact multiline/literal-markup rendering, loading all 55 older fixtures, search, empty inbox, read failure with retained rows, and save failure with retained draft. No browser console errors in normal/empty flows.
- At 320 CSS pixels, page width remained 320; message text wraps and table overflow stays within a named keyboard-focusable scroll region. Desktop layout also inspected. Explicit 200% browser zoom remains unverified: the tab shortcut did not change zoom, the browser API exposes viewport control only, and native Chrome interactions were interrupted by active user browsing. Native attempts were stopped to avoid affecting unrelated tabs.

All feedback used for flow/SQL/browser testing was synthetic. Live user feedback was not tested or modified.

## Local QA harness

With a local Postgres URL in `DATABASE_URL` or `DCC_FEEDBACK_QA_DATABASE_URL`:

```sh
node scripts/feedback-review-server.js
```

The harness refuses production mode and non-loopback database hosts. It binds only to `127.0.0.1:8117` (override with `DCC_FEEDBACK_QA_PORT`), creates its own unique Postgres schema and synthetic users/feedback, and drops that schema on SIGINT/SIGTERM. It does not authenticate real accounts or write application tables. Browse `/qa/session/admin` or `/qa/session/member`. `POST /qa/failure/read`, `/save`, `/empty`, `/activity` and `/none` select synthetic failure states.

## Release gate

The feedback change is isolated on `codex/admin-feedback-inbox`. Publication requires user authorization under the workspace startup contract; the `/ship-it` workflow then requires current local review, CI, release evidence, and verified production deployment. Existing review policy remains authoritative.

## Reconciled readiness on 2026-10-21

Reconciled with main `d6e86e12d4013366364eeb8c435a694de03b921d`. The adversarial review found an encoded admin-page path bypass; decoded, normalized paths now pass through the same allowlist before static serving. Canonical, encoded, normalized-dot, double-slash, uppercase, trailing-slash and malformed paths were independently checked with synthetic identities. The feedback API was already protected.

- Node 20: 3,107 tests passed, 11 skipped, 0 failures; lint has 0 errors and 70 existing warnings. Real collection rendering now has regression coverage for ordering, column order, escaped multiline content and empty updates.
- Actual Chrome page zoom is verified at 200% through Appearance settings in a newly isolated profile: outer width stayed 1280, CSS viewport changed from 1280 to 640, DPR changed from 2 to 4, visualViewport scale stayed 1. No existing Chrome window or tab inventory was used.
- Synthetic local Postgres QA passed at 200%: all 55 fixtures, multiline/literal text, keyboard-focusable table scrolling, read-failure row retention, empty state, 4,000-character member submission, save-failure draft retention and ordinary-member denial. A separate 320px layout check passed with no document overflow. No page errors.
- The previous zoom blocker is resolved. No merge, deployment or live feedback mutation has occurred. The separate licensing PR411 still follows this feature's merge and verified deployment.
