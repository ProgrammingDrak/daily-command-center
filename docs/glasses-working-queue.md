# Working Queue on glasses

The existing `/glasses` and `/glasses.html` bookmarks now redirect to `/?device=glasses`. The shared DCC tab controller defaults to Working Queue; explicit `tab=schedule` links still open itinerary. Explicit legacy `task=` links retain the compact task page. Authentication, account binding, data and the email-code sign-in flow are unchanged.

The presentation adapter decorates the canonical Working Queue cards. Foreground stays first, remaining lanes stack vertically, and Up/Down move one visible card without changing queue order or work clocks. Enter opens canonical details. Selected cards expose Bring forward (or Send to background), Complete, and More. More reveals existing secondary actions. App tools contains secondary navigation, including itinerary. Completed stays collapsed by default and uses smaller cards when opened; its disclosure and task focus survive refreshes.

The same coordinator owns foreground transitions, confirmation, revisions, pending receipts, conflicts and retry. No new task model, mutation endpoint, credential, feature flag or migration is introduced. Shared-overlay inert transitions restore navigation after close. The existing pet viewport fix is retained.

## Reproduce on isolated fixtures

Use supported Node 20. Do not run against live localhost:8090 or production task data.

```
PORT=18449 DCC_WORKING_QUEUE_REVIEW=1 DCC_TEST_DATABASE_URL=<disposable-local-postgres> node scripts/ui-review-server.mjs
DCC_GLASSES_REVIEW_URL=http://127.0.0.1:18449 node scripts/verify-glasses-working-queue.mjs
```

The harness creates a unique synthetic schema. The regression refuses non-loopback servers and requires reviewOnly health. The review-only reset is exclusively for that fixture schema. There is no separate frontend build command; the app serves static Express assets.

Validation: repository tests (3,170 pass, 18 skip), lint (0 errors; existing warnings), new full-app glasses suite (11 groups), existing itinerary suite (19 groups), canonical Working Queue suite, and pet regression (22 layout scenarios). Viewports: 320×600, 375×812, 600×600 and 1440×1000, plus 200% zoom. All browser evidence uses synthetic tasks and desktop Chromium emulation. No physical Meta glasses or Android browser test is claimed. No live foreground, timer or task record was changed for QA.

## Release boundary

Prepared from deployed SHA `2ffa3fa23f2ff584e3aaecc36a9cc791e25a563f`. Ship the redirect, adapter, CSS and shared disclosure preservation together. Before release, reconcile current main and use the existing coordinated release lane and required independent reviews. The PR435 backup waiver is specific to PR435 and is not a general release waiver. Remote OAuth remains outside scope.

The user’s standing release instruction authorizes ship-it push, PR, merge and deploy after required tests, reviews and release checks. It does not waive required reviews or permit self-approval. The existing production URL is `https://daily-command-center-production-1d04.up.railway.app/glasses.html`. Verify the exact deployed SHA before reporting this change live. Local fixture URLs are not Android-accessible test links.
